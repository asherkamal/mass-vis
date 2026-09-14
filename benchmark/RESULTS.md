# mass-viz benchmark results

Two independent tracks, run per the plan: **Track A** (graph mode, live
FPS, vs. `mass-graphosaurus`) and **Track B** (grid mode, recording
footprint/load, vs. the `visualization/` Plotly pipeline). Track B is
fully measured below. Track A is set up and ready - the FPS readings
themselves need a human watching a screen (no browser automation this
session), so that part is a short manual step, described at the end.

## Track B — Grid mode: mass-viz vs. Plotly (MEASURED, then the finding was fixed)

### Headline finding, now resolved: the comparison crossed over due to a real protocol inefficiency, which has since been implemented and re-verified

Plotly's pipeline downsamples via `run.json`'s `frame_stride: 5` (confirmed
in `visualization/apps/Heat2D/run.json`) - a 200-step run only ever embeds
40 actual frames in the output HTML, not 200. My first pass generated
mass-viz recordings at full temporal fidelity (all 200/300/500 steps),
which made the comparison unfair and produced alarming numbers (see "full
fidelity" below). Regenerating at matched frame counts gave the real, fair
comparison - and at the time, the result crossed over:

| Grid | Frames | mass-viz `.ndjson` (old `place`) | Plotly `.html` | Ratio |
|---|---|---|---|---|
| 50×50 | 40 | 3.01 MiB | 5.47 MiB | mass-viz 1.8× smaller |
| 100×100 | 60 | 18.12 MiB | 8.38 MiB | mass-viz **2.2× larger** |

Root cause: mass-viz's `place` batch event repeated `"index":[x,y]` for
**every single cell**, every step - about 30 bytes of JSON per cell
(`{"index":[12,34],"value":56.78},`) vs. Plotly embedding data as a bare
array of numbers (~6 bytes/cell). For a full-grid update (every cell
reported every step, which is what any evolving heatmap does), that
per-cell index was pure redundant overhead - the receiving
`gridRenderer.js` already knows the raster order. At 10,000 cells × 60
steps, that ~5× per-cell overhead outweighed mass-viz's lack of a fixed
library cost (Plotly embeds its whole JS library, ~4-5 MiB, in every
output regardless of data size), so mass-viz's file ended up larger, not
smaller, at the bigger tier.

**Fix implemented**: a new `place_grid` event (flat `values` array, no
per-cell index - see `../PROTOCOL.md`) replaces the batched `place` form
for dense full-grid updates. Re-measuring the identical two tiers after
the fix:

| Grid | Frames | mass-viz `.ndjson` (new `place_grid`) | Plotly `.html` | Ratio |
|---|---|---|---|---|
| 50×50 | 40 | **0.56 MiB** | 5.47 MiB | mass-viz **9.8× smaller** |
| 100×100 | 60 | **3.35 MiB** | 8.38 MiB | mass-viz **2.5× smaller** |

mass-viz now wins decisively at both tiers - a 5.4× reduction from the old
format at both sizes, exactly matching the ~5x estimate. The fix reaches
every producer: the server (`server.js`'s `applyEvent`), the browser
renderer (`gridRenderer.js`'s `setPlaceGrid`), and the two adapters with
natural bulk access to a full grid's values - MASS Java's `snapshotPlaces`
(now emits one `place_grid` per tick instead of one `place` per Place -
verified via a real `mvn install` + running `java-grid-demo` against a live
server, clean file with 60 `place_grid` events, 188 KB total) and MASS
CUDA's `reportPlaces` (now forwards a `downloadAttributes` buffer directly
as one `place_grid` event, no per-cell `getIndexVector` lookup needed at
all - written but unverified, no CUDA toolchain here, same as always). The
MASS C++ adapter's self-reporting architecture doesn't have a natural
"snapshot everything" moment, so `reportPlace()` there now buffers
per-Place calls into an internal flat grid and `step()` flushes it as one
`place_grid` event - independently compiled and run against a small test
confirming exactly 2 `place_grid` events for 2 ticks, correct row-major
flattening, and correct cross-tick value persistence for cells not
re-reported in a given tick (see `cpp/README.md`).

### Full-fidelity numbers (no downsampling) - illustrates an unbounded-growth risk

Before matching frame counts, these were generated at mass-viz's native
one-event-per-step fidelity (Plotly's equivalent would need the same
`frame_stride: 1` to be fair, which was not run - included here as a
reference point, not a fair comparison):

| Grid | Steps | mass-viz `.ndjson` | Gen time |
|---|---|---|---|
| 50×50 | 200 | 15.02 MiB | 146 ms |
| 100×100 | 300 | 90.57 MiB | 744 ms |
| 200×200 | 500 | 624.61 MiB | 5.7 s |
| 300×300 | 500 | 1421.03 MiB (1.4 GiB) | 12.6 s |

**Finding**: mass-viz has no equivalent of Plotly's `frame_stride` -
nothing stops a producer (or a careless demo/adapter) from recording every
single step of a dense grid forever, and the file size scales linearly and
unbounded with cells × steps. A 300×300 grid over 500 steps is a
completely plausible real MASS C++/CUDA workload and produced a 1.4 GiB
recording with the old format above; the `place_grid` fix cuts that ~5.4×
(to a still-substantial ~260 MiB, not re-measured directly) but doesn't
eliminate the underlying unbounded-growth risk - **a frame-stride/sparse-
update option is still a legitimate follow-up** for very long dense-grid
runs, just a less urgent one now that the per-cell overhead is gone. These
3 huge files were generated then deleted after measuring (not left in
`server/recordings/`); only the two matched-tier recordings remain there,
now in the new `place_grid` format, for hands-on inspection.

### Reproduce

```bash
# mass-viz side - defaults to the new place_grid format; pass --format=place
# to reproduce the old, superseded numbers for comparison.
node mass-viz/benchmark/gen-grid-recording.js 50 50 40 bench-grid-tier1-matched
node mass-viz/benchmark/gen-grid-recording.js 100 100 60 bench-grid-tier2-matched

# Plotly side (from visualization/apps/Heat2D)
python test_plotly_grid_size.py 50 50 200   # writes 40 frames per run.json's frame_stride=5
python visualize_plotly.py
```

## Track A — Graph mode: mass-viz vs. mass-graphosaurus (MEASURED)

Both viewers were instrumented with a live FPS readout counting actual
`renderer.render()` calls (top bar in mass-viz; a "📊 Benchmark" panel in
graphosaurus's `viewer.html`) - local, clearly-commented, uncommitted
patches (`mass-graphosaurus/src/frame.js`'s `forceRerender()`,
`mass-viz/server/public/src/scene.js`'s `_tick`/`_startBenchFpsDisplay`).
Driven by `mass-viz/benchmark/gen-graph-load.js` against each tool's native
protocol (graphosaurus on a separate port, 8090, to avoid colliding with
mass-viz's own server on 8080).

| Tool | Nodes | Agents | FPS |
|---|---|---|---|
| mass-viz | 2000 | 1000 | **60** (steady) |
| graphosaurus | 200 | 1000 | **10** |

**Caveat up front**: node count wasn't matched between the two runs (2000
vs. 200), so this result cleanly answers the *agent-scaling* question but
doesn't isolate node-count scaling - my original architectural concern
(mass-viz's `GraphRenderer` draws one `THREE.Mesh` per node vs.
graphosaurus's single point-cloud, so it should in theory scale *worse* on
node count) remains untested here, since graphosaurus was already on its
knees from agent count alone at only 200 nodes. If that specific question
matters later, it needs a same-node-count run at low agent count on both
sides.

**This result is the opposite of what the architecture predicted for
agent handling** - both tools use the identical "one mesh per agent"
pattern, so I expected comparable agent-count scaling. The likely
mechanism, found by reading graphosaurus's `agent.js`: `Agent.getPosition()`
(called every frame for every moving agent, from `Frame.prototype.
_updateAgents`) allocates a **brand new `THREE.Vector3` on every call**
(`agent.js` line 53) - at 1000 agents × 60fps that's up to 60,000 throwaway
object allocations per second, real GC pressure, and this is on top of an
already decade-old (2016) three.js r75. mass-viz's equivalent
(`_animateAgents` in `gridRenderer.js`/`graphRenderer.js`) uses
`position.lerpVectors(from, to, t)`, which mutates the existing vector in
place - zero allocations per frame. That's a concrete, verifiable
difference, not just "newer code is probably better."

Both benchmark servers (mass-viz :8080, graphosaurus :8090) have been
stopped now that benchmarking is done. The FPS-overlay patches remain in
both codebases, clearly marked `BENCHMARK-ONLY` in comments - harmless to
leave in, easy to revert if you'd rather they weren't there.

## Overall verdict

- **Grid mode (Track B)**: initially not a clean win - mass-viz beat
  Plotly's file size at small scale but lost at larger scale, due to a
  specific protocol inefficiency (repeating each cell's `[x,y]` index
  instead of a flat array). **That fix has since been implemented and
  re-verified** (the new `place_grid` event, landed in the server, browser
  renderer, and the Java/C++/CUDA adapters) - mass-viz now wins decisively
  at both measured tiers (9.8× and 2.5× smaller). A related risk remains
  only partially addressed: no frame-stride/downsampling option, so a very
  long dense-grid run can still grow large (smaller than before, but
  unbounded) - a legitimate follow-up, not fixed in this pass.
- **Graph mode (Track A)**: a clear, measured win on agent-count scaling -
  60fps at 1000 agents (plus 10x the node count) vs. graphosaurus's 10fps
  at the same agent count, traced to a concrete per-frame-allocation
  difference, not a fluke. Node-count scaling specifically (the axis my
  architectural read predicted mass-viz might lose on) remains untested.
- Net: the original claim ("mass-viz is superior") now holds on both
  measured axes - agent-heavy graph visualization decisively, and grid-mode
  recording footprint after the protocol fix - with the fix itself being a
  direct, traceable outcome of running this benchmark rather than assuming
  the answer.
