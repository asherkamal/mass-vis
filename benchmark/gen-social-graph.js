'use strict';
// Social-network-style graph load for mass-viz.
//
// N users are split into C communities of skewed sizes. Inside a community,
// new users link to existing members by preferential attachment (so a few
// hubs emerge, as in real social graphs); a small share of links cross
// communities. Each vertex carries a `group` (its community), a `label` and
// `attrs` (followers), and is positioned in a cluster around its community's
// center with hubs pulled toward the middle, so the graph reads as distinct
// clusters instead of a solid ball.
//
// Then A agents spread "topics" by walking along edges to a random neighbor every
// tick. Each agent has a name and a `topic` attribute (its color); each node's
// `place_value` is its running visit count, so busy spots show up when the
// viewer's color mode is set to "value".
//
// Usage: node gen-social-graph.js [--nodes=10000] [--agents=2000] [--links=3]
//          [--communities=<N/250>] [--run=social] [--port=8080] [--tick=300]
//          [--duration=0]
// --duration=0 runs until Ctrl+C.
const { parseArgs, postJson } = require('./lib');

const args = parseArgs().flags;
const N = Number(args.nodes || 10000);
const A = Number(args.agents || 2000);
const M = Number(args.links || 3);
const C = Math.max(1, Number(args.communities || Math.max(4, Math.round(N / 250))));
const runId = args.run || 'social';
const port = Number(args.port || 8080);
const tick = Number(args.tick || 300);
const duration = Number(args.duration || 0);
const CROSS_LINK_PROB = 0.1; // share of a new user's links that leave its community

const TOPICS = [
  { name: 'sports', color: 0xf2994a },
  { name: 'music', color: 0x56ccf2 },
  { name: 'news', color: 0xeb5757 },
  { name: 'gaming', color: 0xbb6bd9 },
  { name: 'food', color: 0x6fcf97 },
];

const post = (events) => postJson({ port, body: events });

async function postChunked(events, size = 1000) {
  for (let i = 0; i < events.length; i += size) await post(events.slice(i, i + size));
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function gaussian() {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Skewed community sizes (a few big communities, many small ones).
function assignCommunities() {
  const weights = Array.from({ length: C }, (_, i) => 1 / Math.pow(i + 1, 0.7));
  const total = weights.reduce((a, b) => a + b, 0);
  const cumulative = [];
  let acc = 0;
  for (const w of weights) cumulative.push((acc += w / total));
  return Array.from({ length: N }, () => {
    const r = Math.random();
    const c = cumulative.findIndex((x) => r <= x);
    return c === -1 ? C - 1 : c;
  });
}

// Preferential attachment: each pool holds one entry per edge endpoint, so a
// uniform pick from it is a pick proportional to degree.
function buildGraph(comm) {
  const adj = Array.from({ length: N }, () => new Set());
  const globalPool = [];
  const commPool = Array.from({ length: C }, () => []);
  const commMembers = Array.from({ length: C }, () => []);

  const link = (a, b) => {
    if (a === b || adj[a].has(b)) return;
    adj[a].add(b);
    adj[b].add(a);
    globalPool.push(a, b);
    commPool[comm[a]].push(a);
    commPool[comm[b]].push(b);
  };

  for (let i = 0; i < N; i++) {
    const c = comm[i];
    const members = commMembers[c];
    const mine = commPool[c];
    if (i > 0) {
      const want = Math.min(M, i);
      for (let k = 0; k < want; k++) {
        const cross = Math.random() < CROSS_LINK_PROB || (members.length === 0 && globalPool.length === 0);
        let target;
        if (!cross && members.length > 0) {
          target = mine.length > 0 ? pick(mine) : pick(members);
        } else if (globalPool.length > 0) {
          target = pick(globalPool);
        } else {
          target = 0;
        }
        link(i, target);
      }
      if (adj[i].size === 0) link(i, Math.floor(Math.random() * i)); // never leave a user isolated
    }
    members.push(i);
  }
  return adj.map((s) => Array.from(s));
}

// Community centers on a large sphere; members Gaussian around the center,
// hubs pulled toward it.
function layout(adj, comm) {
  const R = 40 * Math.sqrt(C);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const centers = Array.from({ length: C }, (_, i) => {
    const y = C === 1 ? 0 : 1 - (i / (C - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    return [Math.cos(golden * i) * r * R, y * R, Math.sin(golden * i) * r * R];
  });
  const size = new Array(C).fill(0);
  for (const c of comm) size[c]++;
  return adj.map((nbrs, i) => {
    const c = comm[i];
    const sigma = 2.2 * Math.cbrt(Math.max(1, size[c]));
    const pull = Math.max(0.15, 2 / (1 + nbrs.length / 3));
    return centers[c].map((x) => x + gaussian() * sigma * pull);
  });
}

async function main() {
  console.log(`building ${N} users in ${C} communities (~${M} links each), ${A} agents -> run "${runId}" on :${port}`);
  const comm = assignCommunities();
  const adj = buildGraph(comm);
  const positions = layout(adj, comm);
  const edgeCount = adj.reduce((n, l) => n + l.length, 0) / 2;
  const maxDeg = adj.reduce((m, l) => Math.max(m, l.length), 0);
  console.log(`graph: ${edgeCount} edges, max degree ${maxDeg}`);

  await post([{ v: 1, runId, type: 'init', mode: 'graph', source: 'benchmark', runName: `Social ${N}n/${A}a` }]);

  await postChunked(
    adj.map((neighbors, i) => ({
      v: 1,
      runId,
      type: 'vertex',
      id: String(i),
      label: `user-${i}`,
      group: `c${comm[i]}`,
      attrs: { followers: neighbors.length },
      neighbors: neighbors.map(String),
      position: positions[i].map((x) => Math.round(x * 100) / 100),
    }))
  );

  const pos = Array.from({ length: A }, () => Math.floor(Math.random() * N));
  await postChunked(
    pos.map((at, i) => {
      const topic = TOPICS[i % TOPICS.length];
      return {
        v: 1,
        runId,
        type: 'agent_spawn',
        id: `a${i}`,
        at: String(at),
        name: `agent-${i}`,
        color: topic.color,
        attrs: { topic: topic.name },
      };
    })
  );
  // End of the initial state (structure + starting positions), before any movement.
  await post([{ v: 1, runId, type: 'step', step: -1 }]);
  console.log('built. agents walking along edges (Ctrl+C to stop)');

  const visits = new Array(N).fill(0);
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
    const touched = new Set();
    for (let i = 0; i < A; i++) {
      const nbrs = adj[pos[i]];
      pos[i] = nbrs[Math.floor(Math.random() * nbrs.length)];
      visits[pos[i]]++;
      touched.add(pos[i]);
      events.push({ v: 1, runId, type: 'agent_move', id: `a${i}`, to: String(pos[i]) });
    }
    for (const n of touched) events.push({ v: 1, runId, type: 'place_value', id: String(n), value: visits[n] });
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
