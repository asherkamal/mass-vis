"""
mass-viz FLAME GPU2 adapter (grid mode only)

Feeds a FLAME GPU2 / pyflamegpu simulation's state to the mass-viz viewer
(see ../server), via the shared NDJSON protocol (../PROTOCOL.md). Grid mode
only, mirroring the MASS CUDA adapter (../cuda/mass_viz_cuda.h) as closely
as possible per ../README.md's stated intent: FLAME GPU2 is used in this
workspace to benchmark MASS CUDA, so a FLAME GPU2 run and a MASS CUDA run of
a comparable model should land in the same viewer, in the same visual
language, for a fair side-by-side - same grid-mode-only protocol, same
poll-after-a-step shape.

Why this looks different from the CUDA (C++) adapter
------------------------------------------------------
mass_cuda_core's adapter is a host-side C++ object that a driver loop calls
explicitly (openGrid/reportPlaces/step/close) because MASS CUDA has no
built-in per-tick callback hook exposed to host code beyond the driver loop
itself.

FLAME GPU2 is the opposite: it has a first-class per-tick host callback -
a "step function" - which is how this adapter is meant to be used. Per
FLAME GPU2's own confirmed API shape (read directly from
github.com/FLAMEGPU/FLAMEGPU2, master branch, since no FLAME GPU2 source or
GPU was available in the environment that authored this file):

- A Python step function is a subclass of `pyflamegpu.HostFunction`
  (SWIG-renamed from `flamegpu::HostFunctionCallback`; see
  swig/python/flamegpu.i line ~414) overriding `run(self, FLAMEGPU)`
  (`include/flamegpu/runtime/HostFunctionCallback.h`), registered once via
  `model.addStepFunction(instance)`
  (`include/flamegpu/model/ModelDescription.h`, wrapped per
  swig/python/flamegpu.i line ~555) and invoked once per simulation step -
  the same "once per tick" shape as the CUDA adapter's `step()` call site.
- Inside `run`, `FLAMEGPU.getStepCounter()` gives the current step number
  (`include/flamegpu/runtime/HostAPI.h`).
- `FLAMEGPU.agent(agent_name)` returns a `HostAgentAPI`
  (`HostAPI::agent(const std::string&, const std::string& stateName =
  ModelData::DEFAULT_STATE)`).
- `host_agent.getPopulationData()` returns a `DeviceAgentVector` - a live
  host-side view of that agent population's current device state
  (`include/flamegpu/runtime/agent/HostAgentAPI.cuh`,
  `.../DeviceAgentVector.h`). It supports Python `len(...)` and `[i]`
  indexing directly (confirmed via the `__len__`/`__getitem__` SWIG
  extensions for `DeviceAgentVector_impl` in swig/python/flamegpu.i, around
  line 823).
- Each per-agent element exposes typed variable getters - `getVariableFloat`,
  `getVariableInt`, `getVariableUInt`, etc. - one Python method per C++ type,
  because `AgentVector_Agent::getVariable<T>` is a C++ template and SWIG
  instantiates one concretely-named wrapper per type rather than exposing a
  single dynamically-typed method (see the `TEMPLATE_VARIABLE_INSTANTIATE`
  macro expansions in swig/python/flamegpu.i, ~line 909). This is why every
  "which variable/type" choice below is a constructor parameter rather than
  assumed - same philosophy as the CUDA adapter ("you choose what 'value'
  and 'agent position' mean").
- Each per-agent element also has a plain (non-templated) `getID()` -
  FLAME GPU2's own built-in unique agent id (`AgentVector_Agent::getID()`
  in include/flamegpu/simulation/AgentVector_Agent.h) - used by default for
  the optional mobile-agent overlay below, so most apps don't need to
  maintain their own id variable just for this adapter.

Deliberately NOT assumed: that `DeviceAgentVector` iteration order matches
grid (row-major x,y) order. Nothing in AgentVector.h/DeviceAgentVector.h
documents such a guarantee (unlike mass_cuda_core's
`Places::downloadAttributes`, whose row-major order is a documented contract
- see ../cuda/README.md). So this adapter reads each cell agent's own x/y
variables and places it into the flat array explicitly, at the cost of a
couple of extra typed getter calls per cell versus a raw buffer copy.

Status: written against the API shape above, confirmed directly from
FLAME GPU2's real headers and SWIG interface, and since run against a real
pyflamegpu install on a real GPU - see README.md in this directory for what
that verified and the Windows install steps it took.

Usage
-----
    import pyflamegpu
    from mass_viz_flamegpu2 import MassVizWriter, MassVizStepFunction

    writer = MassVizWriter()
    writer.open_grid("heat2d-flamegpu2-run.ndjson", "heat2d-flamegpu2-run",
                      "Heat2D (FLAME GPU2)", width, height)

    step_fn = MassVizStepFunction(
        writer, width, height,
        cell_agent_name="Cell", value_variable="temperature", value_type="Float",
        x_variable="x", y_variable="y",
        # Optional second population overlaid as moving markers, the
        # FLAME GPU2 analogue of MASS's separate Place/Agent split:
        agent_agent_name="Walker", agent_x_variable="x", agent_y_variable="y",
    )
    model.addStepFunction(step_fn)

    # ... build the CUDASimulation, sim.setPopulationData(cells[, walkers])
    # as normal, THEN before sim.simulate():
    step_fn.report_initial(cells, walkers)  # optional - see report_initial()

    sim.simulate()
    writer.close()

Only file-based recording is implemented (writes a local .ndjson file), not
a live WebSocket connection - same limitation as the CUDA and C++ adapters,
for the same reason (no way to verify a hand-rolled network client here).
Drop the resulting file into ../server/recordings/<runId>.ndjson and use the
browser viewer's Replay mode.
"""

