'use strict';
// Benchmark generator: writes a mass-viz NDJSON recording of a WxH grid
// evolving over `steps` ticks (a smooth traveling-wave heatmap, same shape
// as the Heat2D benchmark data on the Plotly side), directly into
// server/recordings/ so it's immediately loadable via Replay mode. Reports
// its own generation time and output file size for the Track B comparison.
//
// Defaults to the compact `place_grid` event (flat array, no per-cell
// index - see ../PROTOCOL.md). Pass --format=place to reproduce the old,
// verbose per-cell-indexed encoding this replaced, for size comparison.
//
// Usage: node gen-grid-recording.js <width> <height> <steps> [runId] [--format=place_grid|place]
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./lib');

const { positional, flags } = parseArgs();

const [widthArg, heightArg, stepsArg, runIdArg] = positional;
const W = Number(widthArg || 100);
const H = Number(heightArg || 100);
const STEPS = Number(stepsArg || 300);
const format = flags.format || 'place_grid';
const runId = runIdArg || `bench-grid-${W}x${H}x${STEPS}`;

if (!['place_grid', 'place'].includes(format)) {
  console.error('Unknown --format, expected place_grid or place');
  process.exit(1);
}

const RECORDINGS_DIR = process.env.MASS_VIZ_RECORDINGS_DIR || path.join(__dirname, '..', 'server', 'recordings');
const outFile = path.join(RECORDINGS_DIR, `${runId}.ndjson`);

function line(obj) {
  return JSON.stringify({ v: 1, runId, t: Date.now(), ...obj }) + '\n';
}

function valueAt(step, x, y) {
  const v = 50 + 45 * Math.sin(step * 0.15 + x * 0.2) * Math.cos(y * 0.2 - step * 0.05);
  return Math.round(v * 100) / 100;
}

const start = Date.now();
const out = fs.createWriteStream(outFile);

out.write(line({ type: 'init', mode: 'grid', dims: [W, H], source: 'benchmark', runName: `Bench ${W}x${H}x${STEPS}` }));
out.write(line({ type: 'place_range', min: 0, max: 100 }));

for (let step = 0; step < STEPS; step++) {
  if (format === 'place_grid') {
    // Flat array, row-major, x fastest-varying: values[y*W + x] - see PROTOCOL.md.
    const values = new Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        values[y * W + x] = valueAt(step, x, y);
      }
    }
    out.write(line({ type: 'place_grid', values }));
  } else {
    const places = [];
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        places.push({ index: [x, y], value: valueAt(step, x, y) });
      }
    }
    out.write(line({ type: 'place', places }));
  }
  out.write(line({ type: 'step', step }));
}

out.end(() => {
  const elapsed = Date.now() - start;
  const size = fs.statSync(outFile).size;
  console.log(`Wrote ${outFile}`);
  console.log(`  format: ${format}`);
  console.log(`  grid: ${W}x${H}, steps: ${STEPS}, cells/step: ${W * H}`);
  console.log(`  generation time: ${elapsed}ms`);
  console.log(`  file size: ${(size / 1024 / 1024).toFixed(2)} MiB (${size} bytes)`);
  console.log(`  load in viewer: Replay mode, run "${runId}"`);
});
