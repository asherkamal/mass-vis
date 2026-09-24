# mass-viz Java adapter

Feeds MASS Java (`mass_java_core`) `Places`/`Agents` simulation state to the
mass-viz viewer (see `../server`), via the shared NDJSON protocol
(`../PROTOCOL.md`). This is the piece of mass-viz built as a fully working,
locally-testable slice - see `../../java` javadocs (`MassViz.java`) for the
complete API, and `../examples/java-grid-demo` / `../examples/java-graph-demo`
for runnable end-to-end apps.

## Why this exists

`mass_java_core` already ships ~90% of a remote-visualization layer that was
apparently never finished: a Gson-based `MassData` DTO package
(`PlaceData`/`AgentData`/`UpdatePackage`) explicitly labeled "For MASS
Remote Debugger" in `pom.xml`, plus `@OnCreation`/`@OnArrival`/`@OnDeparture`
lifecycle annotations dispatched via `SimpleEventDispatcher` - confirmed by
reading `event/SimpleEventDispatcher.java` and `annotations/OnCreation.java`
directly: these invoke an annotated method on the Place/Agent object itself
via reflection, wired in from `PlacesBase`/`AgentsBase` already. This
adapter is mostly finishing that plumbing rather than building new hooks
from scratch.

## Two ways to integrate

**Per-step snapshot (recommended, no class changes):**

```java
MassViz viz = MassViz.connect("ws://localhost:8080", "my-run").initGrid("My Sim", new int[]{64, 64});
for (int step = 0; step < numSteps; step++) {
    places.callAll(FUNC_ID);
    places.exchangeAll(...);
    agents.manageAll();
    viz.snapshotPlaces(places, step);
    viz.snapshotAgents(agents, step); // also emits the step boundary marker
}
viz.close();
```

`snapshotPlaces`/`snapshotAgents` poll `PlacesBase.getPlaces()`/
`AgentsBase.getAgents()` (both public - confirmed in `PlacesBase.java`/
`AgentsBase.java`) and diff the agent population against what was last
reported, so you never track spawn/move/remove bookkeeping yourself.

**Important:** `Place.getDebugData()`/`setDebugData()` are no-op stubs in
the base class (`getDebugData()` literally `return null;`, `setDebugData()`
has an empty body - "To be overridden by a developer"). They are *not*
built-in storage. Your own `Place` subclass must override both with a real
backing field, or `snapshotPlaces` will silently report nothing (this bit
`../examples/java-grid-demo`'s first working version - see `HeatCell.java`
for the fix). `Agent.getDebugData()`/`getAgentId()`/`getIndex()` don't have
this problem - they're real fields already.

Graph mode needs one more call per vertex during setup, since MASS's base
`Place` class doesn't require apps to register adjacency through it - the
real `ShortestPath` sample under `mass_java_core/integration-tests` keeps
its own neighbor array on a custom `Node` class rather than calling
`Place.addNeighbor(s)`, so `MassViz` can't auto-discover graph structure:

```java
viz.declareVertex(id, name, neighborIds, weights); // once per vertex, from your own adjacency data
```

**Per-event (optional, for finer granularity):** extend `VizPlace`/
`VizAgent` instead of `Place`/`Agent`; their `@OnCreation`/`@OnArrival`
overrides forward to `MassViz.getDefault()` automatically. Call
`MassViz.setDefault(viz)` once at startup if you use these.

**On a multi-node MASS cluster** `setDefault` in your `main()` only reaches
the driver JVM - MASS worker JVMs never run your startup code, so their
`VizPlace`/`VizAgent` hooks would find no default and silently do nothing.
When `setDefault` was never called in a JVM, `getDefault()` instead connects
on first use from the `massviz.url` system property (or `MASSVIZ_URL`
environment variable), reporting into the run named by `massviz.runId` /
`MASSVIZ_RUN_ID` (default `mass-run`), in the mode given by `massviz.mode` /
`MASSVIZ_MODE` (`grid`, the default, or `graph`). Such an auto-connected
instance never sends `init` - the driver's `initGrid`/`initGraph` does. With
none of these set the hooks stay no-ops. Verified for a single JVM by
starting it with only `-Dmassviz.url=ws://localhost:8080
-Dmassviz.runId=...` and checking the server received its events; a real
multi-node run was not tried.

**Information for the viewer's inspector** (all optional):
`declareVertex(id, name, neighborIds, weights, group, attrs)` (vertices
sharing a `group` get one color; `attrs` is a flat map shown when the vertex
is selected) and `spawnAgent(id, at, color, shape, name, attrs)`.

**Initial state**: after reporting the model's starting state and before the
first tick, call `viz.endInitialState()` (or `viz.snapshotAgents(agents, -1)`,
which emits the same `step -1` marker) so a replay's first frame is that
starting state; see `../PROTOCOL.md`.

**Non-finite numbers**: NaN and Infinity - in a Place's debug data, weights
or attrs - are sent as JSON `null`. Gson's `JsonObject.toString()` writes in
lenient mode and would otherwise emit a bare `NaN`, which is not valid JSON
(the server would drop the frame; a recording containing it would fail to
load). A Place whose debug data is `null` also reports as `null` in a grid
snapshot rather than `0`, which used to drag the color scale's minimum down.

## Status: actually built and run, not just signature-checked

Everything below was verified in this environment (Maven wasn't originally
installed, but was fetched and set up specifically to close this gap - see
Troubleshooting for exactly what that took):

