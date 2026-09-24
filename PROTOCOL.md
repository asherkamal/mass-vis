# mass-viz protocol (v1)

A run is a sequence of newline-delimited JSON (NDJSON) events, one JSON object per
line, sent over WebSocket or HTTP POST for live viewing and/or appended to a
`.ndjson` file for recording/replay. The same event stream drives all of these.

For manual testing or a language with no convenient WebSocket client, skip
the wire format entirely and `POST` events to `http://localhost:8080/event`
as JSON - a single event object, or a JSON array of events applied in
order:

```bash
curl -X POST http://localhost:8080/event -H "Content-Type: application/json" \
  -d '{"v":1,"runId":"demo","type":"init","mode":"grid","dims":[3,3],"runName":"Demo"}'
```

This goes through the exact same state/recording/broadcast path as a
WebSocket producer, so a run built entirely from `curl` calls looks
identical to a live simulation to every viewer - useful for testing the
server and viewer without needing a real MASS build at all.

Every event is a flat JSON object carrying a common envelope plus type-specific
fields:

```
{ "v": 1, "runId": "<string>", "type": "<event type>", "t": <ms since epoch>, "step": <int, optional>, ... }
```

- `v` — protocol version. Always `1` for this document.
- `runId` — identifies which run this event belongs to. A server may host multiple
  concurrent/past runs; clients pick one to view.
- `type` — one of the event types below.
- `t` — wall-clock timestamp in milliseconds, set by the emitter.
- `step` — optional simulation step/tick number, when the emitter has one.

Producers should emit one `init` event first, then any number of structural/state
events, interleaved with `step` markers at the end of each simulation tick so a
viewer can pace playback.

## Event types

### `init` (required, first event of a run)

```json
{ "type": "init", "mode": "grid", "dims": [64, 64], "source": "mass-java", "runName": "heat2d-demo" }
```

- `mode` — `"grid"` (2D spatial lattice of Places, rendered top-down) or `"graph"`
  (arbitrary graph of Places/Vertices). Selects which renderer the viewer uses.
- `dims` — grid mode only, `[width, height]`. (A third depth element is
  accepted on the wire but ignored by the current viewer, which only renders
  2D grids - see `../server/public/src/gridRenderer.js`.)
- `source` — free-form string identifying the emitting backend, e.g. `"mass-java"`,
  `"mass-cpp"`, `"mass-cuda"`.
- `runName` — human-readable label shown in the viewer.

### `place` (grid mode, sparse updates)

One Place's scalar value, addressed by its grid index. May be sent individually or
batched as an array under `places`. Use this for **sparse** updates - only the
cells that actually changed this step.

```json
{ "type": "place", "index": [3, 7], "value": 42.1 }
{ "type": "place", "places": [ { "index": [0,0], "value": 1.0 }, { "index": [0,1], "value": 2.0 } ] }
```

`index` is `[x, y]`, matching `dims` from `init`. `value` is a number mapped
to color via the viewer's color scale (min/max auto-tracked from observed
values, unless overridden — see `place_range` below).

### `place_grid` (grid mode, dense/full-grid updates - preferred for a full snapshot every step)

**Prefer this over batched `place` whenever every cell is being reported**, e.g.
a temperature field that evolves every tick. `place`'s batched form repeats a
`[x,y]` index per cell (~30 bytes of JSON overhead per cell); `place_grid` sends
one flat array with no per-cell index at all, cutting a dense full-grid update to
roughly a fifth of the size. This was a measured finding, not a guess - see
`benchmark/RESULTS.md`'s Track B.

```json
{ "type": "place_grid", "values": [1.0, 2.0, 3.0, "..."] }
```

