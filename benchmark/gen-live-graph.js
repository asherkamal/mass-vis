'use strict';
// Live-mode load generator for graph mode, with nothing scenario-specific:
// N vertices, each linked to a random number of uniformly random other
// vertices, sent with no positions, groups or labels so the viewer uses its
// own default layout and colors. Then A agents random-walk along edges every
// tick. The plain graph counterpart to gen-live-grid.js.
//
// Usage: node gen-live-graph.js [--nodes=10000] [--agents=2000] [--links=1-50]
//          [--run=livetest-graph] [--port=8080] [--tick=300] [--duration=0]
// --links is a min-max range (or a single number); each vertex picks its link
// count uniformly from it. --duration=0 runs until Ctrl+C.
const { parseArgs, postJson } = require('./lib');

const args = parseArgs().flags;
const N = Number(args.nodes || 10000);
const A = Number(args.agents || 2000);
const linkRange = String(args.links || '1-50').split('-').map(Number);
const M_MIN = linkRange[0];
const M_MAX = linkRange.length > 1 ? linkRange[1] : M_MIN;
const runId = args.run || 'livetest-graph';
const port = Number(args.port || 8080);
const tick = Number(args.tick || 300);
const duration = Number(args.duration || 0);

const post = (events) => postJson({ port, body: events });

async function postChunked(events, size = 1000) {
  for (let i = 0; i < events.length; i += size) await post(events.slice(i, i + size));
}

const randInt = (n) => Math.floor(Math.random() * n);

function buildGraph() {
  const adj = Array.from({ length: N }, () => new Set());
  if (N < 2) return adj.map(() => []);
  for (let i = 0; i < N; i++) {
    const want = Math.min(M_MIN + randInt(M_MAX - M_MIN + 1), N - 1);
    for (let k = 0; k < want; k++) {
      let j = randInt(N - 1);
      if (j >= i) j++; // uniform over every vertex except i
      adj[i].add(j);
      adj[j].add(i);
    }
  }
  return adj.map((s) => Array.from(s));
}

async function main() {
  console.log(`building ${N} vertices (${M_MIN}-${M_MAX} links each), ${A} agents -> run "${runId}" on :${port}`);
  const adj = buildGraph();
  const edgeCount = adj.reduce((n, l) => n + l.length, 0) / 2;
  const maxDeg = adj.reduce((m, l) => Math.max(m, l.length), 0);
  console.log(`graph: ${edgeCount} edges, max degree ${maxDeg}`);

  await post([{ v: 1, runId, type: 'init', mode: 'graph', source: 'benchmark', runName: `Live Graph ${N}n/${A}a` }]);
  await postChunked(adj.map((neighbors, i) => ({ v: 1, runId, type: 'vertex', id: String(i), neighbors: neighbors.map(String) })));

  const pos = Array.from({ length: A }, () => randInt(N));
  await postChunked(pos.map((at, i) => ({ v: 1, runId, type: 'agent_spawn', id: `a${i}`, at: String(at) })));
  // End of the initial state (structure + starting positions), before any movement.
  await post([{ v: 1, runId, type: 'step', step: -1 }]);
  console.log('built. agents walking along edges (Ctrl+C to stop)');

  const start = Date.now();
  let step = 0;
  let inFlight = false;
  const timer = setInterval(async () => {
    if (duration && Date.now() - start > duration) {
      clearInterval(timer);
      console.log('done.');
      process.exit(0);
    }
    if (inFlight) return; // don't pile up if the server can't keep up
    inFlight = true;
    const events = [];
    for (let i = 0; i < A; i++) {
      const nbrs = adj[pos[i]];
      if (nbrs.length === 0) continue;
      pos[i] = nbrs[randInt(nbrs.length)];
      events.push({ v: 1, runId, type: 'agent_move', id: `a${i}`, to: String(pos[i]) });
    }
    events.push({ v: 1, runId, type: 'step', step: step++ });
    try {
      await post(events);
    } catch (e) {
      console.error('move batch failed:', e.message);
    }
    inFlight = false;
  }, tick);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
