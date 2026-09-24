package edu.uw.bothell.css.dsl.MASS.viz;

import edu.uw.bothell.css.dsl.MASS.Agent;
import edu.uw.bothell.css.dsl.MASS.AgentList;
import edu.uw.bothell.css.dsl.MASS.AgentsBase;
import edu.uw.bothell.css.dsl.MASS.Place;
import edu.uw.bothell.css.dsl.MASS.PlacesBase;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/**
 * Facade for feeding MASS Java simulation state to a mass-viz server (or a
 * recording file), following the protocol in ../../../../../../../PROTOCOL.md.
 *
 * <p>Typical use - no changes needed to existing Place/Agent subclasses,
 * just two extra calls in the driver loop:
 *
 * <pre>{@code
 * MassViz viz = MassViz.connect("ws://localhost:8080", "heat2d-run").initGrid("Heat2D", new int[]{64, 64});
 * for (int step = 0; step < numSteps; step++) {
 *     places.callAll(FUNC_ID);
 *     places.exchangeAll(...);
 *     agents.manageAll();
 *     viz.snapshotPlaces(places, step);
 *     viz.snapshotAgents(agents, step); // also emits the step boundary marker
 * }
 * viz.close();
 * }</pre>
 *
 * <p>{@link #snapshotPlaces} / {@link #snapshotAgents} poll {@code Place.getDebugData()}
 * and diff the agent population against what was last reported, so callers
 * never track spawn/move/remove bookkeeping themselves. For finer-grained
 * (per-event rather than per-step) visualization, extend {@link VizPlace} /
 * {@link VizAgent} instead of {@code Place}/{@code Agent} - entirely optional.
 */
public final class MassViz {

    public static final String MODE_GRID = "grid";
    public static final String MODE_GRAPH = "graph";

    private static volatile MassViz DEFAULT;
    private static boolean autoConnectAttempted = false;

    private final VizClient client;
    private final String runId;
    private String mode;
    private int[] dims;

    private final Set<String> knownAgentIds = new HashSet<>();

    private MassViz(VizClient client, String runId) {
        this.client = client;
        this.runId = runId;
    }

    /** Connects to a live mass-viz server (see ../../../../../../../../server/server.js). */
    public static MassViz connect(String wsUrl, String runId) {
        return new MassViz(VizClient.connect(wsUrl), runId);
    }

    /** Records events to an NDJSON file instead of streaming live; replayable later via the viewer. */
    public static MassViz record(File file, String runId) {
        return new MassViz(VizClient.record(file), runId);
    }

    /**
     * Sets the instance that {@link VizPlace} / {@link VizAgent} lifecycle
     * callbacks forward events to. Call once at startup if using those base
     * classes; not needed when only using {@link #snapshotPlaces}/{@link #snapshotAgents}.
     */
    public static void setDefault(MassViz viz) {
        DEFAULT = viz;
    }

    /**
     * The instance {@link VizPlace}/{@link VizAgent} hooks report to. When
     * {@link #setDefault} was never called in this JVM - which is always the
     * case on a MASS worker JVM in a multi-node run, since only the driver's
     * main() runs your startup code - this connects on first use from the
     * {@code massviz.url} system property (or {@code MASSVIZ_URL} environment
     * variable), reporting into the run named by {@code massviz.runId} /
     * {@code MASSVIZ_RUN_ID} (default "mass-run") in the mode given by
     * {@code massviz.mode} / {@code MASSVIZ_MODE} ("grid", the default, or
     * "graph"). That instance never sends {@code init}: the driver's own
     * {@code initGrid}/{@code initGraph} does. Returns null (hooks do
     * nothing) if neither is configured, or the connection fails.
     */
    static MassViz getDefault() {
        MassViz viz = DEFAULT;
        if (viz != null) return viz;
        synchronized (MassViz.class) {
            if (DEFAULT != null || autoConnectAttempted) return DEFAULT;
            autoConnectAttempted = true;
            String url = setting("massviz.url", "MASSVIZ_URL");
            if (url == null) return null;
            try {
                String runId = setting("massviz.runId", "MASSVIZ_RUN_ID");
                MassViz auto = new MassViz(VizClient.connect(url), runId != null ? runId : "mass-run");
                String mode = setting("massviz.mode", "MASSVIZ_MODE");
                auto.mode = MODE_GRAPH.equals(mode) ? MODE_GRAPH : MODE_GRID;
                DEFAULT = auto;
            } catch (RuntimeException e) {
                System.err.println("[mass-viz] could not auto-connect to " + url + ": " + e.getMessage());
            }
            return DEFAULT;
        }
    }

