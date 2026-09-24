# mass-viz

A general visualization tool for MASS libraries: **MASS CUDA**, **MASS C++**,
**MASS Java** - one shared live/replay web viewer, one event protocol, 
supporting both a 2D spatial grid rendering mode and a 3D graph rendering mode
with agent-migration animation.

## Layout

- **`PROTOCOL.md`** - the wire format every adapter speaks (NDJSON events).
- **`server/`** - the relay/recording server + browser viewer (Node +
  three.js). Fully built and test-verified in this repo - see below.
- **`java/`** - the MASS Java adapter (`MassViz`). The piece prioritized to
  be complete and correct against real, directly-verified API signatures.
- **`examples/java-grid-demo`, `examples/java-graph-demo`** - runnable demo
  apps exercising both render modes end-to-end.
- **`cpp/`** - the MASS C++ (cluster) adapter, self-reporting from inside
  `Place`/`Agent::callMethod` (plus a driver-loop polling path for grid
  mode) - see `cpp/README.md` for why both exist, and its "Build" section
  for the shared-library link requirement a real `mass_cpp_core` build
  surfaced.
- **`cuda/`** - the MASS CUDA adapter. Grid mode only (CUDA core has no
  graph API); polls via `Places::downloadAttributes<T>()`.
- **`flamegpu2/`** - the FLAME GPU2 (`pyflamegpu`) adapter. Grid mode only,
  mirroring `cuda/` as closely as possible per the project's own intent
  (FLAME GPU2 benchmarks MASS CUDA) - same grid-mode-only NDJSON protocol,
  same poll-after-a-step shape, so a FLAME GPU2 run and a MASS CUDA run of a
  comparable model land in the same viewer, in the same visual language,
  for a fair side-by-side. Built via a FLAME GPU2 step function
  (`pyflamegpu.HostFunction`) rather than a driver-loop call, since that's
  FLAME GPU2's own per-tick host hook - see `flamegpu2/README.md` for why
  that differs from `cuda/`'s shape and for the exact API citations, plus
  what a real Windows `pyflamegpu` install actually took.
- **`examples/cpp-grid-demo/`, `examples/cuda-grid-demo/`,
  `examples/flamegpu2-grid-demo/`** - runnable demo apps exercising the
  C++, CUDA, and FLAME GPU2 adapters end-to-end against their real
  libraries, matching the Java demos below.
- **`benchmark/gen-social-graph.js`** - live generator for a large
  social-network-style graph (10,000 users, 2,000 walking agents by
  default); see "Large social-network graph" under Testing the viewer.
- **`benchmark/gen-graph-load.js`, `gen-live-grid.js`, `gen-grid-recording.js`,
  `gen-graph-recording.js`** - the other load generators, described under
  Testing the viewer; **`benchmark/lib.js`** holds the argument parsing and
  HTTP helper they share, and **`benchmark/RESULTS.md`** the measured
  comparison against Plotly and mass-graphosaurus.
- **`tests/`** - the end-to-end test suite; see "Running the tests" below.
- **`benchmark/push-ndjson.js`** - replays a recorded `.ndjson` file into a
  *live* run on a running server, at a controllable pace. The C++, CUDA,
  and FLAME GPU2 adapters are all file-only writers with no WebSocket
  client, so this is what lets their output exercise live rendering and the
  late-join snapshot path, not just Replay mode.


## Quick start

```bash
cd server
npm install
node server.js
# open http://localhost:8080, pick a run, click Connect

### Replay mode

Two recordings sit in `server/recordings/`

| Run | Mode | Scale | What it checks |
|---|---|---|---|
| `grid-replay-sample` | grid | 150×150 (22,500 cells) × 400 steps, 50 MiB | large-scale `place_grid` rendering and scrubbing/playback performance |
| `graph-replay-sample` | graph | 1000 nodes × 100 agents × 300 steps, 3 MiB | large-scale graph rendering, ring+chord topology, many agents circling concurrently |

To load one: open http://localhost:8080, set the second dropdown to
**Replay**, pick a run from the first dropdown, click **Connect**. Drag the
step slider or hit **Play** (try the speed dropdown too - 1x/2x/4x/8x).

To generate a new replay recording:
```bash
node benchmark/gen-grid-recording.js <width> <height> <steps> [runId]
node benchmark/gen-graph-recording.js <nodeCount> <agentCount> <steps> [runId]
```
Both write straight into `server/recordings/`, ready to pick from the
Replay dropdown.

### Live mode

Live mode means watching the data asit arrives, via `POST /event` 
(`PROTOCOL.md`) or a WebSocket producer. Two generator scripts:

```bash
# Grid: continuously recomputes and posts a full WxH grid (a traveling-wave
# heatmap) plus moving agents, at a steady interval, for a fixed duration.
node benchmark/gen-live-grid.js <width> <height> <durationMs> <intervalMs> [runId]
# e.g. node benchmark/gen-live-grid.js 150 150 60000 500 livetest-grid

