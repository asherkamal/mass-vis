# mass-viz C++ adapter

Feeds MASS C++ (`mass_cpp_core`) cluster simulation state to the mass-viz
viewer (see `../server`), via the shared NDJSON protocol (`../PROTOCOL.md`).

## Why this looks different from the Java adapter

The Java adapter (`../java`) lets you snapshot an entire `Places`/`Agents`
container from your driver loop, because `PlacesBase.getPlaces()` and
`AgentsBase.getAgents()` are public.

`mass_cpp_core` doesn't expose an equivalent. Reading `Place.h`, `Places.h`,
`Places_base.h`, and `Agent.h` directly confirms:

- `Places_base`/`Places` have no public method returning the `Place*`
  instances they own - only aggregate accessors like `getPlacesSize()`.
- `Place::index`, `Place::agents` are public, but there's no way to get a
  `Place*` for an arbitrary index from outside the library.
- `Agent::index`, `Agent::agentId`, `Agent::place` are all `protected` -
  readable only from inside the `Agent` subclass itself.

So there's no non-invasive way to poll state from a driver loop. The
non-invasive hook that **does** exist is `Place`/`Agent`'s own
`callMethod(int functionId, void *argument)` override, which the MASS
runtime already calls once per Place/Agent per `callAll`/`exchangeAll`/
`manageAll`. `MassViz` is a singleton for exactly this reason: it's called
from *inside* your own `callMethod`, which already has direct access to
`this->index`, `this->agentId`, etc.

## Status: actually compiled and run, not just written

`include/mass_viz.h` / `include/mass_viz.cpp` are self-contained (standard
library only - `<string>`, `<vector>`, `<fstream>`, `<mutex>`, `<chrono>`,
`<sstream>`; no `mass_cpp_core` headers included), so unlike the Java
adapter this one never needed the real `mass_cpp_core` (and its heavy
dependency chain - libssh2, NetCDF, Boost) to be verified at all. A
standalone GCC (MinGW-w64, fetched via `winget` since none was installed)
was enough:

- `g++ -std=c++17 -Wall -Wextra -c mass_viz.cpp` - **compiles clean, zero
  warnings.** This caught one real bug: a doc comment in `mass_viz.h`
  containing the literal text `Place*/Agent*` accidentally closed the C
  comment early (`*/` is the comment terminator), turning the rest of the
  comment into garbage that failed to parse. Fixed by rewording. Comment
  bugs like this are exactly the kind of thing that "just read the
  signatures" verification doesn't catch - only an actual compile does.
- A small standalone sample program (no `mass_cpp_core` involved - just
  calls `MassViz::instance()` with synthetic data, the same way a real
  `Place`/`Agent::callMethod()` would) was compiled and run for both grid
  and graph mode, producing 394 and 59 well-formed NDJSON lines
  respectively (every line validated as parseable JSON matching
  `../PROTOCOL.md`'s shapes).
- Both sample outputs were verified against the live `../server`: the grid
  sample was dropped into `../server/recordings/` and served back
  byte-identical over `GET /recordings/<id>.ndjson`; the graph sample was
  replayed live via `POST /event` (59/59 events accepted) and a WebSocket
  viewer confirmed the resulting state was correct - all 8 vertices with
  the right adjacency (including the one chord edge), both agents at their
  correct final positions after 12 migration steps, `lastStep: 11`.
  (Those two sample recordings were later removed from `../server/recordings/`
  in a cleanup pass - see `../README.md`'s Testing section for the large
  curated samples that replaced them; this adapter's own correctness isn't
  affected, only which example files ship.)
- `reportPlace()`/`step()`'s buffering (below) was independently compiled
  and run against a small standalone test asserting the exact emitted JSON
  - confirmed 2 `place_grid` events for 2 ticks, correct row-major
  flattening, and that unstated cells retain their prior tick's value.

### Grid mode is now compact by default - a measured fix, not a guess

`reportPlace(index, value)` no longer emits one `place` event per call.
Following this file's own documented usage pattern (every Place reports,
then `step()` is called once) already guarantees every Place has reported
before `step()` runs - so `reportPlace` now buffers into an internal flat
grid, and `step()` flushes it as a single `place_grid` event (see
`../PROTOCOL.md`) before writing the step marker. Existing callers get this
for free with no code changes, as long as they follow the pattern already
shown below. Measured on the actual benchmark data (`../benchmark/RESULTS.md`'s
Track B): ~5x smaller for a dense full-grid update that changes every tick,
which is exactly this adapter's typical workload (e.g. a Heat2D-style
temperature field). The buffer persists across ticks - if some cells aren't
re-reported in a given tick, their last known value is retained, which is
the correct behavior for the common case (`Places::callAll()` invokes every
Place's `callMethod()` every tick in a normal MASS driver loop, so the
buffer is naturally complete by the time `step()` runs).

