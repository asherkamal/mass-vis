// The graph and grid renderers, run headlessly against a stub scene (real
// three.js objects, no WebGL): structure, layout, instancing bookkeeping,
// agents, picking, selection, search and the inspector data.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../server/node_modules/three/build/three.module.js';
import { ColorScale } from '../server/public/src/colorScale.js';
import { GraphRenderer } from '../server/public/src/graphRenderer.js';
import { GridRenderer } from '../server/public/src/gridRenderer.js';

function stubScene() {
  const frameCallbacks = new Set();
  const scene = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(55, 1.6, 0.1, 2000),
    controls: { target: new THREE.Vector3(), addEventListener() {}, removeEventListener() {} },
    useCamera() {},
    onFrame(cb) {
      frameCallbacks.add(cb);
      return () => frameCallbacks.delete(cb);
    },
  };
  scene.camera.position.set(30, 40, 60);
  scene.frame = (dt = 0.016) => frameCallbacks.forEach((cb) => cb(dt));
  scene.frames = (n, dt) => Array.from({ length: n }, () => scene.frame(dt));
  return scene;
}

const ring = (n, extra = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), neighbors: [String((i + 1) % n), String((i + 7) % n)], ...extra(i) }));

describe('ColorScale', () => {
  test('starts empty and is defined by the first observed values (not forced to include 0..1)', () => {
    const c = new ColorScale();
    assert.equal(c.isSet, false);
    c.observe(20);
    c.observe(95);
    c.observe(NaN);
    c.observe(null);
    assert.deepEqual([c.min, c.max, c.isSet], [20, 95, true]);
    assert.notEqual(c.colorFor(20), c.colorFor(95));
  });
  test('an explicit range locks it, and a single value gets the middle color', () => {
    const c = new ColorScale();
    c.setRange(0, 10);
    c.observe(500);
    assert.equal(c.max, 10);
    const one = new ColorScale();
    one.observe(3);
    assert.equal(one.colorFor(3), new ColorScale(0, 2).colorFor(1));
  });
});

describe('GraphRenderer: structure', () => {
  let scene, r;
  beforeEach(() => {
    scene = stubScene();
    r = new GraphRenderer(scene);
  });

  test('vertices become instances; edges are deduplicated; the pool grows past its initial capacity', () => {
    const n = 3000;
    for (const v of ring(n, (i) => ({ label: `user-${i}`, group: `c${i % 7}` }))) r.upsertVertex(v);
    scene.frame();
    assert.equal(r.nodePool.count, n);
    assert.equal(r.nodePool.mesh.count, n);
    assert.ok(r.nodePool.capacity >= n);
    assert.equal(r.edgeList.length, 2 * n, 'ring + chord, each edge once');
    assert.equal(r.edgeLines.geometry.getAttribute('position').count, 2 * 2 * n);
    assert.equal(r.getGroups(100).length, 7);
    assert.equal(r.groupCount, 7);
  });

  test('edges to vertices that arrive later are drawn once both exist', () => {
    r.upsertVertex({ id: 'a', neighbors: ['b'], position: [0, 0, 0] });
    scene.frame();
    assert.equal(r.edgeLines.geometry.getAttribute('position').count, 0);
    r.upsertVertex({ id: 'b', neighbors: ['a'], position: [3, 0, 0] });
    scene.frame();
    assert.equal(r.edgeLines.geometry.getAttribute('position').count, 2);
  });

  test('auto-layout uses the final vertex count: one radius for all, not a spiral that widens', () => {
    for (const v of ring(500)) r.upsertVertex(v);
    scene.frame();
    const radii = r.nodes.map((n) => n.position.length());
    assert.ok(Math.max(...radii) - Math.min(...radii) < 1e-6);
    assert.ok(radii[0] > 8);
    // a second batch relays everything out consistently
    for (const v of ring(500).map((v) => ({ ...v, id: 'x' + v.id, neighbors: [] }))) r.upsertVertex(v);
    scene.frame();
    const radii2 = r.nodes.map((n) => n.position.length());
    assert.ok(Math.max(...radii2) - Math.min(...radii2) < 1e-6);
    assert.ok(radii2[0] > radii[0]);
  });

  test('explicit positions are kept; agents sit above their node even before layout ran', () => {
    r.upsertVertex({ id: 'a', position: [10, 0, 0] });
    r.spawnAgent('x', 'a');
    scene.frame();
    assert.ok(Math.abs(r.nodes[0].position.x - 10) < 1e-9);
    assert.ok(r.agents.get('x').cur.y > 0, 'hovers above the node');
    assert.ok(Math.abs(r.agents.get('x').cur.x - 10) < 1e-9);
  });

  test('place values color nodes in value mode; null/NaN carry no information', () => {
    for (const v of ring(10)) r.upsertVertex(v);
    r.setColorMode('value');
    r.setPlaceValue('1', 20);
    r.setPlaceValue('2', 95);
    r.setPlaceValue('3', NaN);
    r.setPlaceValue('4', null);
    scene.frame();
    assert.deepEqual([r.colorScale.min, r.colorScale.max], [20, 95]);
    assert.equal(r.nodes[3].value, undefined);
  });

  test('keepView leaves the camera alone; by default the camera is fitted to the graph', () => {
    const before = scene.camera.position.clone();
    const kept = new GraphRenderer(scene, { keepView: true });
    for (const v of ring(50)) kept.upsertVertex(v);
    scene.frame();
    assert.ok(scene.camera.position.equals(before));
    kept.dispose();
    for (const v of ring(50)) r.upsertVertex(v);
    scene.frame();
    assert.ok(!scene.camera.position.equals(before));
  });

  test('edge modes: off hides them, faint/full change opacity', () => {
    for (const v of ring(10)) r.upsertVertex(v);
    scene.frame();
    r.setEdgeMode('off');
    assert.equal(r.edgeLines.visible, false);
    r.setEdgeMode('full');
    assert.equal(r.edgeLines.visible, true);
    const full = r.edgeLines.material.opacity;
    r.setEdgeMode('faint');
    assert.ok(r.edgeLines.material.opacity < full);
  });
});

