// The benchmark/load generators and push-ndjson, run for real against a real
// server, with their output checked for correctness (not just "it ran").
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunConnection } from '../server/public/src/connection.js';
import { RunState } from '../server/public/src/runState.js';
import { ROOT, getText, parseNdjson, sleep, startServer, waitFor, watch } from './helpers.js';

const script = (name) => path.join(ROOT, 'benchmark', name);

function run(file, args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [file, ...args], { env: { ...process.env, ...env }, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)} failed: ${err.message}\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

const recording = async (server, runId) => parseNdjson((await getText(server, `/recordings/${runId}.ndjson`)).text);

describe('gen-social-graph.js', () => {
  let server;
  let events;
  const N = 300;
  const A = 40;
  before(async () => {
    server = await startServer();
    await run(script('gen-social-graph.js'), [`--nodes=${N}`, `--agents=${A}`, '--duration=1500', '--tick=40', '--run=soc', `--port=${server.port}`]);
    events = await recording(server, 'soc');
  });
  after(() => server.cleanup());

  test('sends init, every vertex with label/group/attrs/position, the agents, then step -1', () => {
    assert.equal(events[0].type, 'init');
    assert.equal(events[0].mode, 'graph');
    const firstStep = events.findIndex((e) => e.type === 'step');
    assert.equal(events[firstStep].step, -1);
    const vertices = events.slice(0, firstStep).filter((e) => e.type === 'vertex');
    assert.equal(vertices.length, N);
    for (const v of vertices) {
      assert.match(v.label, /^user-\d+$/);
      assert.match(v.group, /^c\d+$/);
      assert.equal(v.attrs.followers, v.neighbors.length);
      assert.equal(v.position.length, 3);
      assert.ok(v.position.every(Number.isFinite));
      assert.ok(v.neighbors.length >= 1, 'no isolated users');
    }
    const spawns = events.slice(0, firstStep).filter((e) => e.type === 'agent_spawn');
    assert.equal(spawns.length, A);
    assert.ok(spawns.every((s) => s.name && s.attrs.topic && Number.isInteger(s.color)));
  });

  test('the graph is undirected, has no self-loops, and forms communities with hubs', () => {
    const adj = new Map(events.filter((e) => e.type === 'vertex').map((v) => [v.id, new Set(v.neighbors)]));
    for (const [id, nbrs] of adj) {
      assert.ok(!nbrs.has(id), 'no self-loop');
      for (const n of nbrs) assert.ok(adj.get(n).has(id), `edge ${id}-${n} is reciprocal`);
    }
    const group = new Map(events.filter((e) => e.type === 'vertex').map((v) => [v.id, v.group]));
    let within = 0;
    let total = 0;
    for (const [id, nbrs] of adj) for (const n of nbrs) (total++, group.get(id) === group.get(n) && within++);
    assert.ok(within / total > 0.7, `mostly within-community links (${(within / total).toFixed(2)})`);
    const degrees = [...adj.values()].map((s) => s.size).sort((a, b) => a - b);
    assert.ok(degrees[degrees.length - 1] > 4 * degrees[Math.floor(degrees.length / 2)], 'a heavy-tailed degree distribution (hubs)');
  });

  test('every agent move follows an edge, steps are consecutive, and visit counts add up', () => {
    const adj = new Map(events.filter((e) => e.type === 'vertex').map((v) => [v.id, new Set(v.neighbors)]));
    const pos = new Map(events.filter((e) => e.type === 'agent_spawn').map((s) => [s.id, s.at]));
    const visits = new Map();
    let lastStep = -1;
    let moves = 0;
    for (const e of events) {
      if (e.type === 'agent_move') {
        assert.ok(adj.get(pos.get(e.id)).has(e.to), `${e.id}: ${pos.get(e.id)} -> ${e.to} is an edge`);
        pos.set(e.id, e.to);
        visits.set(e.to, (visits.get(e.to) || 0) + 1);
        moves++;
      } else if (e.type === 'place_value') {
        assert.equal(e.value, visits.get(e.id), `place_value of ${e.id} equals its arrivals so far`);
      } else if (e.type === 'step' && e.step >= 0) {
        assert.equal(e.step, lastStep + 1, 'consecutive steps');
        lastStep = e.step;
      }
    }
    assert.ok(lastStep >= 5, `ran ${lastStep + 1} steps`);
    assert.equal(moves, A * (lastStep + 1), 'every agent moves every step');
  });

  test('running it again archives the first recording instead of appending', async () => {
    await run(script('gen-social-graph.js'), ['--nodes=50', '--agents=5', '--duration=300', '--tick=40', '--run=soc', `--port=${server.port}`]);
    const files = fs.readdirSync(server.dir).filter((f) => f.startsWith('soc'));
    assert.equal(files.length, 2, files.join(','));
    const fresh = await recording(server, 'soc');
    assert.equal(fresh.filter((e) => e.type === 'init').length, 1);
    assert.equal(fresh.filter((e) => e.type === 'vertex').length, 50);
  });
});