What's still unverified: the actual `Place`/`Agent` subclass wiring shown
below (real `mass_cpp_core` isn't buildable in this environment - see
`../java/README.md`'s Troubleshooting section for why that's a heavier lift
than it was for Java, mostly around `mass_cpp_core` not having a portable
single-command build the way Maven gives Java). If you build against a real
`mass_cpp_core`, please report back anything that doesn't compile there.

Only file-based recording is implemented (`openGrid`/`openGraph` write to a
local `.ndjson` file) - not a live WebSocket connection, since a hand-rolled
C++ WebSocket client couldn't be tested here either. Drop the resulting file
into `../server/recordings/<runId>.ndjson` and view it with the browser's
**Replay** mode, which exercises the full pipeline (snapshot, scrub,
playback) already verified end-to-end via `../server`'s test suite - or,
since `POST /event` accepts a JSON array, a small script can replay an
`.ndjson` file's lines as one live batch (exactly how the graph sample
above was tested) as a stand-in for real live streaming. Live streaming
built into the adapter itself is a natural follow-up once this file format
is validated against a real run.

## Usage

### Grid mode

```cpp
#include "mass_viz.h"

class HeatCell : public Place {
public:
    HeatCell(void *arg) : Place(arg) {}

    void *callMethod(int functionId, void *argument) override {
        switch (functionId) {
            case TICK: {
                double value = /* ... your existing per-step computation ... */;
                massviz::MassViz::instance().reportPlace(index, value);
                return nullptr;
            }
        }
        return nullptr;
    }
};

// Once at startup, before the simulation loop:
massviz::MassViz::instance().openGrid("heat2d-run.ndjson", "heat2d-run", "Heat2D", {width, height});

// Once per tick, after all Places have run their TICK callMethod:
massviz::MassViz::instance().step(currentStep);

// At shutdown:
massviz::MassViz::instance().close();
```

### Graph mode

Declare each vertex once during setup (from whatever adjacency your app
already tracks - `mass_cpp_core`'s own `GraphPlaces`/`VertexPlace`/
`GraphModel` API, per `GraphModel.h`/`VertexModel.h`, is one source for
this: `GraphPlaces::getGraphOnThisNode()` returns a `GraphModel*` with
`vector<VertexModel*>`, each exposing its name/neighbors/weights), then
report each vertex's scalar value and any agent movement per tick:

```cpp
massviz::MassViz::instance().openGraph("shortest-path-run.ndjson", "sp-run", "ShortestPath");

// setup, once per vertex:
massviz::MassViz::instance().reportVertex(vertexId, vertexName, neighborIds);

// per tick, from within a Place's callMethod:
massviz::MassViz::instance().reportPlaceValue(vertexId, value);

// from within an Agent's callMethod, on spawn/migration:
massviz::MassViz::instance().reportAgentSpawnGraph(agentIdStr, atVertexId);
massviz::MassViz::instance().reportAgentMoveGraph(agentIdStr, toVertexId);
```

## Build

`mass_viz.cpp` has no special dependencies - compile and link it like any
other translation unit in your application, e.g. add
`mass-viz/cpp/include/mass_viz.cpp` to your app's Makefile sources and
`-Imass-viz/cpp/include` to its include path. It does not need to be linked
into `libmass.so` itself.
