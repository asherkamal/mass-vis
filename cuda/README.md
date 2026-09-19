# mass-viz CUDA adapter

Feeds MASS CUDA (`mass_cuda_core`) simulation state to the mass-viz viewer
(see `../server`), via the shared NDJSON protocol (`../PROTOCOL.md`). Grid
mode only - confirmed by inspecting `mass_cuda_core/src`: there is no
graph/vertex API anywhere in the CUDA library, unlike `mass_cpp_core`/
`mass_java_core`.

## Why this looks different from the C++ cluster adapter

The C++ cluster adapter (`../cpp`) has to be a self-reporting singleton
because `mass_cpp_core`'s `Place`/`Agent` state is only reachable from
inside the object itself.

`mass_cuda_core` is the opposite: `Place`/`Agent` live on the GPU and are
only reachable through `__device__` methods, so the host-side API is built
entirely around bulk attribute download instead - `mass::Places::
downloadAttributes<T>(tag, length)`, `mass::Places::getIndexVector(i)`,
`mass::Places::getNumPlaces()`, and the `mass::Agents` equivalents (all
confirmed public host methods by reading `Place.h`/`Places.h`/`Agents.h`
directly). So this adapter polls from the host driver loop, like the Java
adapter (`../java`) does - just reached via attribute download instead of
direct object references.

## Status: actually compiled and run against real mass_cuda_core, on a real GPU

**Fully verified end-to-end.** `mass_cuda_core` was built from source in WSL
Ubuntu 24.04 (CUDA Toolkit 12.9, GCC 13, Boost 1.84 - see "Building
mass_cuda_core on Windows" below for the exact steps and every real snag
hit along the way), and `examples/cuda-grid-demo/` - real `HeatCell`
(`Place`) and `Walker` (`Agent`) subclasses, `4`-neighbor grid connectivity
via `exchangeAll`, host-side diffusion driven by
`Places::downloadAttributes<double>` each tick - was compiled against the
real headers, linked against the real `mass_cuda.a`, and run to completion
on an actual RTX 3080 (not a stub or mock). Its recording was checked three
ways: every one of 287 events parses as valid JSON; the initial temperature
field matches the exact analytic formula at cell `(5,3)` in a deliberately
asymmetric 16x10 grid, confirming `ROW_MAJOR`/`downloadAttributes` ordering
really does match `place_grid`'s `values[y*width+x]` layout end to end
(this was a documented assumption, not previously checked against a real
GPU run); and the `.ndjson` was pushed through a live `mass-vis` server via
`../benchmark/push-ndjson.js`, where a second browser tab joining mid-run
immediately showed full state.

### Three real bugs in mass_cuda_core itself, found by actually building it

None of these are in this adapter - they are pre-existing defects in
`mass_cuda_core` (v0.7.1, "under active development") uncovered by building
it from source for the first time against a modern toolchain, on a
single-GPU machine. Confirmed real, exact, and fixed in the build copy used
for the demo above (never in the original checkout - see this project's own
constraint on that). If you hit them yourself, the fixes are:

1. **Won't compile against CUDA 12.x's Thrust**: `src/Dispatcher.cu` calls
   `thrust::remove` but only includes `<thrust/sort.h>`/`<thrust/device_ptr.h>`
   - `error: namespace "thrust" has no member "remove"`. Add
   `#include <thrust/remove.h>`.
2. **Hardcoded to require exactly 2 GPUs**: `Dispatcher::init()`
   (`src/Dispatcher.cu`) has `int gpuCount = 2;` with the real
   `cudaGetDeviceCount(&gpuCount);` call commented out directly below it -
   clearly a leftover from local dev debugging. On any machine without a
   second GPU device at index 1 (including this one - a single RTX 3080),
   it queries a nonexistent device, and every later CUDA call from that
   point fails with `invalid device ordinal` or `an illegal memory access`,
   confusingly reported from wherever the poisoned CUDA context is next
   touched (`compute-sanitizer` was needed to trace this back to its real
   origin). Restore the real device count query.
3. **Its own Boost.Log build needs `BOOST_LOG_DYN_LINK`** - see the Boost
   section below; this affects `mass_cuda_core`'s own `Makefile`
   (`BOOST_INCLUDE`), not just consumers of it.

### The Boost.Log linking trap - the single biggest time sink here

Every symbol in `mass_cuda.a` that touches `mass::logger` (i.e. nearly
every `.o` in the library) failed to link with `undefined reference to
boost::log::v2s_mt_posix::core::get()` and dozens like it - **even though
`nm` confirms the exact symbol is defined in `libboost_log.a`/`.so`**, and
neither reordering the link line nor `--whole-archive` nor linking the
`.so` directly instead of the `.a` made any difference. Isolated down to a
two-line `BOOST_LOG_TRIVIAL(info) << "x";` program with zero
`mass_cuda_core`/CUDA involvement to confirm it wasn't this adapter's
fault.

