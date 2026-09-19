# mass-viz FLAME GPU2 adapter

Feeds a FLAME GPU2 (`pyflamegpu`) simulation's state to the mass-viz viewer
(see `../server`), via the shared NDJSON protocol (`../PROTOCOL.md`). Grid
mode only, mirroring the MASS CUDA adapter (`../cuda`) as closely as
possible - same grid-mode-only protocol, same poll-after-a-step shape - so
a FLAME GPU2 run and a MASS CUDA run of a comparable model land in the same
viewer, in the same visual language, for a fair side-by-side. This is the
FLAME GPU2 piece `../README.md` previously listed as deferred; see that
file's "Layout" and "What's verified vs. not" sections for how it fits into
the rest of mass-viz.

## Why this looks different from the CUDA (C++) adapter

`../cuda/mass_viz_cuda.h` is a host-side C++ object a driver loop calls
explicitly (`openGrid`/`reportPlaces`/`step`/`close`), because MASS CUDA has
no per-tick callback hook exposed to host code beyond the driver loop
itself.

FLAME GPU2 is the opposite: it has a first-class per-tick host callback - a
**step function** - which this adapter is built around. Per FLAME GPU2's
confirmed API shape (read directly from `github.com/FLAMEGPU/FLAMEGPU2`,
master branch - `include/flamegpu/runtime/HostAPI.h`,
`include/flamegpu/runtime/HostFunctionCallback.h`,
`include/flamegpu/runtime/agent/HostAgentAPI.cuh`,
`include/flamegpu/simulation/AgentVector.h`/`AgentVector_Agent.h`, and the
Python bindings' naming convention in `swig/python/flamegpu.i` - since no
FLAME GPU2 source or GPU was available in the environment that authored
this adapter):

- A Python step function subclasses `pyflamegpu.HostFunction` (SWIG-renamed
  from `HostFunctionCallback`) and overrides `run(self, FLAMEGPU)`,
  registered via `model.addStepFunction(instance)` and invoked once per
  simulation step.
- `FLAMEGPU.getStepCounter()` gives the current step number.
- `FLAMEGPU.agent(name).getPopulationData()` returns a `DeviceAgentVector` -
  confirmed to support plain Python `len(...)`/`[i]` indexing (SWIG
  `__len__`/`__getitem__` extensions).
- Per-agent variable access is one typed method per C++ type -
  `getVariableFloat`, `getVariableInt`, `getVariableUInt`, etc. - because
  `AgentVector_Agent::getVariable<T>` is a C++ template and SWIG
  instantiates a separate concretely-named wrapper per type rather than one
  dynamically-typed method. `getID()` (FLAME GPU2's own built-in unique
  agent id) is a plain, non-templated method.

See the top of `mass_viz_flamegpu2.py` for the full citation trail (exact
file/line references into the FLAME GPU2 repo and its SWIG interface).

**Deliberately not assumed:** that agent population iteration order matches
grid (row-major x,y) order. Nothing in `AgentVector.h`/`DeviceAgentVector.h`
documents such a guarantee - unlike `mass_cuda_core`'s
`Places::downloadAttributes`, whose row-major order *is* a documented
contract (see `../cuda/README.md`). So this adapter reads each cell agent's
own x/y variables and places it into the flat array explicitly, rather than
trusting population order - verified by the smoke test described below,
which deliberately feeds cell agents in reverse order and asserts the
output is still correctly ordered by (x,y).

## Status: actually run against a real pyflamegpu install, on a real GPU

**Fully verified end-to-end.** Every API assumption in this file (the
`FLAMEGPU.agent(name).getPopulationData()` shape, `getVariableFloat`/
`getVariableUInt32`-style typed getters, plain `getID()`, the
`pyflamegpu.HostFunction` director-wrapper pattern) was confirmed directly
against a real `pyflamegpu` install and a real GPU (RTX 3080) - not just
read off headers - and `examples/flamegpu2-grid-demo/` (a `Cell` population
running a real diffusion step plus a `Walker` population doing a real
device-side random walk, both real `pyflamegpu.CUDASimulation` runs, not
stubs) produced a `.ndjson` recording checked three ways: every one of 287
events parses as valid JSON; the initial temperature field matches the
exact analytic formula at every cell of a deliberately asymmetric 16x10
grid (confirming the "don't trust population order" design choice below is
correctly implemented, not just documented); and the field's variance
measurably decreases over 40 diffusion steps (confirms the simulation is
actually running correctly on the GPU, not just plumbing data through). The
recording was also pushed through a live `mass-vis` server, where a second
browser tab joining mid-run immediately showed full state.

