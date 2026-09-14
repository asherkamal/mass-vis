package edu.uw.bothell.css.dsl.mass.apps.vizdemo.graph;

import edu.uw.bothell.css.dsl.MASS.*;

import java.io.Serializable;

/**
 * An Agent that hops to one of its current vertex's neighbors each tick,
 * deterministically (a function of agentId and the current vertex), purely
 * to exercise mass-viz's graph renderer with visible agent migration.
 */
public class Hopper extends Agent implements Serializable {

    public static final int hop_ = 0;

    public Hopper() {
        super();
    }

    public Hopper(Object arg) {
    }

    public Object callMethod(int functionId, Object argument) {
        switch (functionId) {
            case hop_:
                return hop();
        }
        return null;
    }

    private Object hop() {
        GraphNode here = (GraphNode) getPlace();
        int[] neighbors = here.neighbors;
        if (neighbors.length > 0) {
            int choice = neighbors[Math.floorMod(getAgentId() + here.getIndex()[0], neighbors.length)];
            migrate(choice);
        }
        return null;
    }
}