**Root cause**: Boost.Log's headers select a different ABI tag
(`v2s_mt_posix` vs. `v2_mt_posix` - note the missing `s`) depending on
whether `BOOST_LOG_DYN_LINK` is defined at the point they're included, and
`b2 install`'s shared-library build of Boost.Log expects that macro from
every consumer. **Every translation unit that includes anything reaching
`Logger.h` needs `-DBOOST_LOG_DYN_LINK`** - both `mass_cuda_core`'s own
build (its Makefile didn't have this - see bug 3 above) and this adapter's
`compile.sh`, which now sets it via `BOOST_INC`.

### -rdc=true device linking needs a specific two-step recipe

`mass_cuda_core` builds with `-rdc=true` (relocatable device code - see its
Makefile), since consuming code's own `__device__` functions can call
device-side helpers compiled into `mass_cuda.a` (e.g.
`mass::getGlobalIdx_1D_1D`) from a different translation unit. Consuming
code must match `-rdc=true`, and the final link is a genuine two phase
process: `nvcc -dlink` first (device-code linking only), then a *plain*
`g++` host link (not `nvcc`) for everything else - `nvcc`'s own driver
rejected `-Wl,--start-group` outright, and the `-Xlinker
--start-group`/`--end-group` equivalent compiled but silently failed to
apply (nvcc appears to restructure host-linker arguments internally for
its own device-link machinery, dropping the group boundary). The
`--start-group`/`--end-group` around `mass_cuda.a` + the Boost static libs
in the final `g++` link *is* load-bearing - `mass_cuda.a`'s objects
reference Boost.Log symbols, and plain left-to-right archive resolution
only pulls in an archive member once. See
`examples/cuda-grid-demo/compile.sh` for the full, working sequence.

### A real bug this build caught in the demo itself: custom attributes need a second finalizeAttributes()

`Mass::createPlaces<T>`/`Mass::createAgents<T>` call `finalizeAttributes()`
internally, but only for the library's own *predefined* attributes
(`NEIGHBORS`, `AGENT_POPS`, etc.) - any custom attribute (like `HeatCell`'s
`TEMPERATURE`) needs its own `setAttribute<T>(...)` call **and a second,
separate `finalizeAttributes()` call** afterward, confirmed against
`mass_cuda_core`'s own `MASS_Places.Attributes` test. Skipping this doesn't
fail where you'd expect: every `getAttribute<T>` read of an unregistered
tag is an out-of-bounds device access that doesn't crash at the point of
the bad read - it corrupts the CUDA context, and the first *visible* error
shows up later, on some unrelated CUDA call (in this case, a `cudaMalloc`
for an entirely different Agents collection two steps later).
`compute-sanitizer --tool memcheck` was needed to trace the real origin;
without it, the error message's file/line is actively misleading. See
`examples/cuda-grid-demo/main.cu`'s comment at the `setAttribute` calls.

### Known unresolved: mass_cuda_core's own `make test` (not blocking)

`mass_cuda_core`'s GoogleTest suite (`make test`) hits a *different*,
still-unexplained Boost.Log ABI tag mismatch (`v2_mt_posix` vs.
`v2s_mt_posix`) between its own compiled objects and the test binary, not
reproduced by the demo app's build (which uses the same `BOOST_INCLUDE`
macro and links cleanly). Given the demo above already validates the
library end-to-end against a real GPU with semantically-checked correct
output - arguably stronger evidence than a unit-test pass/fail bit - this
was left unresolved rather than sinking further time into a second,
narrower Boost.Log linking puzzle. `lib/gtest` also installs to `lib/`, not
the `lib64/` the Makefile's `TEST_LIB_DIR` expects (a `lib64 -> lib` symlink
works around it) - a plain CMake/Ubuntu vs. RHEL install-layout mismatch,
unrelated to the above.

As with the C++ adapter, only file-based recording is implemented in this
adapter itself (no live WebSocket client) - drop the resulting `.ndjson`
into `../server/recordings/` and use the browser's Replay mode, or push it
into a live run with `../benchmark/push-ndjson.js`.

## Building mass_cuda_core on Windows

**MSVC cannot build this either** - the Makefile is `nvcc`-only with
`/usr/local/cuda`-style paths and no CMake/MSVC path. Use WSL with the CUDA
Toolkit installed there (`nvidia-smi` working inside WSL confirms GPU
passthrough):