import json
import math
import time
import threading


def _now_millis():
    return int(time.time() * 1000)


def _json_safe(value):
    """Recursively replaces non-finite floats (NaN, +/-Infinity) with None.

    Python's json.dumps writes them as bare NaN/Infinity tokens by default,
    which are not valid JSON: the server would drop the whole event, and a
    recording containing one would fail to load in the viewer. PROTOCOL.md's
    rule is `null` for any non-finite number (a diverged model is entirely
    plausible), which the viewer treats as "no value" and skips.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def _dumps(event):
    # Fast path first: the common case has no non-finite numbers, so don't
    # pay to walk a whole grid of floats on every tick just to check.
    try:
        return json.dumps(event, separators=(",", ":"), allow_nan=False)
    except ValueError:
        return json.dumps(_json_safe(event), separators=(",", ":"), allow_nan=False)


class MassVizWriter:
    """NDJSON file writer for the mass-viz protocol (../PROTOCOL.md).

    Deliberately independent of pyflamegpu - no FLAME GPU2 imports here -
    so it can be unit-tested on its own (the same way ../cpp and ../cuda's
    JSON-building helpers were) without a pyflamegpu install. Mirrors
    ../cuda/mass_viz_cuda.h's method shape (openGrid/reportPlaces/
    reportAgents/step/close) as closely as Python vs. C++ allows.
    """

    def __init__(self):
        self._file = None
        self._run_id = None
        self._lock = threading.Lock()
        self._known_agent_ids = set()

    def open_grid(self, file_path, run_id, run_name, width, height):
        with self._lock:
            self._file = open(file_path, "w", encoding="utf-8")
            self._run_id = run_id
            self._known_agent_ids = set()
        self._write({
            "v": 1, "runId": run_id, "type": "init", "t": _now_millis(),
            "mode": "grid", "dims": [width, height],
            "source": "flamegpu2", "runName": run_name,
        })

    def report_places(self, values):
        """`values[i]` must be grid cell `[x, y]` where `i = y * width + x`,
        matching PROTOCOL.md's place_grid ordering - the caller (normally
        MassVizStepFunction below) is responsible for that layout."""
        self._write({
            "v": 1, "runId": self._run_id, "type": "place_grid",
            "t": _now_millis(), "values": list(values),
        })

    def report_agents(self, agents):
        """`agents` is an iterable of (id, x, y) tuples for the current
        tick's full mobile-agent population. Diffs against the previous
        call's ids to emit agent_spawn/agent_move/agent_remove, the same
        way ../cuda/mass_viz_cuda.h's reportAgents does."""
        seen = set()
        for agent_id, x, y in agents:
            agent_id = str(agent_id)
            seen.add(agent_id)
            known = agent_id in self._known_agent_ids
            event = {
                "v": 1, "runId": self._run_id,
                "type": "agent_move" if known else "agent_spawn",
                "t": _now_millis(), "id": agent_id,
            }
            event["to" if known else "at"] = [x, y]
            self._write(event)

        for agent_id in self._known_agent_ids - seen:
            self._write({
                "v": 1, "runId": self._run_id, "type": "agent_remove",
                "t": _now_millis(), "id": agent_id,
            })

        self._known_agent_ids = seen

    def step(self, step_number):
        self._write({
            "v": 1, "runId": self._run_id, "type": "step",
            "t": _now_millis(), "step": step_number,
        })

    def close(self):
        with self._lock:
            if self._file is not None:
                self._file.close()
                self._file = None

    def _write(self, event):
        with self._lock:
            if self._file is None:
                return
            self._file.write(_dumps(event) + "\n")
            self._file.flush()


