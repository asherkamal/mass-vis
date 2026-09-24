// End-to-end tests of the relay/recording server, run against a real server
// process over real HTTP and WebSocket (no mocks).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { RunState } from '../server/public/src/runState.js';
import { getText, gridRunEvents, parseNdjson, post, sleep, startServer, waitFor, watch } from './helpers.js';

describe('server: basics', () => {
  let server;
  before(async () => (server = await startServer()));
  after(() => server.cleanup());

  test('/health reports ok, and counts connected viewers (not runs that once had one)', async () => {
    const { status, text } = await getText(server, '/health');
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(text), { status: 'ok', runs: 0, watchers: 0 });
    const w = await watch(server, 'anything');
    assert.equal(JSON.parse((await getText(server, '/health')).text).watchers, 1);
    w.close();
    await waitFor(async () => JSON.parse((await getText(server, '/health')).text).watchers === 0, 3000, 'viewer to be forgotten');
  });

  test('serves the viewer page, its modules and three.js', async () => {
    for (const p of ['/', '/src/app.js', '/src/graphRenderer.js', '/src/runState.js', '/src/json.js', '/vendor/three.module.js', '/vendor/OrbitControls.js']) {
      const { status } = await getText(server, p);
      assert.equal(status, 200, p);
    }
    const page = await getText(server, '/');
    assert.match(page.headers.get('content-type'), /text\/html/);
    for (const id of ['pauseBtn', 'endBtn', 'goLiveBtn', 'refreshBtn', 'windowSelect', 'inspector', 'searchBox', 'fps']) {
      assert.ok(page.text.includes(`id="${id}"`), `index.html has #${id}`);
    }
  });

  test('unknown paths 404 and path traversal is refused', async () => {
    assert.equal((await getText(server, '/nope.js')).status, 404);
    const status = await new Promise((resolve, reject) => {
      http.get({ port: server.port, path: '/../server.js' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.notEqual(status, 200);
    const traversal = await new Promise((resolve, reject) => {
      http.get({ port: server.port, path: '/%2e%2e/server.js' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.notEqual(traversal, 200);
  });

  test('an unknown recording is a 404', async () => {
    assert.equal((await getText(server, '/recordings/does-not-exist.ndjson')).status, 404);
  });

  test('bad input is rejected without hurting the server', async () => {
    assert.equal((await post(server, '{not json')).status, 400);
    const events = [null, 5, 'x', {}, { type: 'init' }, { runId: 'r' }, { runId: 'r', type: 'vertex' }, { runId: 'r', type: 'place', places: 5 }];
    const { status, json } = await post(server, events);
    assert.equal(status, 200);
    assert.ok(json.rejected >= 5, 'events without runId/type are rejected');
    assert.equal((await getText(server, '/health')).status, 200, 'still alive');
  });
});

describe('server: events, snapshots and recording', () => {
  let server;
  before(async () => (server = await startServer()));
  after(() => server.cleanup());

  test('a grid run is applied, listed, and recorded immediately (buffer flushed on read)', async () => {
    const events = gridRunEvents('grid1', { steps: 3 });
    const { json } = await post(server, events);
    assert.deepEqual(json, { accepted: events.length, rejected: 0 });

    const list = JSON.parse((await getText(server, '/recordings')).text).recordings;
    const entry = list.find((r) => r.runId === 'grid1');
    assert.ok(entry && entry.active && entry.mode === 'grid');

    // read straight after posting: the write buffer must have been flushed
    const recorded = parseNdjson((await getText(server, '/recordings/grid1.ndjson')).text);
    assert.equal(recorded.length, events.length);
    assert.deepEqual(recorded.map((e) => e.type), events.map((e) => e.type));
  });

  test('non-finite numbers become null (in state and in the recording), not lost events', async () => {
    const body = '[{"v":1,"runId":"nan1","type":"init","mode":"grid","dims":[2,1]},' +
      '{"v":1,"runId":"nan1","type":"place_grid","values":[1.5,NaN]},' +
      '{"v":1,"runId":"nan1","type":"place_grid","values":[-Infinity,2]},' +
      '{"v":1,"runId":"nan1","type":"step","step":0}]';
    const { json } = await post(server, body);
    assert.deepEqual(json, { accepted: 4, rejected: 0 });
    const text = (await getText(server, '/recordings/nan1.ndjson')).text;
    assert.ok(!/NaN|Infinity/.test(text), 'recording is valid JSON');
    const grids = parseNdjson(text).filter((e) => e.type === 'place_grid').map((e) => e.values);
    assert.deepEqual(grids, [[1.5, null], [null, 2]]);
  });

  test('a late joiner gets the full graph state, then live events', async () => {
    const runId = 'graph1';
    await post(server, [
      { v: 1, runId, type: 'init', mode: 'graph', runName: 'G', source: 't' },
      { v: 1, runId, type: 'vertex', id: 'a', label: 'Ann', group: 'g1', attrs: { followers: 3 }, neighbors: ['b'], position: [0, 0, 0] },
      { v: 1, runId, type: 'vertex', id: 'b', label: 'Bob', group: 'g2', neighbors: ['a'], position: [5, 0, 0] },
      { v: 1, runId, type: 'place_value', id: 'a', value: 7 },
      { v: 1, runId, type: 'agent_spawn', id: 'x', at: 'a', name: 'walker', attrs: { topic: 'news' }, color: 255 },
      { v: 1, runId, type: 'agent_move', id: 'x', to: 'b' },
      { v: 1, runId, type: 'agent_update', id: 'x', attrs: { hops: 1 } },
      { v: 1, runId, type: 'step', step: 0 },
    ]);
    const w = await watch(server, runId);
    const s = w.snapshot().state;
    assert.equal(s.mode, 'graph');
    assert.equal(s.vertices.length, 2);
    assert.deepEqual(s.vertices.find((v) => v.id === 'a').attrs, { followers: 3 });
    assert.equal(s.vertices.find((v) => v.id === 'b').group, 'g2');
    assert.deepEqual(s.placeValues, [{ id: 'a', value: 7 }]);
    const agent = s.agents.find((a) => a.id === 'x');
    assert.equal(agent.at, 'b', 'latest position');
    assert.equal(agent.name, 'walker');
    assert.deepEqual(agent.attrs, { topic: 'news', hops: 1 }, 'agent_update merged');
    assert.equal(s.lastStep, 0);

    await post(server, { v: 1, runId, type: 'agent_move', id: 'x', to: 'a' });
    await waitFor(() => w.messages.some((m) => m.type === 'agent_move'), 3000, 'live event');
    w.close();
  });

  test('a late joiner gets the dense grid values, with sparse place events on top', async () => {
    const runId = 'grid2';
    await post(server, [
      { v: 1, runId, type: 'init', mode: 'grid', dims: [3, 2] },
      { v: 1, runId, type: 'place_grid', values: [1, 2, 3, 4, 5, 6] },
      { v: 1, runId, type: 'place', index: [0, 0], value: 99 },
    ]);
    const w = await watch(server, runId);
    const s = w.snapshot().state;
    assert.deepEqual(s.gridValues, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(s.places, [{ index: [0, 0], value: 99 }]);
    w.close();
  });

  test('watching a run that does not exist yields a null snapshot, then live events once it starts', async () => {
    const w = await watch(server, 'future');
    assert.equal(w.snapshot().state, null);
    await post(server, { v: 1, runId: 'future', type: 'init', mode: 'grid', dims: [1, 1] });
    await waitFor(() => w.messages.some((m) => m.type === 'init'), 3000, 'init relayed');
    w.close();
  });

  test('a new init resets the run state', async () => {
    const runId = 'reset1';
    await post(server, gridRunEvents(runId, { steps: 2 }));
    await post(server, { v: 1, runId, type: 'init', mode: 'grid', dims: [2, 2] });
    const w = await watch(server, runId);
    assert.equal(w.snapshot().state.agents.length, 0);
    assert.equal(w.snapshot().state.gridValues, null);
    w.close();
  });

  test('re-initialising a run keeps the old recording under a timestamped name', async () => {
    const runId = 'rot1';
    await post(server, gridRunEvents(runId, { steps: 2 }));
    await post(server, { v: 1, runId, type: 'init', mode: 'grid', dims: [2, 2] });
    await post(server, { v: 1, runId, type: 'step', step: 0 });
    const files = fs.readdirSync(server.dir).filter((f) => f.startsWith('rot1'));
    assert.equal(files.length, 2, files.join(', '));
    const archived = files.find((f) => f !== 'rot1.ndjson');
    assert.match(archived, /^rot1\..+\.ndjson$/);
    const fresh = parseNdjson((await getText(server, '/recordings/rot1.ndjson')).text);
    assert.deepEqual(fresh.map((e) => e.type), ['init', 'step'], 'new file holds only the new run');
    const old = parseNdjson(fs.readFileSync(path.join(server.dir, archived), 'utf8'));
    assert.ok(old.length > 5, 'old run intact');
  });

  test('an init sent twice with nothing between is truncated, not archived', async () => {
    const runId = 'twice1';
    await post(server, { v: 1, runId, type: 'init', mode: 'grid', dims: [2, 2] });
    await post(server, { v: 1, runId, type: 'init', mode: 'grid', dims: [2, 2] });
    await sleep(100);
    assert.deepEqual(fs.readdirSync(server.dir).filter((f) => f.startsWith('twice1')), ['twice1.ndjson']);
  });
});

describe('server: windowed replay (?tail=N)', () => {
  const STEPS = 130;
  let server;
  before(async () => {
    server = await startServer();
    await post(server, gridRunEvents('win1', { steps: STEPS, withInitialMarker: true }));
  });
  after(() => server.cleanup());

  const endState = (lines) => {
    let state = new RunState();
    for (const e of lines) {
      if (e.type === 'snapshot') state = RunState.fromSnapshot(e.state);
      else state.apply(e);
    }
    return { grid: state.gridValues, agents: [...state.agents.values()].map((a) => [a.id, a.at]), lastStep: state.lastStep };
  };

  test('an active run answers with a snapshot line plus only the recent events', async () => {
    const full = parseNdjson((await getText(server, '/recordings/win1.ndjson')).text);
    const windowed = parseNdjson((await getText(server, '/recordings/win1.ndjson?tail=20')).text);
    assert.equal(windowed[0].type, 'snapshot');
    const totalFrames = full.filter((e) => e.type === 'step').length;
    assert.equal(windowed[0].totalFrames, totalFrames);
    assert.ok(windowed[0].baseFrame <= totalFrames - 20);
    assert.ok(windowed.length < full.length / 2, 'much smaller than the whole recording');
    assert.deepEqual(endState(windowed), endState(full), 'same final state as the full replay');
  });

  test('a run no longer than tail comes back whole (no snapshot line)', async () => {
    const whole = parseNdjson((await getText(server, '/recordings/win1.ndjson?tail=1000')).text);
    assert.notEqual(whole[0].type, 'snapshot');
    assert.equal(whole[0].type, 'init');
  });

  test('after a restart the window is rebuilt from the file and matches', async () => {
    const dir = server.dir;
    const before = parseNdjson((await getText(server, '/recordings/win1.ndjson')).text);
    await server.stop();
    const restarted = await startServer({ dir, env: { MASS_VIZ_WINDOW_MIN_BYTES: '1' } });
    try {
      const windowed = parseNdjson((await getText(restarted, '/recordings/win1.ndjson?tail=20')).text);
      assert.equal(windowed[0].type, 'snapshot');
      assert.equal(windowed[0].totalFrames, before.filter((e) => e.type === 'step').length);
      assert.deepEqual(endState(windowed), endState(before));
      // without the size threshold being crossed, the whole file is sent
      const other = await startServer({ dir });
      try {
        const whole = parseNdjson((await getText(other, '/recordings/win1.ndjson?tail=20')).text);
        assert.equal(whole[0].type, 'init', 'small recordings are sent whole');
      } finally {
        await other.stop();
      }
    } finally {
      await restarted.stop();
    }
  });
});
