'use strict';
// Live-mode load generator for grid mode: sends init + place_range once,
// spawns a few agents, then repeatedly posts a full recomputed place_grid
// event (a traveling-wave heatmap) plus agent moves at a steady interval -
// a continuous live simulation to watch update in real time, at whatever
// scale you ask for. Runs for a fixed duration then exits.
//
// Usage: node gen-live-grid.js <width> <height> [durationMs] [intervalMs] [runId] [--port=8080]
const { parseArgs, postJson } = require('./lib');

const { positional, flags } = parseArgs();
const [widthArg, heightArg, durationArg, intervalArg, runIdArg] = positional;
const port = Number(flags.port || 8080);
const W = Number(widthArg || 100);
const H = Number(heightArg || 100);
const DURATION = Number(durationArg || 30000);
const INTERVAL = Number(intervalArg || 500);
const runId = runIdArg || 'livetest-grid';

const post = (body) => postJson({ port, body });

function gridValues(t) {
  const values = new Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      values[y * W + x] = Math.round((50 + 45 * Math.sin(t * 0.3 + x * 0.15) * Math.cos(t * 0.2 + y * 0.15)) * 100) / 100;
    }
  }
  return values;
}

async function main() {
  console.log(`[live-grid] ${W}x${H} = ${W * H} cells, runId="${runId}", running for ${DURATION / 1000}s...`);

  await post({ v: 1, runId, type: 'init', mode: 'grid', dims: [W, H], source: 'benchmark', runName: `Live ${W}x${H}` });
  await post({ v: 1, runId, type: 'place_range', min: 0, max: 100 });

  const agentCount = 5;
  const agentIds = Array.from({ length: agentCount }, (_, i) => `a${i}`);
  for (const id of agentIds) {
    await post({ v: 1, runId, type: 'agent_spawn', id, at: [Math.floor(Math.random() * W), Math.floor(Math.random() * H)] });
  }

  const start = Date.now();
  let tick = 0;
  const timer = setInterval(async () => {
    if (Date.now() - start > DURATION) {
      clearInterval(timer);
      console.log('[live-grid] done.');
      process.exit(0);
    }
    tick++;
    const t = tick * 0.15;
    const payload = [{ v: 1, runId, type: 'place_grid', values: gridValues(t) }];
    for (const id of agentIds) {
      payload.push({ v: 1, runId, type: 'agent_move', id, to: [Math.floor(Math.random() * W), Math.floor(Math.random() * H)] });
    }
    payload.push({ v: 1, runId, type: 'step', step: tick });
    try {
      await post(payload);
    } catch (e) {
      console.error('tick failed:', e.message);
    }
  }, INTERVAL);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
