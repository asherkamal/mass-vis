# mass-viz

A unified visualization tool for all four MASS variants in this workspace:
**MASS CUDA**, **MASS C++**, **MASS Java**, and **FLAME GPU2** - one shared
live/replay web viewer, one event protocol, supporting both a 2D spatial
grid rendering mode (top-down, orthographic - pan/zoom, no rotation) and a
3D graph rendering mode with agent-migration animation. Grid mode was
originally 2D/3D; 3D grid support was deliberately dropped as unnecessary
complexity - see `server/public/src/gridRenderer.js`.

It replaces the need for two prior, narrower tools already in this
workspace:

- **`../mass-graphosaurus`** - a generic WebSocket/HTTP JSON relay + three.js
  graph viewer built for MASS Java, but never actually wired to it (no
  Java code exists anywhere in that repo). Graph-only, stateless (a
  newly-connecting client sees an empty graph), documented to degrade past
  ~50 agents.
- **`../visualization`** - a Python(Plotly)/C++(OpenGL) pipeline for MASS
  C++/CUDA output. Post-hoc replay only (no live view), 2D-grid-only, with
  its "shared" scripts actually copy-pasted per app.

mass-viz fixes the specific gaps in both: a server that keeps authoritative
state so late joiners see the current run, not an empty scene; both live
streaming and NDJSON recording/replay/scrub for every backend; and one
renderer that handles both spatial grids and graphs.

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

## What's verified vs. not

This workspace originally had Node and a JDK but no Maven, no C++ compiler,
no CUDA toolchain, and no FLAME GPU2 source. Closing those gaps took, in
order: Maven and a standalone GCC (MinGW-w64) for the Java and initial C++
adapter work - see `java/README.md`'s Troubleshooting section for what the
Java side took (a custom `settings.xml` to unblock a plain-HTTP repo, a
custom truststore for one dependency's TLS cert, and a few genuine
`mass_java_core` runtime gotchas found and fixed along the way). Verifying
the C++, CUDA, and FLAME GPU2 adapters against their *real* libraries (not
just standalone/stubbed) took real installs on top of that: WSL Ubuntu 24.04
with a full build toolchain (`mass_cpp_core` and `mass_cuda_core` are both
Linux-only - `dlopen`, pthreads, an autotools libssh2 build), the CUDA
Toolkit inside WSL (12.9 specifically - `mass_cuda_core` pins `-std=c++14`,
which nvcc 13 no longer accepts), and a real `pyflamegpu` install on Windows
(no CUDA Toolkit needed there - see `flamegpu2/README.md` for what that
actually took, which is not what its own pip index page suggests). Every
one of the three found genuine, fixable friction points or real upstream
bugs along the way - see each adapter's own README for the full story
rather than repeating it here.