### Windows install: the pip wheels do not bundle what they need - here's what actually worked

`pip install --index-url https://whl.flamegpu.com pyflamegpu` was this
project's own original advice, and it is wrong in two ways, found by
actually running it:

1. **`--index-url` doesn't work at all against whl.flamegpu.com** - it's a
   static GitHub Pages site, not a PEP 503 index (`pip install
   --index-url ... pyflamegpu` with no further path returns "no versions
   found"). Use **`--extra-index-url
   https://whl.flamegpu.com/whl/cuda124/`** (or whichever CUDA/vis variant
   you want - the exact URLs are listed on the site's own homepage under
   "Using `-f, --find-links`" / "Using `--extra-index-url`", not obvious
   from the top-level URL alone).
2. **The installed wheel does not bundle CUDA, NVRTC, cuRAND, or a linker**
   despite appearances - `import pyflamegpu` fails with a DLL-not-found
   warning for `nvrtc64_*.dll` unless a full CUDA Toolkit is separately
   installed. Getting this working *without* a multi-GB Toolkit installer
   (not what this project asked for) took five separate `pip install`
   packages, one non-obvious merged-include-directory trick, and iterating
   through the actual compile/link errors one at a time:

   ```
   pip install --extra-index-url https://whl.flamegpu.com/whl/cuda124/ pyflamegpu
   pip install nvidia-cuda-nvrtc-cu12==12.4.127 nvidia-cuda-runtime-cu12==12.4.127 \
       nvidia-curand-cu12==10.3.5.147 nvidia-cuda-cccl-cu12==12.4.127.post1 \
       nvidia-nvjitlink-cu12==12.4.127
   ```

   `_pyflamegpu_env.py` in this directory (imported by
   `examples/flamegpu2-grid-demo/flamegpu2_grid_demo.py` via a `sys.path`
   insert) wraps all of this:
   adds each package's `bin/` to `os.add_dll_directory()`, and merges
   `nvidia-cuda-runtime-cu12`'s and `nvidia-cuda-cccl-cu12`'s separate
   `include/` directories into one cached combined directory pointed to by
   `CUDA_PATH` (NVRTC's JIT compiler only accepts a single include root,
   the way a real Toolkit install lays every header out together - these
   pip packages don't). **Must be imported and its `setup()` called before
   the first `import pyflamegpu` anywhere in the process** - pyflamegpu
   resolves its NVRTC DLL location at import time.

   Pin every package to the same CUDA release train as the `pyflamegpu`
   build (`cuda124` above -> the `12.4.x` line) - a version mismatch
   between these components is the kind of thing that fails obscurely
   rather than with a clear error.

   If you have a real CUDA Toolkit 12.4+ installed (the NVIDIA installer,
   not pip) instead, none of this is necessary - importing plain
   `pyflamegpu` already works once `CUDA_PATH`/`PATH` point at it.

### A real gotcha this caught: built-in agent ids are 0 until the first step actually runs

`report_initial()` (below) exists specifically because a FLAME GPU2 step
function only fires *after* each step's agent functions execute, so without
it the viewer's first frame is already post-step-1. But calling it with the
default `agent_id_variable=None` (i.e. relying on FLAME GPU2's own built-in
`AgentVector_Agent::getID()`) breaks in a specific, confirmed way: **every
agent's `getID()` reads `0` until the simulation has completed at least one
real step** (verified directly - `getID()` on a freshly-constructed host
`AgentVector`, before *and even immediately after* `sim.setPopulationData()`,
returns `0` for every agent; only after `sim.step()`/`sim.simulate()` runs
do real sequential ids appear). Called before the first step, every agent
in your mobile population looks like the same id, which then all appear to
"respawn" under new ids on the real first tick. Give your mobile-agent
population an explicit, stable id variable instead (set once at
construction) and pass `agent_id_variable`/`agent_id_type` - see
`examples/flamegpu2-grid-demo/`'s `walker_id` variable for the fix, and
`MassVizStepFunction.report_initial()`'s docstring in
`mass_viz_flamegpu2.py` for the full explanation.

Only file-based recording is implemented (`MassVizWriter` writes a local
`.ndjson` file) - not a live WebSocket connection, same limitation as the
CUDA and C++ adapters. Drop the resulting file into
`../server/recordings/<runId>.ndjson` and use the browser viewer's Replay
mode, or push it into a live run with `../benchmark/push-ndjson.js`.

## Usage

### Grid-only

```python
import pyflamegpu
from mass_viz_flamegpu2 import MassVizWriter, MassVizStepFunction

writer = MassVizWriter()
writer.open_grid("heat2d-flamegpu2-run.ndjson", "heat2d-flamegpu2-run",
                  "Heat2D (FLAME GPU2)", width, height)

step_fn = MassVizStepFunction(
    writer, width, height,
    cell_agent_name="Cell", value_variable="temperature", value_type="Float",
    x_variable="x", y_variable="y",  # must match your Cell agent's own variable names/types
)

class _MassVizHostFunction(pyflamegpu.HostFunction):
    def __init__(self, inner):
        super().__init__()
        self._inner = inner
    def run(self, FLAMEGPU):
        self._inner.run(FLAMEGPU)

model.addStepFunction(_MassVizHostFunction(step_fn))

# ... build and run the CUDASimulation as normal ...

writer.close()
```

(The two-line `_MassVizHostFunction` wrapper is needed because
`pyflamegpu.HostFunction` uses SWIG's director feature, which requires the
class actually passed to `addStepFunction` to be the `HostFunction`
subclass itself - `mass_viz_flamegpu2.py` avoids importing `pyflamegpu` at
module scope so it stays importable/testable without the real binding
installed.)

### With a mobile-agent overlay

If your model also has a separate population of agents moving *over* the
grid (the FLAME GPU2 analogue of MASS's Place/Agent split), pass
`agent_agent_name` and the position-variable names/types for that
population - `MassVizStepFunction` will report it as `agent_spawn`/
`agent_move`/`agent_remove` events on top of the grid, using each agent's
own `getID()` unless you pass `agent_id_variable`/`agent_id_type` to use a
custom id variable instead:

```python
step_fn = MassVizStepFunction(
    writer, width, height,
    cell_agent_name="Cell", value_variable="temperature", value_type="Float",
    agent_agent_name="Walker",
    agent_x_variable="x", agent_y_variable="y", agent_x_type="UInt32", agent_y_type="UInt32",
    # See "A real gotcha this caught" above - without a custom id variable,
    # report_initial() (below) sees every agent as the same id (0).
    agent_id_variable="walker_id", agent_id_type="UInt32",
)
```

See `examples/flamegpu2-grid-demo/flamegpu2_grid_demo.py` for the complete
working version, including the `walker_id` variable declaration.

### Emitting the true starting state

`MassVizStepFunction.run()` only fires after a step's agent functions have
already executed, so without an extra call the viewer's first frame is
already post-step-1. Call `report_initial()` once, with the same host-side
`pyflamegpu.AgentVector` populations you built for `sim.setPopulationData()`,
**before** `sim.simulate()`/`sim.step()`:

```python
cells = pyflamegpu.AgentVector(cell_agent_desc, width * height)
# ... populate cells ...
sim.setPopulationData(cells)
step_fn.report_initial(cells, walkers)  # before simulate()/step()
sim.simulate()
```

This works because FLAME GPU2's host-side `pyflamegpu.AgentVector` and its
device-side `DeviceAgentVector` (from `getPopulationData()`) share the
exact same per-element `AgentVector_Agent` type and typed-getter API -
confirmed directly against a real install - so `report_initial()` reuses
`run()`'s own grid-packing code unchanged.

## Build / install

No build step - `mass_viz_flamegpu2.py` is plain Python with no imports
beyond the standard library (`json`, `time`, `threading`); it does not
import `pyflamegpu` itself, so it can be copied alongside your FLAME GPU2
Python model and imported directly. `pyflamegpu` is only needed at the call
site, to subclass `pyflamegpu.HostFunction` as shown above.
