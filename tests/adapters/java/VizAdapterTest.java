package edu.uw.bothell.css.dsl.MASS.viz;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Tests of the Java adapter's JSON building (package-private VizEventBuilder)
 * and of MassViz.getDefault()'s auto-connect fallback used by VizPlace/VizAgent
 * on worker JVMs. Plain main() with assertions, no test framework needed.
 *
 * Run with no arguments for the pure JSON checks; with -Dmassviz.url=... and
 * -Dmassviz.runId=... it instead checks that a JVM configured only by those
 * properties connects and delivers events (see adapters.test.js).
 */
public class VizAdapterTest {

    static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
        System.out.println("ok: " + what);
    }

    public static void main(String[] args) throws Exception {
        if (System.getProperty("massviz.url") != null) {
            autoConnect();
        } else {
            json();
            noConfig();
        }
    }

    static void json() {
        String grid = VizEventBuilder.placeGrid("r", new double[]{1.5, Double.NaN, Double.POSITIVE_INFINITY, 2}).toString();
        check(!grid.contains("NaN") && !grid.contains("Infinity") && grid.contains("\"values\":[1.5,null,null,2"), "place_grid: NaN/Infinity -> null");

        check(VizEventBuilder.place("r", new int[]{1, 2}, Double.NaN).toString().contains("\"value\":null"), "place: NaN -> null");
        check(VizEventBuilder.placeValue("r", "v", (Number) null).toString().contains("\"value\":null"), "place_value: null -> null");
        check(VizEventBuilder.placeValue("r", "v", 7).toString().contains("\"value\":7"), "place_value: ordinary numbers unchanged");

        Map<String, Object> attrs = new LinkedHashMap<>();
        attrs.put("followers", 12);
        attrs.put("score", Double.NaN);
        attrs.put("who", "bob");
        attrs.put("vip", true);
        String vertex = VizEventBuilder.vertex("r", "1", "n", new String[]{"2"}, new double[]{Double.NaN}, "c3", attrs).toString();
        check(!vertex.contains("NaN"), "vertex: no NaN anywhere");
        check(vertex.contains("\"group\":\"c3\""), "vertex: group");
        check(vertex.contains("\"attrs\":{\"followers\":12,\"score\":null,\"who\":\"bob\",\"vip\":true}"), "vertex: attrs, with NaN -> null");
        check(vertex.contains("\"weights\":[null]"), "vertex: NaN weight -> null");

        String plain = VizEventBuilder.vertex("r", "1", "n", new String[]{"2"}, null).toString();
        check(!plain.contains("group") && !plain.contains("attrs") && !plain.contains("weights"), "vertex: optional fields omitted when absent");

        String spawn = VizEventBuilder.agentSpawn("r", "a1", "5", 255, "cone", "agent-1", attrs).toString();
        check(spawn.contains("\"name\":\"agent-1\"") && spawn.contains("\"attrs\":{") && !spawn.contains("NaN"), "agent_spawn: name + attrs");
        check(VizEventBuilder.agentSpawn("r", "a1", new Integer[]{3, 4}, null, null).toString().contains("\"at\":[3,4]"), "agent_spawn: grid position");
        check(VizEventBuilder.step("r", -1).toString().contains("\"step\":-1"), "step -1 marker");
    }

    static void noConfig() {
        System.clearProperty("massviz.url");
        check(MassViz.getDefault() == null || System.getenv("MASSVIZ_URL") != null, "no configuration -> the VizPlace/VizAgent hooks are no-ops");
    }

    static void autoConnect() throws Exception {
        MassViz viz = MassViz.getDefault();
        check(viz != null, "configured only by system properties, getDefault() connects");
        viz.spawnAgent("jworker1", new Integer[]{3, 4}, null, null);
        viz.step(0);
        Thread.sleep(800);
        viz.close();
    }
}