class MassVizStepFunction:
    """A FLAME GPU2 step function (see module docstring) that polls one
    "cell" agent population once per tick and reports it as a dense
    place_grid update, optionally with a second "mobile agent" population
    overlaid as moving markers - the FLAME GPU2 analogue of MASS's
    Place/Agent split.

    Call report_initial() once, before sim.simulate(), if you want the
    viewer's first frame to be the model's actual starting state rather
    than the state after step 0 already ran - see that method's docstring.

    Intended usage is `model.addStepFunction(MassVizStepFunction(...))` -
    but this class intentionally does NOT subclass `pyflamegpu.HostFunction`
    itself, so that mass_viz_flamegpu2.py can be imported and its JSON/grid-
    packing logic tested without a pyflamegpu install. Wrap it at the call
    site instead:

        import pyflamegpu

        class _MassVizHostFunction(pyflamegpu.HostFunction):
            def __init__(self, inner):
                super().__init__()
                self._inner = inner
            def run(self, FLAMEGPU):
                self._inner.run(FLAMEGPU)

        model.addStepFunction(_MassVizHostFunction(step_fn))

    (Two-line wrapper because `pyflamegpu.HostFunction` uses SWIG's director
    feature - see swig/python/flamegpu.i line ~537 - which requires the
    class actually handed to `addStepFunction` to be the `HostFunction`
    subclass itself; this file avoids importing pyflamegpu at module scope
    so it stays testable without the real binding installed.)
    """

    def __init__(self, writer, width, height,
                 cell_agent_name, value_variable, value_type,
                 x_variable="x", y_variable="y",
                 x_type="UInt32", y_type="UInt32",
                 agent_agent_name=None,
                 agent_x_variable="x", agent_y_variable="y",
                 agent_x_type="UInt32", agent_y_type="UInt32",
                 agent_id_variable=None, agent_id_type=None):
        self.writer = writer
        self.width = width
        self.height = height
        self.cell_agent_name = cell_agent_name
        self.value_variable = value_variable
        self.value_type = value_type
        self.x_variable = x_variable
        self.y_variable = y_variable
        self.x_type = x_type
        self.y_type = y_type
        self.agent_agent_name = agent_agent_name
        self.agent_x_variable = agent_x_variable
        self.agent_y_variable = agent_y_variable
        self.agent_x_type = agent_x_type
        self.agent_y_type = agent_y_type
        # None means "use FLAME GPU2's own built-in AgentVector_Agent::getID()"
        # rather than a user-defined variable - see module docstring.
        self.agent_id_variable = agent_id_variable
        self.agent_id_type = agent_id_type

    def _pack_grid(self, cells):
        """Shared by run() and report_initial() - see report_initial()'s
        docstring for why the same code works against both a live device
        population (DeviceAgentVector, from getPopulationData()) and a plain
        pre-simulation host population (pyflamegpu.AgentVector): both expose
        the identical AgentVector_Agent per-element type over len()/[i]
        (confirmed directly against a real pyflamegpu install - see
        ../README.md's Windows install section)."""
        values = [0.0] * (self.width * self.height)
        get_value = "getVariable" + self.value_type
        get_x = "getVariable" + self.x_type
        get_y = "getVariable" + self.y_type
        for i in range(len(cells)):
            cell = cells[i]
            x = getattr(cell, get_x)(self.x_variable)
            y = getattr(cell, get_y)(self.y_variable)
            index = y * self.width + x
            if 0 <= index < len(values):
                values[index] = getattr(cell, get_value)(self.value_variable)
        return values

    def _collect_agents(self, agents):
        get_ax = "getVariable" + self.agent_x_type
        get_ay = "getVariable" + self.agent_y_type
        get_id = (
            (lambda a: a.getID())
            if self.agent_id_variable is None
            else (lambda a, _m="getVariable" + self.agent_id_type,
                  _v=self.agent_id_variable: getattr(a, _m)(_v))
        )
        reported = []
        for i in range(len(agents)):
            agent = agents[i]
            reported.append((
                get_id(agent),
                getattr(agent, get_ax)(self.agent_x_variable),
                getattr(agent, get_ay)(self.agent_y_variable),
            ))
        return reported

    def report_initial(self, cell_population, agent_population=None):
        """Emits the pre-simulation (step -1, i.e. "before step 0 ran")
        state, using the SAME host-side pyflamegpu.AgentVector objects your
        driver already built to pass to sim.setPopulationData() - call this
        once, after building those populations but before sim.simulate().

        Why this exists: a FLAME GPU2 step function (run(), above) is
        FLAME GPU2's own per-tick host callback, invoked AFTER each step's
        agent functions execute (confirmed: FLAMEGPU.getStepCounter() reads
        0 on a step function's first invocation, not before step 0 runs) -
        so relying on it alone means the viewer's very first frame is
        already post-step-1, and the initial state as the model actually
        started is never seen. Unlike run(), which reads the live device
        population via FLAMEGPU.agent(name).getPopulationData(), this reads
        the plain host pyflamegpu.AgentVector(s) - the exact same object
        type and per-element API (AgentVector_Agent), so _pack_grid()/
        _collect_agents() work unchanged.

        Ends with a `step` marker numbered -1 (see ../PROTOCOL.md): without
        it these events would sit before the first real `step` and be folded
        into step 0's replay frame, so seeking to the start would show the
        state *after* step 0 and the true starting state would never be
        visible.

            cells = pyflamegpu.AgentVector(cell_agent_desc, width * height)
            # ... populate cells ...
            sim.setPopulationData(cells)
            step_fn.report_initial(cells, walkers)  # <- before sim.simulate()
            sim.simulate()

        IMPORTANT if agent_id_variable is None (the default - using FLAME
        GPU2's own built-in AgentVector_Agent::getID()): confirmed directly
        against a real pyflamegpu install that getID() reads 0 for every
        agent in a host-side AgentVector until the model has actually
        completed at least one simulation step - FLAME GPU2 assigns real
        unique ids as part of running agent functions, not at
        construction or upload time, so EVERY agent in agent_population
        looks identically id 0 here regardless of population size. Passed
        straight through, this collapses N agents into one spawn event and
        makes run()'s first real tick look like N-1 removals plus N fresh
        spawns under new ids - exactly the kind of one-off "everything
        respawned" glitch that is easy to miss in a quick look at the
        viewer. Give your mobile-agent population its own explicit id
        variable (set once, at construction, to something stable - e.g. its
        index in the population) and pass agent_id_variable/agent_id_type
        to MassVizStepFunction's constructor whenever you intend to call
        report_initial() - see ../examples/flamegpu2-grid-demo/ for a
        worked example.
        """
        self.writer.report_places(self._pack_grid(cell_population))
        if self.agent_agent_name is not None and agent_population is not None:
            self.writer.report_agents(self._collect_agents(agent_population))
        self.writer.step(-1)

    def run(self, FLAMEGPU):
        cells = FLAMEGPU.agent(self.cell_agent_name).getPopulationData()
        self.writer.report_places(self._pack_grid(cells))

        if self.agent_agent_name is not None:
            agents = FLAMEGPU.agent(self.agent_agent_name).getPopulationData()
            self.writer.report_agents(self._collect_agents(agents))

        self.writer.step(FLAMEGPU.getStepCounter())