    private static String setting(String property, String env) {
        String v = System.getProperty(property);
        if (v == null || v.isEmpty()) v = System.getenv(env);
        return v == null || v.isEmpty() ? null : v;
    }

    public MassViz initGrid(String runName, int[] dims) {
        this.mode = MODE_GRID;
        this.dims = dims;
        com.google.gson.JsonObject ev = VizEventBuilder.init(runId, MODE_GRID, runName, "mass-java");
        VizEventBuilder.addDims(ev, dims);
        client.send(ev);
        return this;
    }

    public MassViz initGraph(String runName) {
        this.mode = MODE_GRAPH;
        client.send(VizEventBuilder.init(runId, MODE_GRAPH, runName, "mass-java"));
        return this;
    }

    /**
     * Grid mode: builds one flat {@code place_grid} event covering every
     * Place ({@code values[y*width+x]}, see ../../../../../../../PROTOCOL.md) -
     * far more compact than one event per Place, since it never repeats a
     * per-cell index (measured ~5x smaller for a dense full-grid update
     * that changes every tick; see ../../../../../../../benchmark/RESULTS.md).
     * Places with a null {@link Place#getDebugData()} (or a NaN/infinite one)
     * report as JSON {@code null}, which the viewer leaves uncolored - not
     * as 0, which would drag the color scale's minimum down to 0.
     *
     * <p>Graph mode: emits one {@code place_value} scalar overlay per Place
     * (via {@link #reportPlace}), keyed by {@link #vertexIdFor}. Graph
     * <em>structure</em> (which vertices exist and their edges) is not
     * auto-discovered here - MASS's base {@code Place} class does not
     * require apps to register adjacency through it (e.g. the ShortestPath
     * sample app under mass_java_core/integration-tests keeps its own
     * neighbor array on a custom Node class rather than calling
     * {@code Place.addNeighbor(s)}), so call {@link #declareVertex}
     * yourself once per vertex during setup, from whatever adjacency data
     * your app already has.
     */
    public void snapshotPlaces(PlacesBase places, int step) {
        Place[] all = places.getPlaces();

        if (MODE_GRID.equals(mode) && dims != null) {
            double[] values = new double[dims[0] * dims[1]];
            java.util.Arrays.fill(values, Double.NaN); // sent as null: "no data", not 0
            for (Place p : all) {
                if (p == null) continue;
                Number value = p.getDebugData();
                if (value == null) continue;
                int[] idx = p.getIndex();
                int i = idx[1] * dims[0] + idx[0];
                if (i >= 0 && i < values.length) values[i] = value.doubleValue();
            }
            client.send(VizEventBuilder.placeGrid(runId, values));
            return;
        }

        for (Place p : all) {
            if (p == null) continue;
            reportPlace(p);
        }
    }

    void reportPlace(Place p) {
        Number value = p.getDebugData();
        if (value == null) return;
        if (MODE_GRAPH.equals(mode)) {
            client.send(VizEventBuilder.placeValue(runId, vertexIdFor(p), value));
        } else {
            client.send(VizEventBuilder.place(runId, p.getIndex(), value));
        }
    }

    /**
     * Graph mode only: declares one vertex and its adjacency, from whatever
     * topology data your app already maintains (see {@link #snapshotPlaces}
     * javadoc for why this isn't auto-discovered). Safe to call every step;
     * the server treats it as an idempotent upsert. {@code neighborIds}
     * should use the same id scheme as {@link #vertexIdFor} - i.e.
     * {@code String.valueOf(place.getIndex()[0])} for each neighboring Place.
     */
    public void declareVertex(String id, String name, String[] neighborIds, double[] weights) {
        client.send(VizEventBuilder.vertex(runId, id, name, neighborIds, weights));
    }

