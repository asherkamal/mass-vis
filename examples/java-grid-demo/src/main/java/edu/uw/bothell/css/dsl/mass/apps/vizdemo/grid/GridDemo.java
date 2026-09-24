package edu.uw.bothell.css.dsl.mass.apps.vizdemo.grid;

import edu.uw.bothell.css.dsl.MASS.Agents;
import edu.uw.bothell.css.dsl.MASS.MASS;
import edu.uw.bothell.css.dsl.MASS.Places;
import edu.uw.bothell.css.dsl.MASS.viz.MassViz;

/**
 * Grid-mode mass-viz demo: a small 2D Places grid (HeatCell) plus a few
 * migrating Agents (Wanderer), following the same MASS.init/Places/Agents
 * driver-loop shape as mass_java_core's ShortestPath sample
 * (integration-tests/ShortestPath), with two extra calls per tick to push
 * state to a running mass-viz server.
 *
 * Requires: mvn -f ../../../mass_java_core/pom.xml install (publishes
 * mass-core locally), then mvn -f ../../java/pom.xml install (publishes
 * mass-viz-java locally), then a mass-viz server running at localhost:8080
 * (node ../../server/server.js). See ../../README.md.
 */
public class GridDemo {

    public static void main(String[] args) throws InterruptedException {
        int width = 12;
        int height = 12;
        int numSteps = 60;

        String[] arguments = {"dslab", "ignored", "nodes.xml", "12345"};
        MASS.init(arguments, 1, 1);

        Places grid = new Places(1, HeatCell.class.getName(), null, width, height);
        grid.callAll(HeatCell.init_);

        Agents wanderers = new Agents(2, Wanderer.class.getName(), new int[]{width, height}, grid, 4);

        MassViz viz = MassViz
                .connect("ws://localhost:8080", "java-grid-demo")
                .initGrid("Java Grid Demo", new int[]{width, height});

        // The starting state, ended with a step -1 marker (snapshotAgents emits it)
        // so a replay's first frame is the true initial state (see PROTOCOL.md).
        viz.snapshotPlaces(grid, -1);
        viz.snapshotAgents(wanderers, -1);

        for (int step = 0; step < numSteps; step++) {
            grid.callAll(HeatCell.tick_, Integer.valueOf(step));
            wanderers.callAll(Wanderer.step_, Integer.valueOf(step));
            wanderers.manageAll();

            viz.snapshotPlaces(grid, step);
            viz.snapshotAgents(wanderers, step); // also emits the step marker

            Thread.sleep(150);
        }

        viz.close();
        MASS.finish();
    }
}