# Graph: builds a ring+chord graph of N nodes and M agents doing continuous
# random-walk moves, for a fixed duration.
node benchmark/gen-graph-load.js --nodes=1000 --agents=300 --duration=30000
```


### Large social-network graph (live, with pause / replay / go live)

`benchmark/gen-social-graph.js` builds a social-network-style graph and
keeps agents walking along its edges. Users are split into communities of
skewed sizes; inside a community new users link to existing members by
preferential attachment (so a few hubs emerge), with a small share of links
across communities. Every vertex has a label (`user-1234`), a group (its
community) and a follower count; agents have a name and a topic; each node's
`place_value` is a running visit count. It sends the `init`, the vertices,
the agents and a `step -1` initial-state marker itself, so there is nothing
to send by hand.

```bash
# defaults: 10,000 users, 2,000 agents, ~3 links per new user, runs until Ctrl+C
node benchmark/gen-social-graph.js
# a smaller, quicker variant that stops on its own after 60 s
node benchmark/gen-social-graph.js --nodes=1000 --agents=200 --duration=60000
```

| Flag | Default | Meaning |
|---|---|---|
| `--nodes` | 10000 | number of users (vertices) |
| `--agents` | 2000 | number of walking agents |
| `--links` | 3 | links each new user makes |
| `--communities` | nodes / 250 (min 4) | number of communities |
| `--tick` | 300 | ms between agent moves |
| `--duration` | 0 | ms to run; `0` = until Ctrl+C |
| `--run` | `social` | run id shown in the dropdown |
| `--port` | 8080 | server port |

Start it, wait a few seconds, then in the browser set mode
to **Live**, pick `social` and click **Connect**.


- **Readable**: nodes are colored by community (legend bottom-left) and
sized by connections, so hubs stand out as distinct clusters. Edges
are faint by default (`edges` dropdown: off / faint / full).
- **Information**: hover a node to see a tooltip and just that node's edges;
click it to select it (everything except its neighbors dims) and open the
inspector (id, label, group, connections, attributes, neighbor list,
agents currently on it). Click an agent for its name, topic, current
location and move count. Links in the inspector jump to that node or
agent. The search box (Enter) finds a node or agent by id or name, e.g.
`user-42` or `agent-7`. Set `color` to `value` to color nodes by visit
count instead of community (the gradient legend appears).
- **Frame rate**: FPS figure in the top bar when running. 
- **Pause and replay a live run**: while connected live, click **Pause**.
The view freezes on the recorded history so far and the step slider
appears; drag it back, or hit **Play**. The run keeps being recorded on
the server while you look. Click **Go live** to return to the current
state, or **Refresh** to load steps recorded since you paused. **End
live** instead keeps the run as a plain replay with no way back.
- **How much history loads**: replay loads only the last 100 steps by
default; the selector next to the slider offers 500 or all steps.
- **Late join** works as for any live run: a second tab connecting
mid-run shows the full current state immediately.





```powershell
curl.exe -X POST http://localhost:8080/event -H "Content-Type: application/json" -d '{\"v\":1,\"runId\":\"demo\",\"type\":\"init\",\"mode\":\"graph\",\"runName\":\"Demo\"}'
```

## tests

```bash
cd server && npm install      # once
cd ../tests
npm test                       
MASS_VIZ_TEST_WSL=1 npm test   # builds and runs the C++/CUDA/FLAME GPU2 demos
```

It uses only Node's built-in test runner (Node 22.12 or newer). What it covers:

| File | What it checks |
|---|---|
| `server.test.js` | a real server process over HTTP and WebSocket: static files, bad input, NaN handling, late-join snapshots (graph and grid), recording flush, re-init archiving, windowed replay (`?tail=N`) from memory and rebuilt from the file after a restart |
| `replay.test.js` | the viewer's data layer: run-state reducer, tolerant JSON, frames and keyframes, seeking to any frame in any order giving the same state as replaying in order, windowed loads, corrupt and step-less recordings, the committed demo recordings |
| `renderer.test.js` | the graph and grid renderers headlessly (real three.js, no WebGL): layout, instancing bookkeeping, agents, picking, selection dimming, search, inspector data |
| `generators.test.js` | each load generator run against a real server with its output verified (`gen-social-graph.js`: symmetric graph, communities, hubs, every agent move follows an edge, visit counts add up); a viewer joining mid-run gets a snapshot equal to the recording replayed to the same step; `push-ndjson.js` |
| `adapters.test.js` | the Python adapter (fakes, no GPU) and the Java adapter (compiled with `javac` against the built `mass_java_core`, plus a JVM configured only by `-Dmassviz.url` connecting for real); with `MASS_VIZ_TEST_WSL=1`, the C++ and CUDA demos built and run against the real libraries and the FLAME GPU2 demo on the GPU, with every recorded agent move checked |

