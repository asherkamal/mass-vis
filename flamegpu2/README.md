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

## Status

Written against the API shape above, confirmed directly from FLAME GPU2's
real headers and SWIG interface - not guessed, not taken from documentation
prose (an initial pass at that, via a doc-fetching tool, repeatedly
hedged/truncated and admitted it couldn't confirm exact method names, so it
was discarded in favor of reading the actual header files from GitHub).
Compiles clean (`python -m py_compile`) and was run against a standalone
smoke test using fake stand-ins for `HostAgentAPI`/`DeviceAgentVector`/the
per-agent proxy (same spirit as `../cpp`'s standalone sample program) -
7 events across 2 ticks, every line validated as parseable JSON, correct
row-major grid packing (including with cell agents fed in reverse order),
and correct `agent_spawn`/`agent_move` inference. The smoke test itself
wasn't committed - see "Usage" below for how to reproduce it.

**Not run against a real `pyflamegpu` install or GPU** - neither was
available in the environment that authored this adapter. Per the project's
own intent (FLAME GPU2 benchmarks MASS CUDA), please build a small
FLAME GPU2 model against this adapter once a CUDA machine is available and
report back anything that doesn't compile or behave as documented -
particularly whether `getPopulationData()`'s per-variable access pattern
performs acceptably at the scale `../benchmark/RESULTS.md` tested the CUDA/
C++/Java adapters at, since that hasn't been measured here.

Only file-based recording is implemented (`MassVizWriter` writes a local
`.ndjson` file) - not a live WebSocket connection, same limitation as the
CUDA and C++ adapters and for the same reason (no way to test a hand-rolled
network client here). Drop the resulting file into
`../server/recordings/<runId>.ndjson` and use the browser viewer's Replay
mode.

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
)
```

## Build / install

No build step - `mass_viz_flamegpu2.py` is plain Python with no imports
beyond the standard library (`json`, `time`, `threading`); it does not
import `pyflamegpu` itself, so it can be copied alongside your FLAME GPU2
Python model and imported directly. `pyflamegpu` is only needed at the call
site, to subclass `pyflamegpu.HostFunction` as shown above.
