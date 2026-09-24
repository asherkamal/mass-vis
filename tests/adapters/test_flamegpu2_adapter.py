"""Tests of the FLAME GPU2 adapter's own logic, without pyflamegpu or a GPU:
its populations are duck-typed, so plain fakes stand in for them."""
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.join(HERE, "..", "..", "flamegpu2", "mass_viz_flamegpu2.py")
spec = importlib.util.spec_from_file_location("mass_viz_flamegpu2", ADAPTER)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class FakeAgent:
    def __init__(self, x, y, value=0.0, ident=0):
        self._vars = {"x": x, "y": y, "temperature": value}
        self._id = ident

    def getVariableUInt32(self, name):
        return self._vars[name]

    def getVariableFloat(self, name):
        return self._vars[name]

    def getID(self):
        return self._id


def read(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return text, [json.loads(line) for line in text.splitlines()]


class WriterTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "run.ndjson")

    def tearDown(self):
        self.dir.cleanup()

    def test_non_finite_numbers_are_written_as_null_and_the_file_is_valid_json(self):
        w = adapter.MassVizWriter()
        w.open_grid(self.path, "r", "n", 3, 1)
        w.report_places([1.5, float("nan"), float("inf")])
        w.report_places([float("-inf"), 2, 3])
        w.step(0)
        w.close()
        text, events = read(self.path)
        self.assertNotIn("NaN", text)
        self.assertNotIn("Infinity", text)
        self.assertEqual(events[1]["values"], [1.5, None, None])
        self.assertEqual(events[2]["values"], [None, 2, 3])

    def test_finite_values_are_untouched(self):
        w = adapter.MassVizWriter()
        w.open_grid(self.path, "r", "n", 2, 1)
        w.report_places([0.1, 2])
        w.close()
        _, events = read(self.path)
        self.assertEqual(events[1]["values"], [0.1, 2])

    def test_agents_are_diffed_into_spawn_move_remove(self):
        w = adapter.MassVizWriter()
        w.open_grid(self.path, "r", "n", 4, 4)
        w.report_agents([(1, 0, 0), (2, 1, 1)])
        w.report_agents([(1, 1, 0)])
        w.close()
        _, events = read(self.path)
        kinds = [(e["type"], e["id"]) for e in events[1:]]
        self.assertEqual(
            kinds,
            [("agent_spawn", "1"), ("agent_spawn", "2"), ("agent_move", "1"), ("agent_remove", "2")],
        )

    def test_init_event_describes_the_grid(self):
        w = adapter.MassVizWriter()
        w.open_grid(self.path, "run", "Name", 5, 3)
        w.close()
        _, events = read(self.path)
        self.assertEqual(events[0]["mode"], "grid")
        self.assertEqual(events[0]["dims"], [5, 3])
        self.assertEqual(events[0]["source"], "flamegpu2")


class InitialStateTests(unittest.TestCase):
    def test_report_initial_lays_cells_out_row_major_and_ends_with_step_minus_one(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "run.ndjson")
            w = adapter.MassVizWriter()
            w.open_grid(path, "r", "n", 3, 2)
            fn = adapter.MassVizStepFunction(
                w, 3, 2, cell_agent_name="Cell", value_variable="temperature", value_type="Float",
                agent_agent_name="Walker", agent_id_variable="wid", agent_id_type="UInt32",
            )
            # cells deliberately out of order: the adapter must place them by x/y, not by position
            cells = [FakeAgent(2, 1, 6.0), FakeAgent(0, 0, 1.0), FakeAgent(1, 0, 2.0),
                     FakeAgent(2, 0, 3.0), FakeAgent(0, 1, 4.0), FakeAgent(1, 1, 5.0)]
            walker = FakeAgent(1, 1)
            walker._vars["wid"] = 7
            fn.report_initial(cells, [walker])
            w.close()
            _, events = read(path)
            self.assertEqual([e["type"] for e in events], ["init", "place_grid", "agent_spawn", "step"])
            self.assertEqual(events[1]["values"], [1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
            self.assertEqual(events[2]["id"], "7")
            self.assertEqual(events[2]["at"], [1, 1])
            self.assertEqual(events[3]["step"], -1)


if __name__ == "__main__":
    unittest.main()