describe('a viewer connected during a live run', () => {
  let server;
  before(async () => (server = await startServer()));
  after(() => server.cleanup());

  test('a mid-run snapshot equals the state replayed from the recording at the same step, and live events keep flowing', async () => {
    const child = spawn(process.execPath, [script('gen-social-graph.js'), '--nodes=400', '--agents=60', '--duration=3000', '--tick=30', '--run=live', `--port=${server.port}`], { stdio: 'ignore' });
    try {
      await waitFor(async () => {
        const list = JSON.parse((await getText(server, '/recordings')).text).recordings;
        return list.some((r) => r.runId === 'live');
      }, 8000, 'run to appear');
      await sleep(600);
      const w = await watch(server, 'live');
      const snap = w.snapshot().state;
      assert.ok(snap.lastStep >= 0, `joined mid-run (step ${snap.lastStep})`);
      assert.equal(snap.vertices.length, 400, 'late joiner sees the whole graph');
      assert.equal(snap.agents.length, 60);

      // replay the recording up to that same step and compare
      const events = await recording(server, 'live');
      const state = new RunState();
      for (const e of events) {
        state.apply(e);
        if (e.type === 'step' && e.step === snap.lastStep) break;
      }
      const at = (s) => JSON.stringify([...s.agents.values()].map((a) => [a.id, a.at]).sort());
      assert.equal(at(state), at({ agents: new Map(snap.agents.map((a) => [a.id, a])) }));
      const values = (pairs) => JSON.stringify([...pairs].map(([k, v]) => [String(k), v]).sort());
      assert.equal(values(state.placeValues), values(snap.placeValues.map((p) => [p.id, p.value])));

      await waitFor(() => w.messages.filter((m) => m.type === 'agent_move').length > 60, 5000, 'live moves');
      w.close();
    } finally {
      child.kill();
    }
  });

  test('the viewer\'s Pause path: a windowed load and a full load agree on how many steps the run has', async () => {
    const conn = new RunConnection({ onReset: () => {}, onEvent: () => {} });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (u, o) => realFetch(server.url + u, o);
    try {
      await conn.loadReplay('live', { tail: 20 });
      assert.ok(conn.stepCount >= 1);
      const windowed = conn.windowInfo;
      await conn.loadReplay('live');
      if (windowed) assert.equal(conn.stepCount, windowed.totalFrames, 'full replay has as many frames as the window claimed');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('other generators', () => {
  let server;
  before(async () => (server = await startServer()));
  after(() => server.cleanup());

  test('gen-live-grid.js posts a dense grid every tick', async () => {
    await run(script('gen-live-grid.js'), ['12', '8', '600', '80', 'lg', `--port=${server.port}`]);
    const ev = await recording(server, 'lg');
    assert.equal(ev[0].mode, 'grid');
    const grids = ev.filter((e) => e.type === 'place_grid');
    assert.ok(grids.length >= 3);
    assert.ok(grids.every((g) => g.values.length === 96 && g.values.every(Number.isFinite)));
  });

  test('gen-graph-load.js builds a ring graph and moves agents', async () => {
    await run(script('gen-graph-load.js'), ['--tool=massviz', '--nodes=60', '--agents=10', '--duration=800', `--port=${server.port}`]);
    const ev = await recording(server, 'bench-graph');
    assert.equal(ev.filter((e) => e.type === 'vertex').length, 60);
    assert.ok(ev.filter((e) => e.type === 'agent_move').length >= 10);
  });

  test('gen-grid-recording.js and gen-graph-recording.js write loadable recordings (into MASS_VIZ_RECORDINGS_DIR)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'massviz-gen-'));
    try {
      await run(script('gen-grid-recording.js'), ['20', '10', '12', 'g'], { MASS_VIZ_RECORDINGS_DIR: dir });
      await run(script('gen-graph-recording.js'), ['40', '5', '12', 'gr'], { MASS_VIZ_RECORDINGS_DIR: dir });
      const load = async (id) => {
        const text = fs.readFileSync(path.join(dir, `${id}.ndjson`), 'utf8');
        const conn = new RunConnection({ onReset: () => {}, onEvent: () => {} });
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, text: async () => text });
        try {
          await conn.loadReplay(id);
        } finally {
          globalThis.fetch = realFetch;
        }
        return conn;
      };
      assert.equal((await load('g')).stepCount, 12);
      assert.equal((await load('gr')).stepCount, 12);
      const old = await run(script('gen-grid-recording.js'), ['5', '5', '3', 'old', '--format=place'], { MASS_VIZ_RECORDINGS_DIR: dir });
      assert.match(old.stdout, /format: place/);
      assert.ok(fs.readFileSync(path.join(dir, 'old.ndjson'), 'utf8').includes('"type":"place"'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('push-ndjson.js replays a demo recording into a live run, keeping the initial-state marker', async () => {
    const file = path.join(ROOT, 'examples', 'cuda-grid-demo', 'cuda-grid-demo.ndjson');
    const original = parseNdjson(fs.readFileSync(file, 'utf8'));
    const out = await run(script('push-ndjson.js'), [file, '--runId=pushed', '--interval=5', `--server=${server.url}`]);
    assert.match(out.stdout, /done: \d+ events/);
    const pushed = await recording(server, 'pushed');
    assert.equal(pushed.length, original.length);
    assert.ok(pushed.every((e) => e.runId === 'pushed'));
    assert.equal(pushed.find((e) => e.type === 'step').step, -1);
    const w = await watch(server, 'pushed');
    assert.equal(w.snapshot().state.agents.length, original.filter((e) => e.type === 'agent_spawn').length);
    w.close();
  });

  test('push-ndjson.js survives an adapter that wrote bare NaN and a corrupt line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'massviz-push-'));
    const file = path.join(dir, 'bad.ndjson');
    fs.writeFileSync(file, [
      '{"v":1,"runId":"x","type":"init","mode":"grid","dims":[2,1]}',
      '{"v":1,"runId":"x","type":"place_grid","values":[1,NaN]}',
      '{corrupt',
      '{"v":1,"runId":"x","type":"step","step":0}',
    ].join('\n') + '\n');
    try {
      const out = await run(script('push-ndjson.js'), [file, '--runId=badpush', '--interval=5', `--server=${server.url}`]);
      assert.match(out.stdout, /1 unparseable lines skipped/);
      const ev = await recording(server, 'badpush');
      assert.deepEqual(ev.map((e) => e.type), ['init', 'place_grid', 'step']);
      assert.deepEqual(ev[1].values, [1, null]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
