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

So there's no non-invasive way to *enumerate* every live `Place*`/`Agent*`
from a driver loop. But `Places::callAll(int functionId, void *argument[],
int arg_size, int ret_size)` **does** return a host-side array with one
return value per Place, row-major - confirmed against
`mass_cpp_core/ubuntu/samples/main.cpp`, which indexes it exactly the way
`place_grid`'s protocol layout does (`retvals[i * width + j]`). That's what
`MassViz::reportPlaces()` (below) is built on - a genuine driver-loop
polling path for grid mode, no self-reporting required.

The self-reporting `callMethod`-based hook (`reportPlace()` /
`reportAgentSpawnGrid()` etc.) is still the only option for **agent**
migration, since `Agent::index`/`agentId`/`place` stay `protected`. `Place`/
`Agent`'s own `callMethod(int functionId, void *argument)` override is what
the MASS runtime already calls once per Place/Agent per
`callAll`/`exchangeAll`/`manageAll`, so `MassViz` being a singleton called
from *inside* your own `callMethod` gives it direct access to `this->index`,
`this->agentId`, etc. - see "A real bug this caught" below for the one
sharp edge this design has.

## Status: actually compiled and run against real mass_cpp_core, not just written

**Fully verified end-to-end, matching the Java adapter's bar.** `mass_cpp_core`
was built from source (WSL Ubuntu 24.04 - see "Building mass_cpp_core on
Windows" below for the exact steps and the one real snag), and
`examples/cpp-grid-demo/` - a real `Place`/`Agent` subclass pair
(`HeatCell`/`Wanderer`) wired into a driver loop calling `MASS::init`,
`Places::callAll`/`exchangeAll`, `Agents::callAll`/`manageAll` - was
compiled against it, run, and its recording checked three ways: every
event parses as valid JSON, the initial temperature field matches the
exact analytic formula at every cell (row-major indexing confirmed
correct, not transposed), and the `.ndjson` was pushed through a live
`mass-vis` server via `../benchmark/push-ndjson.js`, where a second browser
tab joining mid-run immediately showed the full current state - the
late-join snapshot check `../README.md`'s Testing section calls "the single
most important thing to check live". 238 events, 0 rejected by the server.

### A real bug this caught: the self-reporting singleton must be its own shared library

`MassViz` is a Meyers singleton. `mass_cpp_core` `dlopen()`s each
`Place`/`Agent` subclass as its **own separate `.so`**
(`DllClass.cpp`, `RTLD_LAZY` -> `RTLD_LOCAL` symbol scope), and the earlier
version of this README's own advice - "compile and link it like any other
translation unit" - meant compiling `mass_viz.cpp` into *both* the driver
binary and every Place/Agent `.so`. That produces **two independent
singleton instances**: `openGrid()` runs on the driver's instance;
`reportPlace()` (called from inside a `dlopen`'d subclass) runs on a
*different* instance, where `open_` is still `false` - so it silently falls
through to `if (!open_) return;` and discards every value, with no error,
no crash, nothing in the output file. This is exactly the kind of failure
that survives standalone unit testing (which is all the previous "compiled
clean, ran standalone" status covered) and only shows up once wired against
the real library's actual `dlopen` architecture.

**Fixed by building the adapter as its own `libmass_viz.so`, linked into
both the driver and every Place/Agent `.so`** so exactly one instance
exists process-wide - see "Build" below and `examples/cpp-grid-demo/compile.sh`
for the working link order. The old single-translation-unit advice is
removed from this README because it reproduces the bug.

## Building mass_cpp_core on Windows

**MSVC cannot build `mass_cpp_core`** - confirmed by reading its sources:
it hard-requires `<dlfcn.h>` (`dlopen`/`dlsym`, for the Place/Agent plugin
architecture above), POSIX `<netdb.h>`/pthreads, and an autotools libssh2
build. There is no CMake or MSVC path anywhere in the repo. Use WSL:

```bash
# one-time: sudo apt install build-essential (gcc/g++/make)
cp -r /path/to/mass_cpp_core ~/mass-build/     # build from a copy, never edit the original
cd ~/mass-build/mass_cpp_core/ubuntu/libssh2-1.11.1
./configure --prefix=$PWD/../ssh2 --enable-debug && make && make install
cd ../ && make          # produces libmass.so + mprocess in ubuntu/
```

**One real snag**: if the checkout was made on Windows (e.g. via a
Windows-side `git clone` with `core.autocrlf=true`), every text file in the
tree - including `libssh2`'s `configure` script - has CRLF line endings.
`./configure` then fails outright: `bash: ./configure: cannot execute:
required file not found`, because the shebang line (`#! /bin/sh\r`) doesn't
resolve. Strip `\r` from every text file in your WSL copy first (`grep -rlI
$'\r$' . --exclude-dir=.git | xargs -I{} sed -i 's/\r$//' {}`, or
equivalent) before building.

A second, unrelated artifact of building fresh: `make install` for
libssh2 can produce `libssh2.so`/`libssh2.so.1` as tiny **text files**
containing the target filename, instead of real symlinks (`ln -s
libssh2.so.1.0.1 libssh2.so.1`), which fails the final `libmass.so` link
with `file format not recognized; treating as linker script`. `LN_S` in
libssh2's own generated `libtool` script correctly says `ln -s`, and
manual `ln -s` in the same directory works fine, so this looks like a
libtool install-step quirk rather than an environment limitation - just
replace the two bogus files with real symlinks and re-run `make`.

- `mass_viz.h`/`mass_viz.cpp` compile clean under MSVC (`/W4`) and g++
  (`-Wall -Wextra`) alike, with zero warnings.
- `examples/cpp-grid-demo/` - a real `HeatCell`/`Wanderer` pair, built as
  their own `dlopen`'d shared libraries against real `mass_cpp_core`
  headers, linked against the real `libmass.so`/`libssh2` - ran a full
  40-tick simulation to completion (`MASS::init` through `MASS::finish`,
  single process). Its output was checked three ways: every one of 238
  events parses as valid JSON; the temperature field matches the exact
  analytic formula this file's own `HeatCell::init` computes, at every one
  of 108 cells (confirming row-major `[x,y]` indexing end to end, not
  transposed); and the recording round-tripped through a live `mass-viz`
  server with a second browser tab joining mid-run immediately showing the
  full current state - `../README.md`'s Testing section calls this "the
  single most important thing to check live".
- Non-finite values (`NaN`/`±Infinity`) and control characters (tabs,
  newlines) in ids/names/values were exercised directly, standalone: every
  line still parses as valid JSON (`NaN`/`Infinity` -> `null`, control
  chars -> `\uXXXX`), and the server accepted every single event (0
  rejected) - see "Cross-cutting fixes" in `../README.md`.

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

**Genuinely still out of scope**: `MASS::init` with `nProc > 1` SSHes out
and launches `mprocess` on remote hosts, so Places live in *other OS
processes* - the self-reporting design's `MassViz` singleton (a per-process
object) has no way to collect state from processes it isn't running in.
`examples/cpp-grid-demo/` uses `nProc = 1` (a single local process) for
exactly this reason. Extending self-reporting to a real multi-node run
would need each worker process to write/stream its own partial recording
and have something merge them - a real architectural change, not a bug fix.

Only file-based recording is implemented (`openGrid`/`openGraph` write to a
local `.ndjson` file) - not a live WebSocket connection, since a hand-rolled
C++ WebSocket client wasn't built here. Drop the resulting file into
`../server/recordings/<runId>.ndjson` and view it with the browser's
**Replay** mode - or, since `POST /event` accepts a JSON array,
`../benchmark/push-ndjson.js` replays an `.ndjson` file into a *live* run at
a controllable pace (this is exactly how `examples/cpp-grid-demo/`'s
late-join check above was done). Live streaming built into the adapter
itself is a natural follow-up.

## Usage

### Grid mode - driver-loop polling (recommended default)

The simplest integration, and immune to the singleton-sharing pitfall above
since nothing calls into `MassViz` from inside a `dlopen`'d `.so` - see
`examples/cpp-grid-demo/main.cpp` for the full worked version:

```cpp
#include "mass_viz.h"

// Once at startup, before the simulation loop:
massviz::MassViz::instance().openGrid("heat2d-run.ndjson", "heat2d-run", "Heat2D", {width, height});

for (int step = 0; step < numSteps; step++) {
    grid->callAll(Land::tick_);

    // Places::callAll(functionId, argument[], arg_size, ret_size) returns
    // one value per Place, row-major - see this file's earlier section on
    // why this needs no self-reporting hook.
    double *values = (double *)grid->callAll(
        Land::report_, (void **)args, sizeof(int), sizeof(double));
    massviz::MassViz::instance().reportPlaces(values, width * height);
    delete[] values;

    massviz::MassViz::instance().step(step);
}

massviz::MassViz::instance().close();
```

### Grid mode - self-reporting (needed for agent migration)

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

**Whichever grid-mode path you use, agent spawn/migration still needs
`reportAgentSpawnGrid`/`reportAgentMoveGrid` called from inside the
`Agent` subclass's own `callMethod` - `Agent::index`/`place` stay
`protected`, so there's no driver-loop alternative for agents** - see
`examples/cpp-grid-demo/Wanderer.cpp`.

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

`mass_viz.cpp` has no special dependencies (standard library only), but
**must be built as its own shared library, `libmass_viz.so`, linked into
both your driver and every `dlopen`'d Place/Agent `.so`** - see "A real bug
this caught" above for exactly why compiling it separately into each
translation unit (the old advice here) silently discards every value.

```sh
# once, produces libmass_viz.so:
g++ -std=c++20 -fPIC -shared mass_viz.cpp -o libmass_viz.so

# each Place/Agent subclass links against it, not against mass_viz.cpp directly:
g++ -std=c++20 -fPIC -shared HeatCell.cpp -Imass-viz/cpp/include -L. -lmass_viz -o HeatCell

# the driver links against it too:
g++ -std=c++20 main.cpp -I$MASS_DIR/source -L$MASS_DIR/ubuntu -lmass \
    -I$MASS_DIR/ubuntu/ssh2/include -L$MASS_DIR/ubuntu/ssh2/lib -lssh2 \
    -L. -lmass_viz -o main
```

See `examples/cpp-grid-demo/compile.sh` for the complete, working version of
this (including `-rdynamic` and the exact include/link order used to build
and run the real demo above).
