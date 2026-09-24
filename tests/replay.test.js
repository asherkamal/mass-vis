// The viewer's data layer: RunState, tolerant JSON, and RunConnection's replay
// (frames, keyframes, seeking, windowed loads, corrupt recordings).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RunConnection } from '../server/public/src/connection.js';
import { parseJsonTolerant } from '../server/public/src/json.js';
import { RunState } from '../server/public/src/runState.js';
import { ROOT, gridRunEvents } from './helpers.js';

const ndjson = (events, tail = '') => events.map((e) => JSON.stringify(e)).join('\n') + '\n' + tail;

// A RunConnection wired to a fake fetch serving `text`. `log` records what the
// viewer would be told to draw: the last reset snapshot, the events applied
// since, and `model` - the state a renderer would hold (reset to the snapshot,
// then every event applied on top), which is what seeking must get right.
function connectionServing(text) {
  const log = { snapshot: null, applied: [], model: new RunState() };
  const conn = new RunConnection({
    onReset: (s) => {
      log.snapshot = s;
      log.applied.length = 0;
      log.model = s ? RunState.fromSnapshot(s) : new RunState();
    },
    onEvent: (e, opts) => {
      log.applied.push({ type: e.type, instant: !!(opts && opts.instant) });
      log.model.apply(e);
    },
  });
  let served = text;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: true, text: async () => served };
  };
  return { conn, log, urls, serve: (t) => (served = t) };
}

describe('parseJsonTolerant', () => {
  test('parses valid JSON untouched', () => {
    assert.deepEqual(parseJsonTolerant('{"a":[1,2,{"b":null}]}'), { a: [1, 2, { b: null }] });
  });
  test('turns bare NaN/Infinity into null, and reports the repair', () => {
    let repaired = 0;
    assert.deepEqual(parseJsonTolerant('{"v":[1,NaN,-Infinity,Infinity,2]}', () => repaired++), { v: [1, null, null, null, 2] });
    assert.equal(repaired, 1);
  });
  test('leaves NaN inside strings alone and still throws on real garbage', () => {
    assert.deepEqual(parseJsonTolerant('{"name":"NaN"}'), { name: 'NaN' });
    assert.throws(() => parseJsonTolerant('{"a":'));
    assert.throws(() => parseJsonTolerant('{not json'));
  });
});

describe('RunState', () => {
  test('applies grid, graph and agent events', () => {
    const s = new RunState();
    s.apply({ type: 'init', runId: 'r', mode: 'graph', runName: 'N' });
    s.apply({ type: 'vertex', id: 1, neighbors: [2], group: 'g' });
    s.apply({ type: 'place_value', id: 1, value: 4 });
    s.apply({ type: 'agent_spawn', id: 'a', at: '1', name: 'A', attrs: { k: 1 } });
    s.apply({ type: 'agent_move', id: 'a', to: '2' });
    s.apply({ type: 'agent_update', id: 'a', attrs: { j: 2 }, color: 5 });
    s.apply({ type: 'step', step: 3 });
    const snap = s.toSnapshot();
    assert.equal(snap.runName, 'N');
    assert.equal(snap.vertices[0].group, 'g');
    assert.deepEqual(snap.placeValues, [{ id: '1', value: 4 }]);
    assert.deepEqual(snap.agents[0], { id: 'a', at: '2', color: 5, shape: undefined, name: 'A', attrs: { k: 1, j: 2 } });
    assert.equal(snap.lastStep, 3);
    s.apply({ type: 'agent_remove', id: 'a' });
    assert.equal(s.agents.size, 0);
  });

  test('a null/NaN grid value keeps the last known value', () => {
    const s = new RunState();
    s.apply({ type: 'init', runId: 'r', mode: 'grid', dims: [2, 1] });
    s.apply({ type: 'place_grid', values: [1, 2] });
    s.apply({ type: 'place_grid', values: [null, 5] });
    assert.deepEqual(s.gridValues, [1, 5]);
  });

  test('clone() is independent of later events', () => {
    const s = new RunState();
    s.apply({ type: 'init', runId: 'r', mode: 'grid', dims: [2, 1] });
    s.apply({ type: 'place_grid', values: [1, 2] });
    s.apply({ type: 'agent_spawn', id: 'a', at: [0, 0] });
    const c = s.clone();
    s.apply({ type: 'place_grid', values: [9, 9] });
    s.apply({ type: 'agent_move', id: 'a', to: [1, 0] });
    assert.deepEqual(c.gridValues, [1, 2]);
    assert.deepEqual(c.agents.get('a').at, [0, 0]);
  });

  test('fromSnapshot(toSnapshot()) round-trips, including a server-style places list', () => {
    const s = new RunState();
    s.apply({ type: 'init', runId: 'r', mode: 'grid', dims: [3, 2] });
    s.apply({ type: 'place_grid', values: [1, 2, 3, 4, 5, 6] });
    s.apply({ type: 'agent_spawn', id: 'a', at: [2, 1] });
    assert.deepEqual(RunState.fromSnapshot(s.toSnapshot()).toSnapshot(), s.toSnapshot());
    const legacy = RunState.fromSnapshot({ mode: 'grid', dims: [3, 2], runId: 'r', places: [{ index: [1, 1], value: 8 }], vertices: [], placeValues: [], agents: [] });
    assert.deepEqual(legacy.gridValues, [null, null, null, null, 8, null]);
  });
});

