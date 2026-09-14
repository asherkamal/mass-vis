package edu.uw.bothell.css.dsl.mass.apps.vizdemo.grid;

import edu.uw.bothell.css.dsl.MASS.*;

import java.io.Serializable;

/**
 * An Agent that wanders around the HeatCell grid, migrating one cell each
 * tick. Movement is deterministic (a function of agentId/step) rather than
 * random, purely so this demo is reproducible.
 */
public class Wanderer extends Agent implements Serializable {

    public static final int step_ = 0;

    private int width;
    private int height;

    public Wanderer() {
        super();
    }

    public Wanderer(Object arg) {
        int[] size = (int[]) arg;
        width = size[0];
        height = size[1];
    }

    public Object callMethod(int functionId, Object argument) {
        switch (functionId) {
            case step_:
                return step(((Integer) argument).intValue());
        }
        return null;
    }

    private Object step(int currentStep) {
        int[] idx = getPlace().getIndex();
        int dx = (Math.floorMod(getAgentId() + currentStep, 3) == 0) ? -1 : 1;
        int nx = Math.floorMod(idx[0] + dx, width);
        int ny = Math.floorMod(idx[1] + 1, height);
        migrate(nx, ny);
        return null;
    }
}