```bash
cp -r /path/to/mass_cuda_core ~/mass-build/     # build from a copy, never edit the original
cd ~/mass-build/mass_cuda_core
# apply the 3 fixes above to this copy first (Dispatcher.cu's #include and
# gpuCount, Makefile's BOOST_INCLUDE), then:
make develop      # installs googletest + Boost 1.84, then builds mass_cuda.a
```

`install-boost`'s hardcoded download URL
(`boostorg.jfrog.io/artifactory/...`) has been decommissioned (redirects to
a "reactivate-server" landing page, not the tarball) - use
`https://archives.boost.io/release/$(BOOST_VERSION)/source/boost_$(BOOST_TAG).tar.gz`
instead and run the rest of `install-boost`'s steps (`bootstrap.sh`,
`./b2 install`) manually against the downloaded tarball.

`reportPlaces` emits a single `place_grid` event (a flat values array, no
per-cell index) rather than one `place` event per cell - a real, measured
fix, not a hypothetical one (see `../benchmark/RESULTS.md`'s Track B: the
per-cell-indexed form was ~5x larger for a dense full-grid update that
changes every tick, which is exactly what a CUDA Heat2D-style grid does).
It forwards `downloadAttributes`'s buffer as-is with no per-cell coordinate
lookup, since mass_cuda_core's own row-major download order already
matches the protocol's `place_grid` ordering (`values[y*width+x]`) - just
make sure the `dims` passed to `openGrid` matches the axis order your
`Places` object actually uses internally.

## Usage

You choose what "value" and "agent position" mean, by picking which
attribute tag(s) to download - this header doesn't assume a predefined
attribute layout beyond `getIndexVector` for place coordinates.

**Before any of this works**: every custom attribute (`TEMPERATURE_TAG`,
`AGENT_PLACE_INDEX_TAG`, `AGENT_ID_TAG` below) needs its own
`places->setAttribute<T>(tag, length)` / `agents->setAttribute<T>(tag,
length)` call, **followed by another `places->finalizeAttributes()` /
`agents->finalizeAttributes()`** - `Mass::createPlaces`/`createAgents`
already called it once for the library's own predefined attributes only.
See "A real bug this build caught" above for what skipping this actually
does (nothing helpful) and `examples/cuda-grid-demo/main.cu` for the
complete working sequence.

```cpp
#include "mass_viz_cuda.h"

// Once at startup, after places->finalizeAttributes():
massviz::MassVizCuda::instance().openGrid(
    "heat2d-cuda-run.ndjson", "heat2d-cuda-run", "Heat2D (CUDA)", {width, height});

// Once per tick, after places->callAll(TICK_FUNC):
double* temperatures = places->downloadAttributes<double>(TEMPERATURE_TAG, 1);
massviz::MassVizCuda::instance().reportPlaces(temperatures, places->getNumPlaces());
delete[] temperatures; // per mass_cuda_core's own downloadAttributes ownership convention

// If your app tracks agents via attributes (e.g. a PLACE_INDEX and an ID
// attribute you maintain yourself):
int* agentPlaceIdx = agents->downloadAttributes<int>(AGENT_PLACE_INDEX_TAG, 1);
long long* agentIds = agents->downloadAttributes<long long>(AGENT_ID_TAG, 1);
massviz::MassVizCuda::instance().reportAgents(places, agentPlaceIdx, agentIds, agents->getNumAgents());
delete[] agentPlaceIdx;
delete[] agentIds;

massviz::MassVizCuda::instance().step(currentStep);

// At shutdown:
massviz::MassVizCuda::instance().close();
```

## Build

Not a one-liner - see "The Boost.Log linking trap" and "`-rdc=true` device
linking" above for why, and **`examples/cuda-grid-demo/compile.sh` for the
complete, actually-working build** (real invocations, not illustrative
pseudocode). In short:

1. `mass_viz_cuda.cpp` (the one file that includes `Places.h` - see the
   forward-declaration note at the top of `mass_viz_cuda.h` for why callers
   don't need to) must be compiled with **`nvcc`**, not a plain C++
   compiler - `Places.h` pulls in `DeviceConfig.h`, which has real
   `__global__` kernels and `<<<...>>>` launch syntax that only nvcc's
   frontend parses.
2. Every translation unit touching `Places.h`/`Agents.h` needs
   `-DBOOST_LOG_DYN_LINK` and `mass_cuda_core`'s Boost include path, and
   your own `.cu` files need `-rdc=true` to match how `mass_cuda_core`
   itself was built.
3. The final link is two nvcc/g++ invocations, not one: `nvcc -dlink` for
   device code, then a plain `g++` host link with `mass_cuda.a` and the
   Boost static libs wrapped in `-Wl,--start-group`/`--end-group`.