describe('RunConnection replay', () => {
  test('frames are step markers; the step -1 marker makes frame 0 the true initial state', async () => {
    const events = gridRunEvents('r', { steps: 4, withInitialMarker: true });
    const { conn, log } = connectionServing(ndjson(events));
    await conn.loadReplay('r');
    assert.equal(conn.stepCount, 5, 'initial marker + 4 steps');
    assert.equal(conn.currentStep, 4, 'loads at the last frame');
    conn.seekStep(0);
    assert.deepEqual(log.model.gridValues, events.find((e) => e.type === 'place_grid').values);
    assert.deepEqual(log.model.agents.get('a').at, [0, 0]);
    assert.equal(log.model.lastStep, -1);
  });

  test('without an initial marker the pre-step events fall into the first frame', async () => {
    const { conn } = connectionServing(ndjson(gridRunEvents('r', { steps: 3 })));
    await conn.loadReplay('r');
    assert.equal(conn.stepCount, 3);
  });

  test('a recording with no step events is one frame that still renders', async () => {
    const events = gridRunEvents('r', { steps: 2 }).filter((e) => e.type !== 'step');
    const { conn, log } = connectionServing(ndjson(events));
    await conn.loadReplay('r');
    assert.equal(conn.stepCount, 1);
    assert.equal(log.snapshot.mode, 'grid');
    assert.ok(log.snapshot.gridValues);
  });

  test('a corrupt line is skipped and counted, not fatal; NaN lines are repaired, not skipped', async () => {
    const events = gridRunEvents('r', { steps: 3 });
    const lines = events.map((e) => JSON.stringify(e));
    lines.splice(3, 0, '{"broken":');
    lines.splice(4, 0, '{"v":1,"runId":"r","type":"place_grid","values":[NaN,1,2,3,4,5,6,7,8,9,10,11]}');
    const { conn } = connectionServing(lines.join('\n') + '\n');
    await conn.loadReplay('r');
    assert.equal(conn.skippedLines, 1);
    assert.equal(conn.stepCount, 3);
  });

  test('an empty or unreadable recording is an error, not an empty scene', async () => {
    const { conn } = connectionServing('\n{bad\n');
    await assert.rejects(conn.loadReplay('r'), /no readable events/);
  });

  test('keyframes exist every 50 frames; a backward seek replays at most one keyframe interval', async () => {
    const events = gridRunEvents('r', { steps: 130, withInitialMarker: true });
    const { conn, log } = connectionServing(ndjson(events));
    await conn.loadReplay('r');
    for (const f of [0, 50, 100]) assert.ok(conn.keyframes.has(f), `keyframe ${f}`);
    assert.ok(!conn.keyframes.has(25));
    conn.seekStep(130);
    conn.seekStep(60);
    assert.ok(log.applied.length <= 3 * 10 + 3, `applied ${log.applied.length} events`);
    assert.deepEqual(log.snapshot.lastStep, 49, 'restored keyframe 50 (state after step 49)');
    // moving forward one step applies just that frame, animated
    log.applied.length = 0;
    conn.seekStep(61);
    assert.deepEqual(log.applied.map((a) => a.type), ['place_grid', 'agent_move', 'step']);
    assert.ok(log.applied.every((a) => !a.instant));
  });

  test('seeking to any frame, in any order, gives the same state as applying the events in order', async () => {
    const events = gridRunEvents('r', { steps: 120, withInitialMarker: true });
    const { conn, log } = connectionServing(ndjson(events));
    await conn.loadReplay('r');
    const stateAt = (state) => JSON.stringify([state.gridValues, [...state.agents.values()].map((a) => [a.id, a.at]), state.lastStep]);
    const expected = [];
    const reference = new RunState();
    for (const e of events) {
      reference.apply(e);
      if (e.type === 'step') expected.push(stateAt(reference));
    }
    assert.equal(expected.length, conn.stepCount);
    for (const frame of [0, 7, 49, 50, 51, 99, 100, 120, 3, 121, 1, 60, 60, 61, 0, 121]) {
      conn.seekStep(frame);
      const shown = Math.min(frame, conn.stepCount - 1);
      assert.equal(stateAt(log.model), expected[shown], `frame ${shown} (asked for ${frame})`);
    }
  });

  test('a windowed load starts from the server snapshot and labels steps from the run start', async () => {
    const full = gridRunEvents('r', { steps: 60, withInitialMarker: true });
    // what the server sends for ?tail=10: snapshot after marker 50, then the remaining events
    const state = new RunState();
    let markers = -1;
    let cut = 0;
    for (let i = 0; i < full.length; i++) {
      state.apply(full[i]);
      if (full[i].type === 'step' && ++markers === 50) {
        cut = i + 1;
        break;
      }
    }
    const text = ndjson([{ type: 'snapshot', baseFrame: 50, totalFrames: 61, state: state.toSnapshot() }, ...full.slice(cut)]);
    const { conn, log, urls } = connectionServing(text);
    await conn.loadReplay('r', { tail: 10 });
    assert.match(urls[0], /\?tail=10$/);
    assert.deepEqual(conn.windowInfo, { baseFrame: 50, totalFrames: 61 });
    assert.equal(conn.stepCount, 11, 'snapshot frame + 10 steps');
    assert.equal(conn.frameLabel(), 'step 61 / 61 (last 11 loaded)');
    assert.equal(conn.absoluteFrame(0), 50);
    conn.seekStep(0);
    assert.equal(conn.frameLabel(), 'step 51 / 61 (last 11 loaded)');
    assert.equal(log.snapshot.lastStep, 49);
    // reloading at an absolute frame lands on the same frame
    await conn.loadReplay('r', { tail: 10, absoluteFrame: 55 });
    assert.equal(conn.absoluteFrame(conn.currentStep), 55);
  });

  test('going forward from frame 0 to the end matches a full replay', async () => {
    const events = gridRunEvents('r', { steps: 30, withInitialMarker: true });
    const { conn, log } = connectionServing(ndjson(events));
    await conn.loadReplay('r');
    conn.seekStep(0);
    for (let f = 1; f < conn.stepCount; f++) {
      log.applied.length = 0;
      conn.seekStep(f);
      assert.deepEqual(log.applied.map((a) => a.type), ['place_grid', 'agent_move', 'step'], `frame ${f} applies exactly its own events`);
    }
    const reference = new RunState();
    for (const e of events) reference.apply(e);
    assert.deepEqual(log.model.gridValues, reference.gridValues);
    assert.deepEqual([...log.model.agents.values()].map((a) => a.at), [...reference.agents.values()].map((a) => a.at));
  });
});

describe('committed demo recordings', () => {
  for (const name of ['cpp-grid-demo', 'cuda-grid-demo', 'flamegpu2-grid-demo']) {
    test(`${name}: valid JSON, initial state ends in step -1, frame 0 is the starting grid`, async () => {
      const file = path.join(ROOT, 'examples', name, `${name}.ndjson`);
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/NaN|Infinity/.test(text));
      const events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(events.find((e) => e.type === 'step').step, -1);
      const { conn, log } = connectionServing(text);
      await conn.loadReplay(name);
      conn.seekStep(0);
      assert.deepEqual(log.snapshot.gridValues, events.find((e) => e.type === 'place_grid').values);
      assert.deepEqual(log.snapshot.agents.map((a) => a.at), events.filter((e) => e.type === 'agent_spawn').map((e) => e.at));
    });
  }
});
