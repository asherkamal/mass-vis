"""
Grid-mode mass-viz demo for FLAME GPU2, exercising ../../flamegpu2/
mass_viz_flamegpu2.py against a real pyflamegpu install and a real GPU -
mirrors ../cuda-grid-demo/ and ../java-grid-demo/GridDemo.java as closely as
FLAME GPU2's own model shape allows, per ../../flamegpu2/README.md's stated
intent (a FLAME GPU2 run and a MASS CUDA run of a comparable model should
land in the same viewer, in the same visual language).

Two agent populations, the FLAME GPU2 analogue of MASS's Place/Agent split:
  - "Cell": one per grid cell (WIDTH*HEIGHT of them, static x/y) - a GPU
    analogue of ../cuda-grid-demo/HeatCell. Its per-step diffusion math is
    computed host-side between ticks (see diffuse_host() below) rather than
    via FLAME GPU2 spatial messaging, which is more machinery than this
    adapter smoke test needs; the Cell agent function below exists only so
    every Cell has an agent function each step, which FLAME GPU2 requires.
  - "Walker": a handful of mobile agents doing a deterministic pseudo-random
    walk over the same grid on the device, each tick - analogue of
    Wanderer/Walker in the other two demos.

Run (see ../../flamegpu2/README.md's "Windows install" section for what
_pyflamegpu_env.setup() papers over - the pip wheels need several NVIDIA
component packages this module locates and wires up before the first
`import pyflamegpu`):

    python flamegpu2_grid_demo.py
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "flamegpu2"))
import _pyflamegpu_env
_pyflamegpu_env.setup()  # must run before `import pyflamegpu` - see that module

import pyflamegpu
from mass_viz_flamegpu2 import MassVizWriter, MassVizStepFunction

WIDTH = 16
HEIGHT = 10
NUM_WALKERS = 5
NUM_STEPS = 40

_CELL_FN = """
FLAMEGPU_AGENT_FUNCTION(diffuse, flamegpu::MessageNone, flamegpu::MessageNone) {
    return flamegpu::ALIVE;
}
"""

_WALK_FN_TEMPLATE = """
FLAMEGPU_AGENT_FUNCTION(walk, flamegpu::MessageNone, flamegpu::MessageNone) {
    unsigned int x = FLAMEGPU->getVariable<unsigned int>("x");
    unsigned int y = FLAMEGPU->getVariable<unsigned int>("y");
    unsigned int id = (unsigned int)FLAMEGPU->getID();
    unsigned int step = FLAMEGPU->getStepCounter();
    unsigned int dir = (id * 7u + step * 3u) % 4u;
    if (dir == 0u && y + 1u < HEIGHT_CONST) y += 1u;
    else if (dir == 1u && x + 1u < WIDTH_CONST) x += 1u;
    else if (dir == 2u && y > 0u) y -= 1u;
    else if (dir == 3u && x > 0u) x -= 1u;
    FLAMEGPU->setVariable<unsigned int>("x", x);
    FLAMEGPU->setVariable<unsigned int>("y", y);
    return flamegpu::ALIVE;
}
"""


def build_model():
    model = pyflamegpu.ModelDescription("flamegpu2-grid-demo")

    cell = model.newAgent("Cell")
    cell.newVariableUInt32("x")
    cell.newVariableUInt32("y")
    cell.newVariableFloat("temperature")

    diffuse_fn = cell.newRTCFunction("diffuse", _CELL_FN)

    walker = model.newAgent("Walker")
    walker.newVariableUInt32("x")
    walker.newVariableUInt32("y")
    # A stable, explicit id, set once at construction and never touched
    # again - see MassVizStepFunction.report_initial()'s docstring for why
    # FLAME GPU2's own built-in getID() cannot be used here: it reads 0 for
    # every agent until the model has completed at least one simulation
    # step, so report_initial() (called before the first step) would see
    # every walker as id 0.
    walker.newVariableUInt32("walker_id")

    walk_src = _WALK_FN_TEMPLATE.replace("HEIGHT_CONST", str(HEIGHT) + "u").replace(
        "WIDTH_CONST", str(WIDTH) + "u"
    )
    walk_fn = walker.newRTCFunction("walk", walk_src)

    layer1 = model.newLayer()
    layer1.addAgentFunction(diffuse_fn)
    layer2 = model.newLayer()
    layer2.addAgentFunction(walk_fn)

    return model, cell, walker


def initial_cells(cell_desc):
    cells = pyflamegpu.AgentVector(cell_desc, WIDTH * HEIGHT)
    for y in range(HEIGHT):
        for x in range(WIDTH):
            i = y * WIDTH + x
            a = cells[i]
            a.setVariableUInt32("x", x)
            a.setVariableUInt32("y", y)
            # Deliberately asymmetric initial field (WIDTH != HEIGHT, and the
            # sin/cos arguments aren't interchangeable) so a transposed x/y
            # axis in the adapter's grid-packing would be visibly wrong.
            temp = 50.0 + 10.0 * math.sin(x * 0.3) * math.cos(y * 0.5)
            a.setVariableFloat("temperature", temp)
    return cells


def initial_walkers(walker_desc):
    walkers = pyflamegpu.AgentVector(walker_desc, NUM_WALKERS)
    for i, a in enumerate(walkers):
        a.setVariableUInt32("walker_id", i)
        a.setVariableUInt32("x", (i * 3) % WIDTH)
        a.setVariableUInt32("y", (i * 5) % HEIGHT)
    return walkers


def diffuse_host(values, width, height):
    """Host-side diffusion step (see build_model()'s comment on why this
    isn't done as device message-passing) - simple 4-neighbour average
    blend, Neumann boundary (edges keep their own value as the missing
    neighbour)."""
    out = [0.0] * (width * height)
    for y in range(height):
        for x in range(width):
            i = y * width + x
            neighbours = [values[i]]
            if y + 1 < height:
                neighbours.append(values[i + width])
            if y > 0:
                neighbours.append(values[i - width])
            if x + 1 < width:
                neighbours.append(values[i + 1])
            if x > 0:
                neighbours.append(values[i - 1])
            out[i] = values[i] * 0.5 + (sum(neighbours) / len(neighbours)) * 0.5
    return out


def main():
    model, cell_desc, walker_desc = build_model()

    writer = MassVizWriter()
    out_path = os.path.join(os.path.dirname(__file__), "flamegpu2-grid-demo.ndjson")
    writer.open_grid(out_path, "flamegpu2-grid-demo", "FLAME GPU2 Grid Demo", WIDTH, HEIGHT)

    step_fn_inner = MassVizStepFunction(
        writer, WIDTH, HEIGHT,
        cell_agent_name="Cell", value_variable="temperature", value_type="Float",
        x_variable="x", y_variable="y", x_type="UInt32", y_type="UInt32",
        agent_agent_name="Walker",
        agent_x_variable="x", agent_y_variable="y",
        agent_x_type="UInt32", agent_y_type="UInt32",
        # See build_model()'s comment on the Walker agent's "walker_id"
        # variable for why a custom id is needed here (report_initial()
        # runs before FLAME GPU2's own built-in getID() is assignable).
        agent_id_variable="walker_id", agent_id_type="UInt32",
    )

    class _MassVizHostFunction(pyflamegpu.HostFunction):
        def __init__(self, inner):
            super().__init__()
            self._inner = inner

        def run(self, FLAMEGPU):
            self._inner.run(FLAMEGPU)

    model.addStepFunction(_MassVizHostFunction(step_fn_inner))

    sim = pyflamegpu.CUDASimulation(model)

    cells = initial_cells(cell_desc)
    walkers = initial_walkers(walker_desc)
    sim.setPopulationData(cells)
    sim.setPopulationData(walkers)

    # Emit the true starting state (before anything has run) - see
    # MassVizStepFunction.report_initial()'s docstring for why run() alone
    # (FLAME GPU2's own per-tick hook) can never see this: it only fires
    # AFTER each step's agent functions have already executed.
    step_fn_inner.report_initial(cells, walkers)

    values = [cells[i].getVariableFloat("temperature") for i in range(WIDTH * HEIGHT)]
    for _ in range(NUM_STEPS):
        values = diffuse_host(values, WIDTH, HEIGHT)
        current = pyflamegpu.AgentVector(cell_desc)
        sim.getPopulationData(current)
        for i in range(len(current)):
            current[i].setVariableFloat("temperature", values[i])
        sim.setPopulationData(current)

        # Advances Walker's device "walk" function by one tick; this is also
        # what invokes our registered HostFunction (run(), above), which
        # reports Cell + Walker state and the step marker.
        sim.step()

    writer.close()
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
