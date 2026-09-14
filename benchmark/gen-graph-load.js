'use strict';
// Benchmark generator: builds a ring+chord graph of N nodes and spawns M
// agents doing continuous random-walk moves, posted to either mass-viz or
// mass-graphosaurus in each tool's own native protocol. Runs for a fixed
// duration then exits, so the on-screen FPS overlay has time to settle.
//
// Usage: node gen-graph-load.js --tool=massviz|graphosaurus --nodes=N --agents=M [--port=PORT] [--duration=20000]
// Defaults (1000 nodes, 300 agents) are already a large sample - the scale
// mass-viz was actually measured at (2000 nodes/1000 agents, steady 60fps -
// see ../benchmark/RESULTS.md's Track A) - so running this with no flags is
// a meaningful live-mode stress test, not a toy example.
const http = require('http');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const tool = args.tool || 'massviz';
const nodeCount = Number(args.nodes || 1000);
const agentCount = Number(args.agents || 300);
const port = Number(args.port || (tool === 'graphosaurus' ? 8090 : 8080));
const duration = Number(args.duration || 20000);
const moveIntervalMs = 300;

if (!['massviz', 'graphosaurus'].includes(tool)) {
  console.error('Unknown --tool, expected massviz or graphosaurus');
  process.exit(1);
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

async function postBatch(events, tool) {
  if (tool === 'massviz') {
    await post('/event', events);
  } else {
    // graphosaurus has no batch endpoint - send sequentially over HTTP.
    for (const e of events) await post('/message', e);
  }
}

async function main() {
  console.log(`[${tool}] building ${nodeCount} nodes, ${agentCount} agents on port ${port}...`);

  const runId = 'bench-graph';
  const RADIUS = Math.max(20, nodeCount * 0.15);
  const nodeIds = Array.from({ length: nodeCount }, (_, i) => String(i));

  // --- structure ---
  const structureEvents = [];
  if (tool === 'massviz') {
    structureEvents.push({ v: 1, runId, type: 'init', mode: 'graph', source: 'benchmark', runName: `Bench ${nodeCount}n/${agentCount}a` });
  }
  for (let i = 0; i < nodeCount; i++) {
    const angle = (2 * Math.PI * i) / nodeCount;
    const position = [RADIUS * Math.cos(angle), 0, RADIUS * Math.sin(angle)];
    const next = String((i + 1) % nodeCount);
    const prev = String((i + nodeCount - 1) % nodeCount);
    if (tool === 'massviz') {
      const neighbors = [next, prev];
      if (i % 7 === 0) neighbors.push(String((i + Math.floor(nodeCount / 2)) % nodeCount));
      structureEvents.push({ v: 1, runId, type: 'vertex', id: String(i), name: `n${i}`, neighbors, position });
    } else {
      structureEvents.push({ type: 'add_node', id: String(i), position, radius: RADIUS });
    }
  }
  await postBatch(structureEvents, tool);

  if (tool === 'graphosaurus') {
    // Edges are a separate message type here, and both endpoints must
    // already exist server-side, so send them after all add_node calls.
    const edgeEvents = [];
    for (let i = 0; i < nodeCount; i++) {
      edgeEvents.push({ type: 'add_edge', fromNodeId: String(i), toNodeId: String((i + 1) % nodeCount) });
      if (i % 7 === 0) {
        edgeEvents.push({ type: 'add_edge', fromNodeId: String(i), toNodeId: String((i + Math.floor(nodeCount / 2)) % nodeCount) });
      }
    }
    await postBatch(edgeEvents, tool);
  }

  // --- agents ---
  const agentIds = Array.from({ length: agentCount }, (_, i) => `a${i}`);
  const spawnEvents = agentIds.map((id) => {
    const at = nodeIds[Math.floor(Math.random() * nodeIds.length)];
    return tool === 'massviz'
      ? { v: 1, runId, type: 'agent_spawn', id, at }
      : { type: 'spawn_agent', id, nodeId: at, speed: 1.5 };
  });
  await postBatch(spawnEvents, tool);

  console.log(`[${tool}] built. Running continuous random-walk moves for ${duration / 1000}s - watch the FPS overlay now.`);

  const start = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - start > duration) {
      clearInterval(timer);
      console.log(`[${tool}] done.`);
      process.exit(0);
    }
    const moveEvents = agentIds.map((id) => {
      const to = nodeIds[Math.floor(Math.random() * nodeIds.length)];
      return tool === 'massviz'
        ? { v: 1, runId, type: 'agent_move', id, to }
        : { type: 'move_agent', agentId: id, targetNodeId: to, speed: 1.5 };
    });
    try {
      await postBatch(moveEvents, tool);
    } catch (e) {
      console.error('move batch failed:', e.message);
    }
  }, moveIntervalMs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