describe('GraphRenderer: agents', () => {
  let scene, r;
  beforeEach(() => {
    scene = stubScene();
    r = new GraphRenderer(scene);
    for (const v of ring(50)) r.upsertVertex(v);
    scene.frame();
  });

  test('agents are pooled per shape and slot bookkeeping survives removals', () => {
    for (let i = 0; i < 400; i++) r.spawnAgent(`a${i}`, String(i % 50), 0xff0000, ['sphere', 'cube', 'cone'][i % 3]);
    scene.frame();
    assert.equal(r.agents.size, 400);
    assert.equal(Object.values(r.agentPools).reduce((n, p) => n + p.count, 0), 400);
    for (const id of ['a0', 'a1', 'a2', 'a100', 'a399']) r.removeAgent(id);
    for (const [id, a] of r.agents) assert.equal(a.pool.ids[a.slot], id);
    assert.equal(r.agents.size, 395);
    r.spawnAgent('a0', '3', 0, 'sphere');
    assert.equal(r.agents.size, 396, 'respawning an id replaces rather than duplicates');
  });

  test('a move animates over time and honors speed; instant moves jump', () => {
    r.spawnAgent('a', '0');
    r.spawnAgent('b', '0');
    r.moveAgent('a', '5', false, 1);
    r.moveAgent('b', '5', false, 4);
    assert.ok(r.agents.get('b').duration < r.agents.get('a').duration);
    scene.frame(0.1);
    assert.ok(r.moving.has(r.agents.get('a')));
    scene.frames(60, 0.05);
    assert.equal(r.moving.size, 0);
    const rest = r._restPosition(r.agents.get('a'), new THREE.Vector3());
    assert.ok(r.agents.get('a').cur.distanceTo(rest) < 1e-6);
    r.moveAgent('a', '9', true);
    assert.ok(r.agents.get('a').cur.distanceTo(r._restPosition(r.agents.get('a'), new THREE.Vector3())) < 1e-6);
    assert.equal(r.agents.get('a').moves, 2);
  });

  test('moves to unknown vertices and unknown agents are ignored', () => {
    r.spawnAgent('a', '0');
    r.moveAgent('a', 'nope', false);
    r.moveAgent('ghost', '1', false);
    r.spawnAgent('lost', 'nope');
    assert.equal(r.agents.get('a').at, '0');
    assert.equal(r.agents.size, 1);
  });

  test('agent_update changes color, name and merges attrs', () => {
    r.spawnAgent('a', '0', 0xff0000, 'sphere', 'Alice', { k: 1 });
    r.updateAgent({ id: 'a', color: 0x00ff00, name: 'Al', attrs: { j: 2 } });
    const a = r.agents.get('a');
    assert.deepEqual([a.color, a.name, a.attrs], [0x00ff00, 'Al', { k: 1, j: 2 }]);
  });
});

