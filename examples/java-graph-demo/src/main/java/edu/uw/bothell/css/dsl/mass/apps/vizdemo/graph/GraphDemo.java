package edu.uw.bothell.css.dsl.mass.apps.vizdemo.graph;

import edu.uw.bothell.css.dsl.MASS.Agents;
import edu.uw.bothell.css.dsl.MASS.MASS;
import edu.uw.bothell.css.dsl.MASS.Place;
import edu.uw.bothell.css.dsl.MASS.Places;
import edu.uw.bothell.css.dsl.MASS.viz.MassViz;

/**
 * Graph-mode mass-viz demo: a small ring-plus-chords graph of Places
 * (GraphNode) plus a few Agents (Hopper) migrating vertex-to-vertex,
 * following the same MASS.init/Places/Agents driver-loop shape as
 * mass_java_core's ShortestPath sample, with graph structure declared to
 * mass-viz once at setup and agent positions snapshotted every tick.
 *
 * Requires: mvn -f ../../../mass_java_core/pom.xml install (publishes
 * mass-core locally), then mvn -f ../../java/pom.xml install (publishes
 * mass-viz-java locally), then a mass-viz server running at localhost:8080
 * (node ../../server/server.js). See ../../README.md.
 */
public class GraphDemo {

    public static void main(String[] args) throws InterruptedException {
        int nNodes = 8;
        int numSteps = 40;

        String[] arguments = {"dslab", "ignored", "nodes.xml", "12345"};
        MASS.init(arguments, 1, 1);

        Places graph = new Places(1, GraphNode.class.getName(), null, nNodes);
        graph.callAll(GraphNode.init_);

        Agents hoppers = new Agents(2, Hopper.class.getName(), null, graph, 3);

        MassViz viz = MassViz
                .connect("ws://localhost:8080", "java-graph-demo")
                .initGraph("Java Graph Demo");

        // Declare graph structure once, from each node's own adjacency -
        // MassViz does not auto-discover this (see MassViz.snapshotPlaces javadoc).
        for (Place p : graph.getPlaces()) {
            GraphNode node = (GraphNode) p;
            int id = node.getIndex()[0];
            String[] neighborIds = new String[node.neighbors.length];
            for (int i = 0; i < node.neighbors.length; i++) {
                neighborIds[i] = String.valueOf(node.neighbors[i]);
            }
            // label + inspector attrs: shown when the vertex is selected in the viewer
            viz.declareVertex(String.valueOf(id), "node-" + id, neighborIds, null,
                    null, java.util.Map.of("connections", neighborIds.length));
        }

        // The starting positions, ended with a step -1 marker so a replay's
        // first frame is the true initial state rather than being folded
        // into step 0 (see PROTOCOL.md).
        viz.snapshotAgents(hoppers, -1);

        for (int step = 0; step < numSteps; step++) {
            hoppers.callAll(Hopper.hop_, Integer.valueOf(step));
            hoppers.manageAll();

            viz.snapshotAgents(hoppers, step); // also emits the step marker

            Thread.sleep(200);
        }

        viz.close();
        MASS.finish();
    }
}