`values[i]` corresponds to grid cell `[x, y]` where `i = y * width + x` (row-major,
x fastest-varying - `width`/`height` come from `dims` in the run's `init` event).
The array must have exactly `width * height` entries.

### `place_range` (grid or graph mode, optional)

Explicit color-scale bounds, if the emitter knows them up front (avoids the
viewer's legend jumping around as it discovers min/max from data).

```json
{ "type": "place_range", "min": 0, "max": 100 }
```

### `vertex` (graph mode, structural)

Declares one node of the graph and its adjacency. Sent once per vertex, normally
right after `init`, before any `agent_*` events reference it.

```json
{ "type": "vertex", "id": "v3", "name": "intersection-3", "neighbors": ["v1","v7"], "weights": [1.0, 2.5], "position": [10, 0, -4] }
```

- `id` — stable string/number identifier, referenced by `agent_*` events' `at`/`to`.
- `neighbors` — ids of adjacent vertices (edges are implied; the viewer dedupes
  reciprocal pairs when drawing lines).
- `weights` — optional, parallel array to `neighbors`.
- `position` — optional explicit `[x,y,z]`; if omitted the viewer places the vertex
  on a sphere sized to the vertex count.

### `place_value` (graph mode, optional scalar overlay)

Same purpose as `place` but addressed by vertex `id` instead of a grid index, for
graph-mode apps that also want a Place attribute (e.g. debug data) shown as color.

```json
{ "type": "place_value", "id": "v3", "value": 7 }
```

### `agent_spawn`

```json
{ "type": "agent_spawn", "id": "a12", "at": [3,7], "color": 16776960, "shape": "sphere" }
{ "type": "agent_spawn", "id": "a12", "at": "v3" }
```

`at` is a grid `index` (grid mode) or a vertex `id` (graph mode). `color` is an
optional 24-bit RGB int (default yellow). `shape` is `"sphere"|"cube"|"cone"`
(graph mode only; grid-mode agents are always rendered as small markers on top of
their cell).

### `agent_move`

```json
{ "type": "agent_move", "id": "a12", "to": [4,7], "speed": 1.0 }
{ "type": "agent_move", "id": "a12", "to": "v7", "speed": 1.0 }
```

The viewer animates a smooth interpolation from the agent's current position to
`to` over roughly one playback frame interval, scaled by `speed`.

### `agent_remove`

```json
{ "type": "agent_remove", "id": "a12" }
```

### `step`

Marks the end of one simulation tick. Drives the viewer's play/pause/scrub timeline
in replay mode (each `step` is one scrubbable unit) and is used in live mode purely
as a progress readout.

```json
{ "type": "step", "step": 42 }
```

**Initial state**: a producer that reports the model's starting state (before step 0
has run) ends it with `{"type":"step","step":-1}`. Without that marker the initial
events sit before the first `step` and are bundled into the first scrubbable frame,
so seeking to it shows the state *after* step 0's changes and the true starting state
is never seen. Each `step` event, including this one, is one replay frame.

## Non-finite numbers

`NaN` and `Infinity` are not valid JSON. Send `null` for any number that is not
finite (a diverged simulation, an unset debug value); the viewer skips it and keeps
the cell's last known value. The server also tolerates bare `NaN`/`Infinity` tokens
on input by turning them into `null`, but producers should not rely on that.

## Optional information fields (graph mode)

These carry the information the viewer's inspector, grouping and search use. All are
optional and ignored by older viewers.

- `vertex`: `label` (display name; `name` is accepted as a synonym), `group` (string or
  number - vertices sharing a group get the same color, e.g. a community), `attrs` (flat
  object of scalar values shown in the inspector, e.g. `{"followers": 120}`).
- `agent_spawn`: `name` and `attrs`, as above.
- `agent_update` - change an existing agent's `color`, `name` and/or merge `attrs`
  without respawning it:

```json
{ "type": "agent_update", "id": "a12", "attrs": { "state": "infected" }, "color": 15158332 }
```

- `agent_move.speed` scales the move animation (2 = twice as fast; default 1).
- Graph mode addresses Places by vertex id (`place_value`); the sparse grid `place`
  event is ignored in graph mode.

## Server-side semantics (not part of the wire format, but relied upon by producers)

- The server keeps one authoritative in-memory `RunState` per `runId`, built by
  applying every event to it in order (tracking `init`, current vertices/grid
  bounds, current place values, current agents and their positions).
- A newly-connecting client immediately receives a single `snapshot` event
  (`{type:"snapshot", state: <RunState>}`) reconstructing everything seen so far,
  then continues receiving live events — so joining late never shows an empty
  scene. `snapshot` is a server-to-client-only event; producers never send it.
- Every event is also appended as one line to `recordings/<runId>.ndjson`. A client
  may request replay of a past `runId` instead of/after live viewing; the server
  streams the recorded file back, pace-able by `step`. The server flushes its write
  buffer first, so a recording fetched while a run is still going contains every
  event received so far.
- A new `init` for a `runId` that already has a recording starts a fresh file; the
  previous one is kept as `<runId>.<timestamp>.ndjson` rather than having two runs
  share one timeline.
- `GET /recordings/<runId>.ndjson?tail=N` returns roughly the last `N` steps instead of
  the whole file: a first line `{"type":"snapshot","baseFrame":B,"totalFrames":T,"state":{...}}`
  (the run's full state after step marker `B`, counting markers from 0), then the
  events recorded after it. Runs no longer than `N` steps come back whole. This exists
  because a busy run records hundreds of KB per step (10k vertices + 2k agents measured
  ~250 KB/step), which is too much to ship to a browser just to pause and look back.
  A snapshot line is server-to-client only, like the live `snapshot`.
- A run with no events and no viewers for 10 minutes (`MASS_VIZ_IDLE_MS`) is dropped
  from server memory; its recording stays listable and replayable.
