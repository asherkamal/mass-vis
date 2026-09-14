package edu.uw.bothell.css.dsl.MASS.viz;

import edu.uw.bothell.css.dsl.MASS.Agent;
import edu.uw.bothell.css.dsl.MASS.annotations.OnArrival;
import edu.uw.bothell.css.dsl.MASS.annotations.OnCreation;

/**
 * Optional base class for a MASS Java application's Agent subclass. Extend
 * this instead of {@link Agent} to get spawn/move events reported to
 * mass-viz automatically as the agent is created and migrates, via MASS's
 * existing {@code @OnCreation}/{@code @OnArrival} lifecycle hooks - no core
 * changes required.
 *
 * <p>Requires {@link MassViz#setDefault(MassViz)} to have been called once
 * at startup. Most applications don't need this: calling
 * {@link MassViz#snapshotAgents} once per simulation tick from the driver
 * loop is simpler, needs no class changes, and already diffs spawn/move/
 * remove automatically. This class exists for apps that want an agent's
 * movement visualized the instant it happens rather than on the next
 * per-step snapshot.
 */
public class VizAgent extends Agent {

    @OnCreation
    public void onVizCreation() {
        MassViz viz = MassViz.getDefault();
        if (viz != null) viz.reportAgentCreated(this);
    }

    @OnArrival
    public void onVizArrival() {
        MassViz viz = MassViz.getDefault();
        if (viz != null) viz.reportAgentArrived(this);
    }
}