- `mvn install` on `mass_java_core` (produces `mass-core-2.1.0-RELEASE.jar`) - **succeeds**
- `mvn install` on this module (`mass-viz-java`, against real `mass-core`) - **succeeds**
- `mvn compile` on both `../examples/java-grid-demo` and
  `../examples/java-graph-demo` - **succeeds**
- Running both demos end-to-end against a live `../server` instance -
  **succeeds**: `java-grid-demo` produced correct `init`/`place` (8640 =
  144 cells × 60 steps)/`agent_spawn`/`agent_move`/`step` events;
  `java-graph-demo` produced correct `init`/`vertex` (8 nodes, adjacency
  matching each node's own ring+chord neighbors)/`agent_spawn` (3)/
  `agent_move` (117 across 40 steps)/`step` events. Confirmed by reading the
  recorded `.ndjson` back from the running server, not just "no exception."

## Build

```bash
# 1. Publish mass-core locally (mass_java_core isn't on a public repo)
mvn -f ../../mass_java_core/pom.xml install -DskipTests

# 2. Publish mass-viz-java locally
mvn -f pom.xml install

# 3. Run a demo (needs a mass-viz server running - see ../server/README below)
cd ../examples/java-grid-demo && mvn exec:exec
cd ../examples/java-graph-demo && mvn exec:exec
```

(`exec:exec`, not `exec:java` - see Troubleshooting for why.)

## Troubleshooting (all hit and fixed in this environment)

**1. Maven itself wasn't installed.** Downloaded the official binary zip
from `https://dlcdn.apache.org/maven/maven-3/<version>/binaries/` and ran
it from an extracted directory - no system install needed, just put its
`bin/` on `PATH`.

**2. `mass_java_core`'s pom.xml declares a plain-HTTP repository**
(`uwb-css-release`, `http://depts.washington.edu/dslab/maven`), which
Maven 3.8.1+ blocks by default. Fix: a custom `settings.xml` with a
`<mirror>` that redefines the `maven-default-http-blocker` mirror's
`mirrorOf` to match nothing:
```xml
<mirrors>
  <mirror>
    <id>maven-default-http-blocker</id>
    <mirrorOf>dummy</mirrorOf>
    <name>Dummy to override the blocker</name>
    <url>http://0.0.0.0/</url>
  </mirror>
</mirrors>
```
Pass it with `mvn -s that-settings.xml ...`.

**3. The `unidata-all` repository (for the `edu.ucar:netcdf4` dependency)
fails TLS verification** with `PKIX path building failed` on a stock JDK
cacerts, even though its certificate (issued by InCommon, a normal CA) is
valid - the JDK's default trust store here just didn't have it. Fix: build
a copy of the JDK's `cacerts` with that one certificate imported, and point
the JVM at it:
```bash
openssl s_client -connect artifacts.unidata.ucar.edu:443 \
  -servername artifacts.unidata.ucar.edu </dev/null 2>/dev/null \
  | openssl x509 -outform PEM > unidata.crt
cp "$JAVA_HOME/lib/security/cacerts" cacerts-custom
keytool -importcert -alias unidata-artifacts -file unidata.crt \
  -keystore cacerts-custom -storepass changeit -noprompt
export MAVEN_OPTS="-Djavax.net.ssl.trustStore=/path/with/no/spaces/cacerts-custom -Djavax.net.ssl.trustStorePassword=changeit"
```
(Put `cacerts-custom` somewhere with no spaces in the path - `MAVEN_OPTS`
gets word-split on spaces when the `mvn` launcher script rebuilds its `java`
command line, so a spaces-containing path silently breaks.)

**4. Running the app itself throws
`java.lang.reflect.InaccessibleObjectException` on
`sun.nio.ch.SelectorImpl`** from deep inside `io.aeron.driver.MediaDriver`
(MASS's Aeron-based messaging layer, started by `MASS.init()` even for a
single local process). MASS's own remote-node-launch code
(`MASS.java`, building the command line for spawned worker JVMs) already
grants the fix via JVM flags - the *master*/local process just never gets
them when started as `mvn exec:java` (which runs in Maven's own JVM, too
late for JVM-startup flags). Fix: run as a real forked process with these
flags - `exec:exec` (see the two example `pom.xml`s) does this via
`--add-modules java.se --add-exports java.base/jdk.internal.ref=ALL-UNNAMED
--add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.nio=ALL-UNNAMED
--add-opens java.base/sun.nio.ch=ALL-UNNAMED --add-opens java.management/sun.management=ALL-UNNAMED
--add-opens jdk.management/com.sun.management.internal=ALL-UNNAMED`.

**5. `MASS.init(args, nProc, nThr)` calls `System.exit(-1)` silently** (no
exception, no log output unless `MASS.setLoggingLevel(LogLevel.DEBUG)` was
called first) if the node-definition file named in `args[2]` doesn't exist
or isn't readable - confirmed by reading `MASS.java`'s `init(String
nodeFilename)`. An empty file is enough for a single local process:
```xml
<nodes>
</nodes>
```
(`Nodelist`'s JAXB mapping accepts zero `<node>` entries fine; MASS
auto-creates a local master node when none is marked `<master>true</master>`.)
Both example apps ship one (`examples/java-*-demo/nodes.xml`) - `mvn
exec:exec` runs with that directory as the working directory, so the
relative `"nodes.xml"` path resolves correctly.

**6. See "Important" above** for the `getDebugData()`/`setDebugData()` gotcha
that made the grid demo silently report zero `place` events on its first
working run.