describe('GraphRenderer: interaction', () => {
  let scene, r;
  beforeEach(() => {
    scene = stubScene();
    r = new GraphRenderer(scene);
    for (const v of ring(200, (i) => ({ label: `user-${i}`, group: `c${i % 3}`, attrs: { followers: i }, position: [i * 4, 0, 0] }))) r.upsertVertex(v);
    r.spawnAgent('a7', '7', 0xff8800, 'sphere', 'agent-7', { topic: 'news' });
    scene.frame();
  });

  const rayAt = (x) => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    cam.position.set(x, 0, 60);
    cam.lookAt(x, 0, 0);
    cam.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), cam);
    return ray;
  };

  test('picking finds the node under the ray, and an agent in front of its node', () => {
    assert.deepEqual(r.pick(rayAt(40 * 4)), { kind: 'node', id: '40' });
    const agentHit = r.pick(rayAt(7 * 4));
    assert.ok(agentHit, 'something is under the ray at node 7');
    assert.equal(r.pick(rayAt(-500)), null);
  });

  test('describe() gives the inspector its rows, links and agents-here', () => {
    const d = r.describe({ kind: 'node', id: '7' });
    assert.equal(d.title, 'user-7');
    const row = (k) => d.rows.find(([key]) => key === k)?.[1];
    assert.equal(row('group'), 'c1');
    assert.equal(row('followers'), '7');
    assert.equal(row('connections'), '4');
    assert.equal(row('agents here'), '1');
    assert.deepEqual(d.links2.map((l) => l.id), ['a7']);
    assert.ok(d.links.every((l) => l.kind === 'node'));
    const a = r.describe({ kind: 'agent', id: 'a7' });
    assert.equal(a.title, 'agent-7');
    assert.ok(a.rows.some(([k, v]) => k === 'topic' && v === 'news'));
    assert.ok(a.rows.some(([k, v]) => k === 'at' && v === 'user-7'));
    assert.equal(r.describe({ kind: 'node', id: 'nope' }), null);
    assert.equal(r.describe(null), null);
  });

  test('search finds nodes by id or label and agents by name', () => {
    assert.deepEqual(r.search('user-42'), { kind: 'node', id: '42' });
    assert.deepEqual(r.search('USER-42'), { kind: 'node', id: '42' });
    assert.deepEqual(r.search('42'), { kind: 'node', id: '42' });
    assert.deepEqual(r.search('agent-7'), { kind: 'agent', id: 'a7' });
    assert.equal(r.search('zzz'), null);
    assert.equal(r.search('   '), null);
  });

  test('selecting a node highlights its edges and dims everything but its neighbors', () => {
    const colorOf = (slot) => Array.from(r.nodePool.mesh.instanceColor.array.slice(slot * 3, slot * 3 + 3));
    r.setSelection({ kind: 'node', id: '10' });
    scene.frame();
    assert.equal(r.highlightLines.geometry.getAttribute('position').count, 2 * r.adj.get('10').size);
    assert.deepEqual(colorOf(r.nodeIndex.get('10')), [1, 1, 1], 'selected node is white');
    const neighbor = [...r.adj.get('10')][0];
    const stranger = String((Number(neighbor) + 90) % 200);
    const brightness = (c) => c[0] + c[1] + c[2];
    assert.ok(brightness(colorOf(r.nodeIndex.get(neighbor))) > 2 * brightness(colorOf(r.nodeIndex.get(stranger))), 'neighbors stay bright, others fade');
    r.setSelection(null);
    scene.frame();
    assert.equal(r.highlightLines.geometry.getAttribute('position').count, 0);
    assert.ok(brightness(colorOf(r.nodeIndex.get(stranger))) > 0.5, 'dimming is undone');
  });

  test('hover draws just that node\'s edges; a selection takes precedence', () => {
    r.setHover({ kind: 'node', id: '20' });
    assert.equal(r.highlightLines.geometry.getAttribute('position').count, 2 * r.adj.get('20').size);
    r.setSelection({ kind: 'node', id: '30' });
    r.setHover({ kind: 'node', id: '20' });
    assert.equal(r.highlightLines.geometry.getAttribute('position').count, 2 * r.adj.get('30').size);
  });

  test('removing the selected agent clears the selection', () => {
    r.setSelection({ kind: 'agent', id: 'a7' });
    r.removeAgent('a7');
    assert.equal(r.selection, null);
  });

  test('focus moves the camera target onto the node', () => {
    r.focus({ kind: 'node', id: '25' });
    assert.ok(Math.abs(scene.controls.target.x - 100) < 1e-9);
  });
});

describe('GridRenderer', () => {
  test('dense values color cells; null values are skipped; the legend range starts from the data', () => {
    const scene = stubScene();
    const g = new GridRenderer(scene, [3, 2]);
    g.setPlaceGrid([20, 50, 95, null, NaN, 30]);
    assert.deepEqual([g.colorScale.min, g.colorScale.max], [20, 95]);
    g.setPlace([0, 1], null);
    g.setPlace([0, 1], 10);
    assert.equal(g.colorScale.min, 10);
    g.dispose();
  });

  test('agent moves honor speed', () => {
    const scene = stubScene();
    const g = new GridRenderer(scene, [4, 4]);
    g.spawnAgent('a', [0, 0]);
    g.spawnAgent('b', [0, 0]);
    g.moveAgent('a', [1, 0], false, 1);
    g.moveAgent('b', [1, 0], false, 5);
    assert.ok(g.agents.get('b').duration < g.agents.get('a').duration);
    scene.frames(60, 0.05);
    assert.ok(g.agents.get('a').mesh.position.distanceTo(g.agents.get('b').mesh.position) < 1e-6);
    g.dispose();
  });
});
