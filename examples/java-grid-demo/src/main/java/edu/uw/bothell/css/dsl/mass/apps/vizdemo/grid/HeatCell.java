package edu.uw.bothell.css.dsl.mass.apps.vizdemo.grid;

import edu.uw.bothell.css.dsl.MASS.*;

/**
 * A Place on a 2D grid whose "temperature" debug value evolves each tick
 * into a traveling wave, purely as a function of its own index and the
 * current step - no exchangeAll/neighbor messaging needed, since this demo
 * exists only to exercise mass-viz's grid renderer end-to-end.
 */
public class HeatCell extends Place {

    public static final int init_ = 0;
    public static final int tick_ = 1;

    public Object callMethod(int functionId, Object argument) {
        switch (functionId) {
            case init_:
                return init();
            case tick_:
                return tick(((Integer) argument).intValue());
        }
        return null;
    }

    private double temperature = 0;

    public HeatCell() {
        super();
    }

    public HeatCell(Object arg) {
    }

    // Place.getDebugData()/setDebugData() are no-op stubs in the base class
    // ("To be overridden by a developer" - they don't store anything on
    // their own, confirmed by reading Place.java directly), so a real field
    // backing them is required for MassViz.snapshotPlaces to see anything.
    @Override
    public Number getDebugData() {
        return temperature;
    }

    @Override
    public void setDebugData(Number argument) {
        temperature = argument.doubleValue();
    }

    private Object init() {
        setDebugData(20.0);
        return null;
    }

    private Object tick(int step) {
        int[] idx = getIndex();
        double value = 50 + 45 * Math.sin(step * 0.15 - idx[0] * 0.4) * Math.cos(idx[1] * 0.3);
        setDebugData(value);
        return null;
    }
}