| Piece | Status |
|---|---|
| `server/` (protocol, state, snapshot-on-join, recording) | Built and tested here - see `server/server.js`'s test run (WebSocket protocol test covering grid mode, graph mode, late-join snapshot correctness, and NDJSON recording, all passing) |
| `server/public/` (browser viewer) | Built here; its logic (graph renderer against a stubbed three.js scene, replay/keyframe seeking, windowed replay, corrupt-recording handling) is tested headlessly in Node - see `tests/`. **Not** visually verified in a real browser - browser automation was declined - so how it looks, hover/click feel and the real frame rate are unchecked. Open `http://localhost:8080` yourself to confirm rendering. |
| `java/` adapter + examples | **Actually compiled and run**, not just signature-checked: `mass_java_core` and `mass-viz-java` both `mvn install` cleanly, and both example apps ran end-to-end against a live `server/` instance producing correct events (verified by reading the recorded `.ndjson` back) - see `java/README.md`. Later changes to the adapter (NaN handling, group/attrs, worker-JVM auto-connect, `endInitialState`) were checked by compiling with `javac` and running unit tests plus a live auto-connect; the two example apps were not re-run (they hang in `MASS.init` outside the Maven setup). |
| `cpp/` adapter + `examples/cpp-grid-demo/` | **Actually compiled and run against real `mass_cpp_core`** (built from source in WSL Ubuntu 24.04): a real `HeatCell`/`Wanderer` Place/Agent pair, `dlopen`'d as their own shared libraries the way `mass_cpp_core` actually loads them, ran a full 40-tick simulation end to end and round-tripped through a live server with a correct late-join snapshot. Caught and fixed a real bug along the way - the self-reporting `MassViz` singleton silently discarding every value when compiled into more than one `.so` - see `cpp/README.md`. |
| `cuda/` adapter + `examples/cuda-grid-demo/` | **Actually compiled and run against real `mass_cuda_core`, on a real GPU** (RTX 3080, via WSL): a real `HeatCell`/`Walker` Place/Agent pair with 4-neighbor grid connectivity and host-driven diffusion, verified against a live server with a correct late-join snapshot. Building `mass_cuda_core` itself from source surfaced three real upstream bugs (a missing Thrust include, a hardcoded 2-GPU assumption, a missing Boost.Log macro) and the demo caught one real bug of its own (custom attributes need a second `finalizeAttributes()` call) - see `cuda/README.md` for all of it, including the Boost.Log linking story that ate most of this phase's time. |
| `flamegpu2/` adapter + `examples/flamegpu2-grid-demo/` | **Actually run against a real `pyflamegpu` install, on a real GPU**: a `Cell` population running real diffusion plus a `Walker` population doing a real device-side random walk, verified against a live server with a correct late-join snapshot. Getting `pyflamegpu` importable on Windows without a full CUDA Toolkit install took five extra `pip` packages and a merged-include-directory trick (now wrapped in `flamegpu2/_pyflamegpu_env.py`) - see `flamegpu2/README.md`, which also covers a real gotcha this caught (FLAME GPU2's built-in agent ids read `0` until the first step actually runs). |

## Quick start

```bash
cd server
npm install
node server.js
# open http://localhost:8080, pick a run, click Connect
```

Neither the viewer nor the server needs a real MASS build to test - see
"Testing the viewer" below (replay recordings, live generators, and the
large social-network graph). That's a much cheaper way to test the server/viewer than standing up
a full MASS Java/C++/CUDA build, which is only worth doing when you
specifically need to verify an adapter's own code against the real library
(see `java/README.md` for what that took and what it caught).

## Running the tests

`tests/` is an automated suite that runs real processes against each other -
no mocks of the server, the WebSocket, or the generators:

```bash
cd server && npm install      # once
cd ../tests
npm test                       # about 15 s
MASS_VIZ_TEST_WSL=1 npm test   # also builds and runs the real C++/CUDA/FLAME GPU2 demos (about 1 min)
```

It uses only Node's built-in test runner (Node 22.12 or newer). What it covers:

| File | What it checks |
|---|---|
| `server.test.js` | a real server process over HTTP and WebSocket: static files, bad input, NaN handling, late-join snapshots (graph and grid), recording flush, re-init archiving, windowed replay (`?tail=N`) from memory and rebuilt from the file after a restart |
| `replay.test.js` | the viewer's data layer: run-state reducer, tolerant JSON, frames and keyframes, seeking to any frame in any order giving the same state as replaying in order, windowed loads, corrupt and step-less recordings, the committed demo recordings |
| `renderer.test.js` | the graph and grid renderers headlessly (real three.js, no WebGL): layout, instancing bookkeeping, agents, picking, selection dimming, search, inspector data |
| `generators.test.js` | each load generator run against a real server with its output verified (`gen-social-graph.js`: symmetric graph, communities, hubs, every agent move follows an edge, visit counts add up); a viewer joining mid-run gets a snapshot equal to the recording replayed to the same step; `push-ndjson.js` |
| `adapters.test.js` | the Python adapter (fakes, no GPU) and the Java adapter (compiled with `javac` against the built `mass_java_core`, plus a JVM configured only by `-Dmassviz.url` connecting for real); with `MASS_VIZ_TEST_WSL=1`, the C++ and CUDA demos built and run against the real libraries and the FLAME GPU2 demo on the GPU, with every recorded agent move checked |

Tests that need a JDK, Python or WSL are skipped (and say so) when they are
missing. The suite does **not** cover what a browser does: WebGL rendering,
CSS, the DOM in `app.js`, and real frame rates. Those still need a person
looking at http://localhost:8080.

## Testing the viewer

Three things to check: **replay** (loading a recorded run and
scrubbing/playing through it), **live** (a run being fed in real time,
including a second viewer joining mid-run), and **a large, realistic graph**
(the 10,000-node social network below, which also exercises pausing a live
run, replaying part of it and returning to live). None needs a real MASS
build - all go entirely through the server's HTTP/WebSocket API.

Start the server first for every scenario (`cd server`, `npm install` once,
then `node server.js`) and open http://localhost:8080.

### Replay mode

Two ready-made **large** recordings sit in `server/recordings/` - no setup
needed, and deliberately sized to be a real stress test, not a toy example:

| Run | Mode | Scale | What it checks |
|---|---|---|---|
| `grid-replay-sample` | grid | 150×150 (22,500 cells) × 400 steps, 50 MiB | large-scale `place_grid` rendering and scrubbing/playback performance |
| `graph-replay-sample` | graph | 1000 nodes × 100 agents × 300 steps, 3 MiB | large-scale graph rendering, ring+chord topology, many agents circling concurrently |

To load one: open http://localhost:8080, set the second dropdown to
**Replay**, pick a run from the first dropdown, click **Connect**. Drag the
step slider or hit **Play** (try the speed dropdown too - 1x/2x/4x/8x).

**What to check:**
- Playback holds a steady frame rate through the *whole* recording,
  including near the end - not slowing down as it progresses. (This was a
  real bug at this scale: every step-advance used to rebuild the entire
  scene and replay all prior history, making a 400-step recording grind to
  a crawl well before finishing. Forward steps are now applied
  incrementally on top of the current state instead - see `seekStep()` in
  `server/public/src/connection.js`.)
- Changing the speed dropdown while already playing takes effect
  immediately (also a real, separately-fixed bug - see `playback.js`).
- Loading a run jumps straight to its last step by default and should show
  the correct final state immediately, not an empty scene.

To generate a new large replay recording (no real MASS build needed):
```bash
node benchmark/gen-grid-recording.js <width> <height> <steps> [runId]
node benchmark/gen-graph-recording.js <nodeCount> <agentCount> <steps> [runId]
```
Both write straight into `server/recordings/`, ready to pick from the
Replay dropdown.

### Live mode

Live mode means opening the viewer *before* all the data exists and
watching it arrive, via `POST /event` (`PROTOCOL.md`) or a WebSocket
producer. Two generator scripts drive this at large scale:

```bash
# Grid: continuously recomputes and posts a full WxH grid (a traveling-wave
# heatmap) plus moving agents, at a steady interval, for a fixed duration.
node benchmark/gen-live-grid.js <width> <height> <durationMs> <intervalMs> [runId]
# e.g. node benchmark/gen-live-grid.js 150 150 60000 500 livetest-grid

# Graph: builds a ring+chord graph of N nodes and M agents doing continuous
# random-walk moves, for a fixed duration. Can also drive mass-graphosaurus
# for a side-by-side comparison - see benchmark/RESULTS.md's Track A.
node benchmark/gen-graph-load.js --nodes=1000 --agents=300 --duration=30000
```

**A run only appears in the viewer's dropdown once the server has received
at least one event for it**, so start the generator (or let it run) before
connecting, or just refresh the dropdown a moment after starting it. Then
in the browser: mode = **Live**, pick the run, **Connect**.

**What to check:**
- Data appears and updates live within a fraction of a second, holding a
  steady frame rate at this scale the same way replay does.
- **Late-join / snapshot correctness** - the thing graphosaurus doesn't do,
  and this project's whole reason for keeping server-side state: open a
  *second* browser tab pointed at the same running live run and Connect.
  It should immediately show the full current state (not an empty scene),
  even mid-run. This is the single most important thing to check live
  rather than in replay, since replay can never exhibit a "joined with no
  state" failure.

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

Start it, wait a few seconds while it posts the graph, then in the browser
set mode to **Live**, pick `social` (it only appears once the server has
seen an event for it; the list refreshes every 5 s) and click **Connect**.

**What to check:**
- **Readable**: nodes are colored by community (legend bottom-left) and
  sized by connections, so hubs stand out; it should read as distinct
  clusters, not a solid ball. Edges are faint by default (`edges`
  dropdown: off / faint / full).
- **Information**: hover a node to see a tooltip and just that node's edges;
  click it to select it (everything except its neighbors dims) and open the
  inspector (id, label, group, connections, attributes, neighbor list,
  agents currently on it). Click an agent for its name, topic, current
  location and move count. Links in the inspector jump to that node or
  agent. The search box (Enter) finds a node or agent by id or name, e.g.
  `user-42` or `agent-7`. Set `color` to `value` to color nodes by visit
  count instead of community (the gradient legend appears).
- **Frame rate**: read the FPS figure in the top bar with everything
  running. (It has not been measured on real hardware yet.)
- **Pause and replay a live run**: while connected live, click **Pause**.
  The view freezes on the recorded history so far and the step slider
  appears; drag it back, or hit **Play**. The run keeps being recorded on
  the server while you look. Click **Go live** to return to the current
  state, or **Refresh** to load steps recorded since you paused. **End
  live** instead keeps the run as a plain replay with no way back.
- **How much history loads**: a run this size records about 250 KB per step
  (roughly 50 MB a minute), so replay loads only the last 100 steps by
  default; the selector next to the slider offers 500 or all steps. The
  step label reads e.g. `step 812 / 812 (last 100 loaded)`. The server does
  this by answering `GET /recordings/<id>.ndjson?tail=N` with a state
  snapshot plus only the events after it.
- **Late join** works as for any live run: a second tab connecting
  mid-run shows the full current state immediately.

**Stopping and disk space**: press Ctrl+C in the terminal running the
script (or, from PowerShell, stop the `node` process running it). The
recording stays in `server/recordings/social.ndjson` and, at the default
size, grows to hundreds of MB within minutes - delete it when you are done.
Starting the script again does not append to it: the server keeps the
previous file as `social.<timestamp>.ndjson` and starts a new one, so old
runs accumulate until you delete them. An idle run leaves server memory
after 10 minutes (`MASS_VIZ_IDLE_MS`) but stays replayable from its file.

**Verification status**: the renderer, replay/keyframe logic and server
windowing were tested headlessly in Node (a stubbed three.js scene, picking,
selection, seeking, corrupt and no-step recordings, windowed vs. full replay
giving the same end state). Nothing was checked in a real browser, so how it
looks, how hover and click feel, and the actual frame rate at 10,000 nodes
and 2,000 agents are unmeasured.

**On PowerShell**: `curl` is aliased to `Invoke-WebRequest`, which doesn't
accept `-H`/`-d` - call `curl.exe` explicitly instead if you're posting
events by hand rather than using the generator scripts above. Windows
PowerShell 5.1 also strips the double quotes inside an inline JSON body, so
escape them with a backslash, on one line:

```powershell
curl.exe -X POST http://localhost:8080/event -H "Content-Type: application/json" -d '{\"v\":1,\"runId\":\"demo\",\"type\":\"init\",\"mode\":\"graph\",\"runName\":\"Demo\"}'
```

In Git Bash, plain `curl` already works fine (no alias, no escaping needed).

**On hand-typed large payloads**: don't. A ~1KB single-line JSON body,
pasted through an interactive terminal (even via a heredoc), once arrived
at the server with literal spaces inserted mid-key (`"index"` became
`"index  "`), consistently at what would have been a terminal line-wrap
point - and a plain single-line `curl -d '<json>'` command can be broken
into two commands entirely the same way if it wraps during paste. The
server survives malformed events without crashing either way (see
`handleIncomingEvent` in `server.js`), but the real fix is to never
hand-type anything non-trivial: use the generator scripts above, or
`curl -d @file.json` with a file a script wrote for you.
