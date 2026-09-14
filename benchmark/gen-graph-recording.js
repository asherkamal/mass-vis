'use strict';
// Writes a mass-viz NDJSON graph-mode recording directly to
// server/recordings/, for Replay-mode testing at scale - the graph-mode
// counterpart to gen-grid-recording.js. A ring-plus-chords topology (each
// node also connects to the one opposite it every 8th node), with agents
// doing a deterministic walk around the ring so the recording has clean,
// verifiable structure and motion at whatever scale you ask for.
//
// Usage: node gen-graph-recording.js <nodeCount> <agentCount> <steps> [runId]
const fs = require('fs');
const path = require('path');

const [, , nodeCountArg, agentCountArg, stepsArg, runIdArg] = process.argv;
const N = Number(nodeCountArg || 1000);
const AGENTS = Number(agentCountArg || 100);
const STEPS = Number(stepsArg || 300);
const runId = runIdArg || `graph-replay-${N}n-${AGENTS}a-${STEPS}s`;

const RECORDINGS_DIR = path.join(__dirname, '..', 'server', 'recordings');
const outFile = path.join(RECORDINGS_DIR, `${runId}.ndjson`);
const RADIUS = Math.max(20, N * 0.08);

function line(obj) {
  return JSON.stringify({ v: 1, runId, t: Date.now(), ...obj }) + '\n';
}

const start = Date.now();
const out = fs.createWriteStream(outFile);

out.write(line({ type: 'init', mode: 'graph', source: 'benchmark', runName: `Graph Replay ${N}n/${AGENTS}a/${STEPS}s` }));
out.write(line({ type: 'place_range', min: 0, max: N - 1 }));

for (let i = 0; i < N; i++) {
  const angle = (2 * Math.PI * i) / N;
  const position = [RADIUS * Math.cos(angle), 0, RADIUS * Math.sin(angle)];
  const neighbors = [String((i + 1) % N), String((i + N - 1) % N)];
  if (i % 8 === 0) neighbors.push(String((i + Math.floor(N / 2)) % N));
  out.write(line({ type: 'vertex', id: String(i), name: `n${i}`, neighbors, position }));
  out.write(line({ type: 'place_value', id: String(i), value: i }));
}

const agentIds = Array.from({ length: AGENTS }, (_, i) => `a${i}`);
const startPos = agentIds.map((_, i) => Math.floor((i * N) / AGENTS));
agentIds.forEach((id, i) => {
  out.write(line({ type: 'agent_spawn', id, at: String(startPos[i]) }));
});

for (let step = 0; step < STEPS; step++) {
  agentIds.forEach((id, i) => {
    const pos = (startPos[i] + step + 1) % N;
    out.write(line({ type: 'agent_move', id, to: String(pos) }));
  });
  out.write(line({ type: 'step', step }));
}

out.end(() => {
  const elapsed = Date.now() - start;
  const size = fs.statSync(outFile).size;
  console.log(`Wrote ${outFile}`);
  console.log(`  nodes: ${N}, agents: ${AGENTS}, steps: ${STEPS}`);
  console.log(`  generation time: ${elapsed}ms`);
  console.log(`  file size: ${(size / 1024 / 1024).toFixed(2)} MiB (${size} bytes)`);
  console.log(`  load in viewer: Replay mode, run "${runId}"`);
});
