package edu.uw.bothell.css.dsl.MASS.viz;

import edu.uw.bothell.css.dsl.MASS.Place;
import edu.uw.bothell.css.dsl.MASS.annotations.OnCreation;

/**
 * Optional base class for a MASS Java application's Place subclass. Extend
 * this instead of {@link Place} to get this place reported to mass-viz the
 * moment it is created, via MASS's existing {@code @OnCreation} lifecycle
 * hook (see edu.uw.bothell.css.dsl.MASS.event.EventDispatcher) - no core
 * changes required.
 *
 * <p>Requires {@link MassViz#setDefault(MassViz)} to have been called once
 * at startup. Most applications don't need this: calling
 * {@link MassViz#snapshotPlaces} once per simulation tick from the driver
 * loop is simpler and needs no class changes at all. This class exists for
 * apps that want a place visualized immediately on creation rather than
 * waiting for the next per-step snapshot.
 */
public class VizPlace extends Place {

    @OnCreation
    public void onVizCreation() {
        MassViz viz = MassViz.getDefault();
        if (viz != null) viz.reportPlace(this);
    }
}
