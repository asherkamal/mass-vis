package edu.uw.bothell.css.dsl.mass.apps.vizdemo.graph;

import edu.uw.bothell.css.dsl.MASS.*;

/**
 * A Place representing one graph vertex. Like mass_java_core's ShortestPath
 * sample (integration-tests/ShortestPath/.../Node.java), adjacency is kept
 * on the app's own field rather than through Place.addNeighbor(s) (the base
 * Place class does not require it) - here derived purely from the node's
 * own index, forming an n-node ring with a few chords, so the demo needs no
 * external topology file.
 */
public class GraphNode extends Place {

    public static final int init_ = 0;

    public int[] neighbors = new int[0];

    public GraphNode() {
        super();
    }

    public GraphNode(Object arg) {
    }

    public Object callMethod(int functionId, Object argument) {
        switch (functionId) {
            case init_:
                return init();
        }
        return null;
    }

    private Object init() {
        int id = getIndex()[0];
        int n = getSize()[0];
        int next = (id + 1) % n;
        int prev = (id - 1 + n) % n;
        if (id % 4 == 0) {
            int chord = (id + n / 2) % n;
            neighbors = new int[]{prev, next, chord};
        } else {
            neighbors = new int[]{prev, next};
        }
        setDebugData(0);
        return null;
    }
}
