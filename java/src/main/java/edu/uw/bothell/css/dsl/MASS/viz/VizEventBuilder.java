package edu.uw.bothell.css.dsl.MASS.viz;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.util.Map;

/**
 * Builds mass-viz protocol events (see ../../../../../../../../PROTOCOL.md)
 * as Gson JsonObjects, ready for VizClient to serialize and send.
 *
 * <p>Every number goes through {@link #number}/{@link #addNumber}: Gson's
 * {@code JsonObject.toString()} writes in lenient mode, so a NaN or Infinity
 * would come out as a bare {@code NaN} token - not valid JSON, so the server
 * would drop the whole event (or, in a recording, make the replay fail to
 * load). PROTOCOL.md says to send {@code null} for non-finite numbers.
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

    /** The number as a JSON element, or JSON null if it is missing, NaN or infinite. */
    static com.google.gson.JsonElement number(Number value) {
        if (value == null) return JsonNull.INSTANCE;
        double d = value.doubleValue();
        if (Double.isNaN(d) || Double.isInfinite(d)) return JsonNull.INSTANCE;
        return GSON.toJsonTree(value);
    }

    private static void addNumber(JsonObject o, String key, Number value) {
        o.add(key, number(value));
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
        addNumber(o, "value", value);
        return o;
    }

    static JsonObject placeGrid(String runId, double[] values) {
        JsonObject o = envelope(runId, "place_grid");
        JsonArray arr = new JsonArray();
        for (double v : values) arr.add(number(v));
        o.add("values", arr);
        return o;
    }

    static JsonObject vertex(String runId, String id, String name, String[] neighbors, double[] weights) {
        return vertex(runId, id, name, neighbors, weights, null, null);
    }

    /** {@code group} and {@code attrs} are the optional inspector/grouping fields, see PROTOCOL.md. */
    static JsonObject vertex(String runId, String id, String name, String[] neighbors, double[] weights,
                             String group, Map<String, ?> attrs) {
        JsonObject o = envelope(runId, "vertex");
        o.addProperty("id", id);
        o.addProperty("name", name);
        if (group != null) o.addProperty("group", group);
        if (attrs != null) o.add("attrs", attrsToJson(attrs));
        JsonArray n = new JsonArray();
        for (String s : neighbors) n.add(s);
        o.add("neighbors", n);
        if (weights != null) {
            JsonArray w = new JsonArray();
            for (double d : weights) w.add(number(d));
            o.add("weights", w);
        }
        return o;
    }

    static JsonObject placeValue(String runId, String id, Number value) {
        JsonObject o = envelope(runId, "place_value");
        o.addProperty("id", id);
        addNumber(o, "value", value);
        return o;
    }

    static JsonObject agentSpawn(String runId, String id, Object at, Integer color, String shape) {
        return agentSpawn(runId, id, at, color, shape, null, null);
    }

    static JsonObject agentSpawn(String runId, String id, Object at, Integer color, String shape,
                                 String name, Map<String, ?> attrs) {
        JsonObject o = envelope(runId, "agent_spawn");
        o.addProperty("id", id);
        o.add("at", GSON.toJsonTree(at));
        if (color != null) o.addProperty("color", color);
        if (shape != null) o.addProperty("shape", shape);
        if (name != null) o.addProperty("name", name);
        if (attrs != null) o.add("attrs", attrsToJson(attrs));
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

    /** Flat attrs map -> JSON object; numbers are NaN/Infinity-safe, anything else is written as its string form. */
    private static JsonObject attrsToJson(Map<String, ?> attrs) {
        JsonObject out = new JsonObject();
        for (Map.Entry<String, ?> e : attrs.entrySet()) {
            Object v = e.getValue();
            if (v == null) {
                out.add(e.getKey(), JsonNull.INSTANCE);
            } else if (v instanceof Number) {
                out.add(e.getKey(), number((Number) v));
            } else if (v instanceof Boolean) {
                out.addProperty(e.getKey(), (Boolean) v);
            } else {
                out.addProperty(e.getKey(), String.valueOf(v));
            }
        }
        return out;
    }
}
