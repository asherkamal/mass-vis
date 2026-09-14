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

## Status

Not compiled in the environment that authored it - no CUDA toolchain
(`nvcc`) or GPU was available there, and `mass_viz_cuda.h` includes
`mass_cuda_core`'s own `Places.h`/`Agents.h`, so it needs that toolchain to
build. Written strictly against the method signatures above; please build
and test it against your own `mass_cuda_core` checkout and report back
anything that doesn't compile or behave as documented.

As with the C++ adapter, only file-based recording is implemented (no live
WebSocket client) - drop the resulting `.ndjson` into
`../server/recordings/` and use the browser's Replay mode.

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

Compile `mass_viz_cuda.cpp` alongside your application with `nvcc` (or your
existing build's C++ compiler, as long as `mass_cuda_core`'s include paths
are visible - `Places.h` pulls in CUDA runtime headers transitively), and
link against `mass_cuda_core`'s `lib/mass/mass_cuda.a` as usual.