    /**
     * As {@link #declareVertex(String, String, String[], double[])}, plus the
     * optional inspector fields: {@code group} (vertices sharing one are
     * colored alike, e.g. a community) and {@code attrs} (flat scalar values
     * shown when the vertex is selected; NaN/Infinity are sent as null).
     */
    public void declareVertex(String id, String name, String[] neighborIds, double[] weights,
                              String group, java.util.Map<String, ?> attrs) {
        client.send(VizEventBuilder.vertex(runId, id, name, neighborIds, weights, group, attrs));
    }

    /**
     * Ends the initial-state report: call once after the model's starting
     * state has been sent (before the first tick runs), so a replay's first
     * frame is that starting state instead of it being folded into step 0's
     * frame. Emits {@code step -1}, see PROTOCOL.md.
     */
    public void endInitialState() {
        client.send(VizEventBuilder.step(runId, -1));
    }

    /**
     * Diffs the current agent population against what was last reported and
     * emits agent_spawn/agent_move/agent_remove accordingly, then a step
     * boundary marker - call this once per tick, after {@link #snapshotPlaces}.
     */
    public void snapshotAgents(AgentsBase agents, int step) {
        AgentList list = agents.getAgents();
        Set<String> seen = new HashSet<>();
        list.setIterator();
        while (list.hasNext()) {
            Agent a = list.next();
            if (a == null) continue;
            String id = String.valueOf(a.getAgentId());
            seen.add(id);
            Object at = positionFor(a.getIndex());
            if (knownAgentIds.add(id)) {
                client.send(VizEventBuilder.agentSpawn(runId, id, at, null, null));
            } else {
                client.send(VizEventBuilder.agentMove(runId, id, at));
            }
        }

        List<String> removed = new ArrayList<>();
        for (Iterator<String> it = knownAgentIds.iterator(); it.hasNext(); ) {
            String id = it.next();
            if (!seen.contains(id)) {
                removed.add(id);
                it.remove();
            }
        }
        for (String id : removed) client.send(VizEventBuilder.agentRemove(runId, id));

        client.send(VizEventBuilder.step(runId, step));
    }

    public void spawnAgent(String id, Object at, Integer color, String shape) {
        client.send(VizEventBuilder.agentSpawn(runId, id, at, color, shape));
        knownAgentIds.add(id);
    }

    /** As {@link #spawnAgent(String, Object, Integer, String)}, plus a display name and inspector {@code attrs}. */
    public void spawnAgent(String id, Object at, Integer color, String shape,
                           String name, java.util.Map<String, ?> attrs) {
        client.send(VizEventBuilder.agentSpawn(runId, id, at, color, shape, name, attrs));
        knownAgentIds.add(id);
    }

    public void moveAgent(String id, Object to) {
        client.send(VizEventBuilder.agentMove(runId, id, to));
    }

    public void removeAgent(String id) {
        client.send(VizEventBuilder.agentRemove(runId, id));
        knownAgentIds.remove(id);
    }

    public void step(int step) {
        client.send(VizEventBuilder.step(runId, step));
    }

    public void close() {
        client.close();
    }

    // -------------------------------------------------------- VizPlace/VizAgent hooks

    void reportAgentCreated(Agent a) {
        String id = String.valueOf(a.getAgentId());
        knownAgentIds.add(id);
        client.send(VizEventBuilder.agentSpawn(runId, id, positionFor(a.getIndex()), null, null));
    }

    void reportAgentArrived(Agent a) {
        String id = String.valueOf(a.getAgentId());
        Object at = positionFor(a.getIndex());
        if (knownAgentIds.add(id)) {
            client.send(VizEventBuilder.agentSpawn(runId, id, at, null, null));
        } else {
            client.send(VizEventBuilder.agentMove(runId, id, at));
        }
    }

    // ------------------------------------------------------------------ helpers

    /**
     * Graph mode identifies a vertex by the first component of
     * {@link Place#getIndex()} - MASS's internal one-element index for a
     * flattened (non-grid) Places array. {@link #declareVertex} callers
     * should use this same scheme for ids/neighborIds.
     */
    private String vertexIdFor(Place p) {
        return String.valueOf(p.getIndex()[0]);
    }

    private Object positionFor(int[] index) {
        if (MODE_GRAPH.equals(mode)) return String.valueOf(index[0]);
        Integer[] boxed = new Integer[index.length];
        for (int i = 0; i < index.length; i++) boxed[i] = index[i];
        return boxed;
    }
}
