package edu.uw.bothell.css.dsl.MASS.viz;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Builds mass-viz protocol events (see ../../../../../../../../PROTOCOL.md)
 * as Gson JsonObjects, ready for VizClient to serialize and send.
 */
final class VizEventBuilder {

    private static final Gson GSON = new GsonBuilder().create();

    private VizEventBuilder() {
    }

    private static JsonObject envelope(String runId, String type) {
        JsonObject o = new JsonObject();
        o.addProperty("v", 1);
        o.addProperty("runId", runId);
        o.addProperty("type", type);
        o.addProperty("t", System.currentTimeMillis());
        return o;
    }

    static JsonObject init(String runId, String mode, String runName, String source) {
        JsonObject o = envelope(runId, "init");
        o.addProperty("mode", mode);
        o.addProperty("runName", runName);
        o.addProperty("source", source);
        return o;
    }

    static void addDims(JsonObject init, int[] dims) {
        JsonArray arr = new JsonArray();
        for (int d : dims) arr.add(d);
        init.add("dims", arr);
    }

    static JsonObject place(String runId, int[] index, Number value) {
        JsonObject o = envelope(runId, "place");
        JsonArray arr = new JsonArray();
        for (int i : index) arr.add(i);
        o.add("index", arr);
        o.addProperty("value", value);
        return o;
    }

    static JsonObject placeGrid(String runId, double[] values) {
        JsonObject o = envelope(runId, "place_grid");
        JsonArray arr = new JsonArray();
        for (double v : values) arr.add(v);
        o.add("values", arr);
        return o;
    }

    static JsonObject vertex(String runId, String id, String name, String[] neighbors, double[] weights) {
        JsonObject o = envelope(runId, "vertex");
        o.addProperty("id", id);
        o.addProperty("name", name);
        JsonArray n = new JsonArray();
        for (String s : neighbors) n.add(s);
        o.add("neighbors", n);
        if (weights != null) {
            JsonArray w = new JsonArray();
            for (double d : weights) w.add(d);
            o.add("weights", w);
        }
        return o;
    }

    static JsonObject placeValue(String runId, String id, Number value) {
        JsonObject o = envelope(runId, "place_value");
        o.addProperty("id", id);
        o.addProperty("value", value);
        return o;
    }

    static JsonObject agentSpawn(String runId, String id, Object at, Integer color, String shape) {
        JsonObject o = envelope(runId, "agent_spawn");
        o.addProperty("id", id);
        o.add("at", GSON.toJsonTree(at));
        if (color != null) o.addProperty("color", color);
        if (shape != null) o.addProperty("shape", shape);
        return o;
    }

    static JsonObject agentMove(String runId, String id, Object to) {
        JsonObject o = envelope(runId, "agent_move");
        o.addProperty("id", id);
        o.add("to", GSON.toJsonTree(to));
        return o;
    }

    static JsonObject agentRemove(String runId, String id) {
        JsonObject o = envelope(runId, "agent_remove");
        o.addProperty("id", id);
        return o;
    }

    static JsonObject step(String runId, int step) {
        JsonObject o = envelope(runId, "step");
        o.addProperty("step", step);
        return o;
    }
}
