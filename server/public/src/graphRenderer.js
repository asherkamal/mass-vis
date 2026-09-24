import * as THREE from '/vendor/three.module.js';
import { ColorScale } from './colorScale.js';

const NODE_RADIUS = 0.6;
const AGENT_GAP = 0.55; // clear space between a node's surface and a resting agent
const AGENT_MOVE_SECONDS = 0.6;
const NO_VALUE_COLOR = 0x556677;
const BACKGROUND = new THREE.Color(0x0b0f14);
const DIM_AMOUNT = 0.8; // how far non-neighbors fade toward the background when a node is selected
const EDGE_STYLES = {
  off: null,
  faint: { opacity: 0.07 },
  full: { opacity: 0.5 },
};
const AGENT_SHAPES = {
  sphere: () => new THREE.SphereGeometry(0.35, 10, 7),
  cube: () => new THREE.BoxGeometry(0.5, 0.5, 0.5),
  cone: () => new THREE.ConeGeometry(0.35, 0.7, 10),
};
const Q_IDENT = new THREE.Quaternion();

// A growable InstancedMesh: add/remove instances by slot, swap-removing so the
// live instances stay packed in [0, count). One draw call however many
// instances there are - this is what lets 10k nodes + 2k agents stay smooth
// where one THREE.Mesh each would not.
class InstancedPool {
  constructor(group, geometry, material, capacity = 256) {
    this.group = group;
    this.geometry = geometry;
    this.material = material;
    this.count = 0;
    this.capacity = 0;
    this.mesh = null;
    this.ids = []; // slot -> owner id
    this.visible = true;
    this.dirtyMatrix = false;
    this.dirtyColor = false;
    this._alloc(capacity);
  }

  _alloc(capacity) {
    const old = this.mesh;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    // See gridRenderer.js: instanceColor is set directly, not via material.vertexColors.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    // Instance transforms change after the (cached) bounding sphere would have
    // been computed, so frustum culling against it would hide live instances.
    mesh.frustumCulled = false;
    mesh.visible = this.visible;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = this.count;
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, this.count * 16));
      mesh.instanceColor.array.set(old.instanceColor.array.subarray(0, this.count * 3));
      this.group.remove(old);
      old.dispose();
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this.mesh = mesh;
    this.capacity = capacity;
  }

  add(id) {
    if (this.count === this.capacity) this._alloc(this.capacity * 2);
    const slot = this.count++;
    this.ids[slot] = id;
    this.mesh.count = this.count;
    return slot;
  }

  // Returns the id that was moved into `slot` (or null if none was).
  remove(slot) {
    const last = this.count - 1;
    let moved = null;
    if (slot !== last) {
      const m = this.mesh;
      m.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
      m.instanceColor.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
      moved = this.ids[last];
      this.ids[slot] = moved;
      this.dirtyMatrix = true;
      this.dirtyColor = true;
    }
    this.ids.length = last;
    this.count = last;
    this.mesh.count = last;
    return moved;
  }

  setMatrix(slot, matrix) {
    matrix.toArray(this.mesh.instanceMatrix.array, slot * 16);
    this.dirtyMatrix = true;
  }

  setColor(slot, color) {
    color.toArray(this.mesh.instanceColor.array, slot * 3);
    this.dirtyColor = true;
  }

  commit() {
    if (this.dirtyMatrix) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirtyMatrix = false;
    }
    if (this.dirtyColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this.dirtyColor = false;
    }
  }

  dispose() {
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// Renders an arbitrary MASS graph (GraphPlaces/VertexPlace topology).
//
// Built for large graphs (10k+ nodes, thousands of agents):
//  - nodes and agents are instanced meshes (one draw call each), nodes sized
//    by degree and colored by community `group` or by a `place_value` scale;
//  - edges are off / faint / full, and the edges of the hovered or selected
//    node are always drawn highlighted, so structure is readable on demand
//    instead of every edge painting the graph into a solid ball;
//  - vertices/edges/layout are applied once per animation frame, not once per
//    event (loading V vertices is O(V+E), not O(V*E));
//  - describe()/pick()/search() expose node and agent information to the
//    inspector UI in app.js.
export class GraphRenderer {
  // `keepView`: leave the camera where it is (a rebuild of the same graph,
  // e.g. a replay seek) instead of fitting it to the graph.
  constructor(vizScene, { keepView = false } = {}) {
    this.vizScene = vizScene;
    this.vizScene.useCamera('3d');
    this.colorScale = new ColorScale();

    this.group = new THREE.Group();
    this.vizScene.scene.add(this.group);

    // --- nodes ---
    this.nodes = []; // slot -> node
    this.nodeIndex = new Map(); // id -> slot
    this.adj = new Map(); // id -> Set(neighbor ids)
    this.edgeKeys = new Set();
    this.edgeList = []; // [idA, idB]
    this.groupInfo = new Map(); // group -> {color: THREE.Color, count}
    this.colorMode = 'group'; // 'group' | 'value'
    this.nodePool = new InstancedPool(
      this.group,
      new THREE.SphereGeometry(1, 10, 7),
      new THREE.MeshLambertMaterial(),
      1024
    );
    this._dirtyNodes = new Set();
    this._allNodesDirty = false;
    this._layoutDirty = false;
    this._edgesDirty = false;

    // --- edges ---
    this.edgeMode = 'faint';
    this.edgeLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x8fa6ba, transparent: true, opacity: 0.07, depthWrite: false })
    );
    this.edgeLines.frustumCulled = false;
    this.group.add(this.edgeLines);
    this.highlightLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffd166 })
    );
    this.highlightLines.frustumCulled = false;
    this.group.add(this.highlightLines);

    // --- agents ---
    this.agents = new Map(); // id -> agent record
    this.moving = new Set();
    this.agentPools = {}; // shape -> InstancedPool
    this.agentsVisible = true;

    // --- interaction state ---
    this.selection = null; // {kind: 'node'|'agent', id}
    this.hover = null;
    this._selAdj = new Set();

    // --- scratch ---
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();

    this._fitted = keepView;
    this._userMoved = keepView;
    this._onControlStart = () => (this._userMoved = true);
    this.vizScene.controls.addEventListener('start', this._onControlStart);

    this._stopFrame = this.vizScene.onFrame((dt) => {
      this._flush();
      this._animateAgents(dt);
    });
  }

  // ------------------------------------------------------------- vertices

  _nodeRadius(node) {
    const degree = (this.adj.get(node.id) || EMPTY).size;
    return NODE_RADIUS * (0.7 + 0.35 * Math.log2(1 + degree));
  }

  _groupFor(group) {
    if (group === undefined || group === null) return null;
    const key = String(group);
    let info = this.groupInfo.get(key);
    if (!info) {
      // Golden-angle hue steps keep successive groups visually distinct.
      const hue = ((this.groupInfo.size * 137.508) % 360) / 360;
      info = { group: key, color: new THREE.Color().setHSL(hue, 0.65, 0.58), count: 0 };
      this.groupInfo.set(key, info);
    }
    return info;
  }

  upsertVertex(event) {
    const id = String(event.id);
    let slot = this.nodeIndex.get(id);
    let node;
    if (slot === undefined) {
      slot = this.nodePool.add(id);
      node = { id, slot, position: new THREE.Vector3(), auto: true, label: null, group: null, attrs: null, value: undefined };
      this.nodes[slot] = node;
      this.nodeIndex.set(id, slot);
      this._layoutDirty = true;
    } else {
      node = this.nodes[slot];
    }

    if (Array.isArray(event.position)) {
      node.position.set(event.position[0], event.position[1], event.position[2]);
      if (node.auto) this._layoutDirty = true; // its old auto slot no longer counts
      node.auto = false;
    }
    const label = event.label ?? event.name;
    if (label !== undefined) node.label = String(label);
    if (event.attrs) node.attrs = event.attrs;
    if (event.group !== undefined) {
      const old = node.group ? this.groupInfo.get(node.group) : null;
      if (old) old.count--;
      const info = this._groupFor(event.group);
      node.group = info ? info.group : null;
      if (info) info.count++;
    }

    if (Array.isArray(event.neighbors)) {
      for (const n of event.neighbors) this._addEdge(id, String(n));
    }
    this._dirtyNodes.add(slot);
  }

  _addEdge(a, b) {
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edgeList.push([a, b]);
    for (const [x, y] of [[a, b], [b, a]]) {
      let set = this.adj.get(x);
      if (!set) this.adj.set(x, (set = new Set()));
      set.add(y);
      const slot = this.nodeIndex.get(x);
      if (slot !== undefined) this._dirtyNodes.add(slot); // degree changed -> size changed
    }
    this._edgesDirty = true;
  }

  setPlaceValue(id, value) {
    const slot = this.nodeIndex.get(String(id));
    if (slot === undefined) return;
    if (!Number.isFinite(value)) return; // see gridRenderer.setPlace
    this.nodes[slot].value = value;
    this.colorScale.observe(value);
    if (this.colorMode === 'value') this._dirtyNodes.add(slot);
  }

  setPlaceRange(min, max) {
    this.colorScale.setRange(min, max);
    if (this.colorMode === 'value') this._allNodesDirty = true;
  }

  setColorMode(mode) {
    this.colorMode = mode === 'value' ? 'value' : 'group';
    this._allNodesDirty = true;
  }

  setEdgeMode(mode) {
    this.edgeMode = EDGE_STYLES[mode] === undefined ? 'faint' : mode;
    this._applyEdgeStyle();
  }

  setAgentsVisible(visible) {
    this.agentsVisible = visible;
    for (const pool of Object.values(this.agentPools)) {
      pool.visible = visible;
      pool.mesh.visible = visible;
    }
  }

  _applyEdgeStyle() {
    const style = EDGE_STYLES[this.edgeMode];
    this.edgeLines.visible = !!style;
    if (style) this.edgeLines.material.opacity = style.opacity;
  }

  // ---------------------------------------------------------------- flush

  // Applies everything accumulated since the last frame: auto-layout (using
  // the final vertex count, so early vertices aren't spread on a sparser
  // spiral than late ones), instance matrices/colors, edge geometry.
  _flush() {
    let repositioned = false;
    if (this._layoutDirty) {
      this._layoutAuto();
      this._layoutDirty = false;
      this._allNodesDirty = true;
      repositioned = true;
    }

    if (this._allNodesDirty || this._dirtyNodes.size) {
      if (this._allNodesDirty) {
        for (let i = 0; i < this.nodes.length; i++) this._writeNode(this.nodes[i]);
      } else {
        for (const slot of this._dirtyNodes) this._writeNode(this.nodes[slot]);
      }
      this._dirtyNodes.clear();
      this._allNodesDirty = false;
      this.nodePool.commit();
      this._edgesDirty = this._edgesDirty || repositioned;
      // Nodes moved or changed size (new edges): keep resting agents on them.
      if (this._edgesDirty) this._repositionAgents();
    }

    if (this._edgesDirty) {
      this._rebuildEdges();
      this._edgesDirty = false;
    }

    for (const pool of Object.values(this.agentPools)) pool.commit();

    if (!this._fitted && this.nodes.length > 0) this._fitCamera();
    else if (!this._userMoved && repositioned) this._fitCamera();
  }

  _layoutAuto() {
    const auto = this.nodes.filter((n) => n.auto);
    const n = auto.length;
    if (n === 0) return;
    const radius = Math.max(8, 0.85 * Math.sqrt(n));
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / Math.max(1, n - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      auto[i].position.set(Math.cos(theta) * r, y, Math.sin(theta) * r).multiplyScalar(radius);
    }
  }

  _baseNodeColor(node, out) {
    if (this.colorMode === 'value') {
      return node.value === undefined ? out.setHex(NO_VALUE_COLOR) : out.setHex(this.colorScale.colorFor(node.value));
    }
    const info = node.group ? this.groupInfo.get(node.group) : null;
    return info ? out.copy(info.color) : out.setHex(0x6fa8dc);
  }

  _writeNode(node) {
    const sel = this.selection && this.selection.kind === 'node' ? this.selection.id : null;
    let scale = this._nodeRadius(node);
    const color = this._baseNodeColor(node, this._c);
    if (sel) {
      if (node.id === sel) {
        color.setHex(0xffffff);
        scale *= 1.8;
      } else if (!this._selAdj.has(node.id)) {
        color.lerp(BACKGROUND, DIM_AMOUNT);
      }
    }
    this._m.compose(node.position, Q_IDENT, this._s.setScalar(scale));
    this.nodePool.setMatrix(node.slot, this._m);
    this.nodePool.setColor(node.slot, color);
  }

  _rebuildEdges() {
    const arr = new Float32Array(this.edgeList.length * 6);
    let n = 0;
    for (const [a, b] of this.edgeList) {
      const sa = this.nodeIndex.get(a);
      const sb = this.nodeIndex.get(b);
      if (sa === undefined || sb === undefined) continue;
      const pa = this.nodes[sa].position;
      const pb = this.nodes[sb].position;
      arr[n++] = pa.x; arr[n++] = pa.y; arr[n++] = pa.z;
      arr[n++] = pb.x; arr[n++] = pb.y; arr[n++] = pb.z;
    }
    this.edgeLines.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(arr.subarray(0, n), 3));
    this.edgeLines.geometry = geometry;
    this._applyEdgeStyle();
  }

  _rebuildHighlight() {
    const id = this._focusNodeId();
    const positions = [];
    if (id !== null) {
      const slot = this.nodeIndex.get(id);
      const from = slot === undefined ? null : this.nodes[slot].position;
      if (from) {
        for (const nb of this.adj.get(id) || EMPTY) {
          const s = this.nodeIndex.get(nb);
          if (s === undefined) continue;
          const to = this.nodes[s].position;
          positions.push(from.x, from.y, from.z, to.x, to.y, to.z);
        }
      }
    }
    this.highlightLines.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.highlightLines.geometry = geometry;
  }

  // The node whose edges should be highlighted: the selection if any, else the hover.
  _focusNodeId() {
    const s = this.selection && this.selection.kind === 'node' ? this.selection : null;
    if (s) return s.id;
    return this.hover && this.hover.kind === 'node' ? this.hover.id : null;
  }

  _fitCamera() {
    if (this.nodes.length === 0) return;
    const center = new THREE.Vector3();
    for (const n of this.nodes) center.add(n.position);
    center.multiplyScalar(1 / this.nodes.length);
    let radius = 1;
    for (const n of this.nodes) radius = Math.max(radius, n.position.distanceTo(center));
    const cam = this.vizScene.camera;
    cam.position.copy(center).add(new THREE.Vector3(0.4, 0.5, 1).normalize().multiplyScalar(radius * 2.4));
    cam.far = Math.max(2000, radius * 10);
    cam.updateProjectionMatrix();
    this.vizScene.controls.target.copy(center);
    this._fitted = true;
  }

  // ---------------------------------------------------------------- agents

  _restPosition(agent, out) {
    const slot = this.nodeIndex.get(agent.at);
    if (slot === undefined) return null;
    const node = this.nodes[slot];
    return out.copy(node.position).setY(node.position.y + this._nodeRadius(node) + AGENT_GAP);
  }

  _poolFor(shape) {
    const key = AGENT_SHAPES[shape] ? shape : 'sphere';
    let pool = this.agentPools[key];
    if (!pool) {
      pool = this.agentPools[key] = new InstancedPool(this.group, AGENT_SHAPES[key](), new THREE.MeshLambertMaterial(), 256);
      pool.visible = this.agentsVisible;
      pool.mesh.visible = this.agentsVisible;
    }
    return { key, pool };
  }

  _writeAgent(agent) {
    const scale = this.selection && this.selection.kind === 'agent' && this.selection.id === agent.id ? 2.4 : 1;
    this._m.compose(agent.cur, Q_IDENT, this._s.setScalar(scale));
    agent.pool.setMatrix(agent.slot, this._m);
  }

  _writeAgentColor(agent) {
    const selected = this.selection && this.selection.kind === 'agent' && this.selection.id === agent.id;
    agent.pool.setColor(agent.slot, selected ? this._c.setHex(0xffffff) : this._c.setHex(agent.color ?? 0xffee55));
  }

  spawnAgent(id, at, color, shape, name, attrs) {
    id = String(id);
    at = String(at);
    if (!this.nodeIndex.has(at)) return;
    if (this.agents.has(id)) this.removeAgent(id); // re-spawn with the same id replaces it
    const { key, pool } = this._poolFor(shape);
    const agent = {
      id, at, color, shape: key, name, attrs, moves: 0, pool,
      slot: pool.add(id),
      cur: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(),
      t: 1, duration: AGENT_MOVE_SECONDS,
    };
    this._restPosition(agent, agent.cur);
    agent.from.copy(agent.cur);
    agent.to.copy(agent.cur);
    this.agents.set(id, agent);
    this._writeAgent(agent);
    this._writeAgentColor(agent);
  }

  // `speed` is the protocol's agent_move speed multiplier (>1 = faster).
  moveAgent(id, to, instant, speed) {
    const agent = this.agents.get(String(id));
    if (!agent) return;
    const dest = String(to);
    if (!this.nodeIndex.has(dest)) return;
    agent.at = dest;
    agent.moves++;
    const target = this._restPosition(agent, this._v);
    if (instant) {
      agent.cur.copy(target);
      agent.from.copy(target);
      agent.to.copy(target);
      agent.t = 1;
      this.moving.delete(agent);
      this._writeAgent(agent);
      return;
    }
    agent.from.copy(agent.cur);
    agent.to.copy(target);
    agent.t = 0;
    agent.duration = AGENT_MOVE_SECONDS / (speed > 0 ? speed : 1);
    this.moving.add(agent);
  }

  updateAgent(event) {
    const agent = this.agents.get(String(event.id));
    if (!agent) return;
    if (event.color !== undefined) {
      agent.color = event.color;
      this._writeAgentColor(agent);
    }
    if (event.name !== undefined) agent.name = event.name;
    if (event.attrs) agent.attrs = Object.assign({}, agent.attrs, event.attrs);
  }

  removeAgent(id) {
    id = String(id);
    const agent = this.agents.get(id);
    if (!agent) return;
    this.moving.delete(agent);
    const movedId = agent.pool.remove(agent.slot);
    if (movedId !== null) this.agents.get(movedId).slot = agent.slot;
    this.agents.delete(id);
    if (this.selection && this.selection.kind === 'agent' && this.selection.id === id) this.setSelection(null);
  }

  // After nodes move (layout) or resize (degree), keep agents sitting on them.
  _repositionAgents() {
    for (const agent of this.agents.values()) {
      const rest = this._restPosition(agent, this._v);
      if (!rest) continue;
      if (agent.t >= 1) {
        agent.cur.copy(rest);
        agent.from.copy(rest);
        agent.to.copy(rest);
        this._writeAgent(agent);
      } else {
        agent.to.copy(rest);
      }
    }
  }

  _animateAgents(dt) {
    if (this.moving.size === 0) return;
    for (const agent of this.moving) {
      agent.t = Math.min(1, agent.t + dt / agent.duration);
      agent.cur.lerpVectors(agent.from, agent.to, agent.t);
      this._writeAgent(agent);
      if (agent.t >= 1) this.moving.delete(agent);
    }
  }

  // ----------------------------------------------------------- interaction

  // Nearest node or agent under `raycaster`, as {kind, id}, or null.
  pick(raycaster) {
    const meshes = [this.nodePool.mesh];
    if (this.agentsVisible) for (const p of Object.values(this.agentPools)) meshes.push(p.mesh);
    // InstancedMesh caches its bounding sphere on first use; instances move
    // afterwards, so a stale sphere would make raycasts miss them.
    for (const m of meshes) m.computeBoundingSphere();
    const hits = raycaster.intersectObjects(meshes, false);
    for (const hit of hits) {
      if (hit.instanceId === undefined) continue;
      if (hit.object === this.nodePool.mesh) return { kind: 'node', id: this.nodes[hit.instanceId].id };
      const pool = Object.values(this.agentPools).find((p) => p.mesh === hit.object);
      if (pool) return { kind: 'agent', id: pool.ids[hit.instanceId] };
    }
    return null;
  }

  setHover(sel) {
    const same = (a, b) => (!a && !b) || (a && b && a.kind === b.kind && a.id === b.id);
    if (same(sel, this.hover)) return;
    this.hover = sel;
    this._rebuildHighlight();
  }

  setSelection(sel) {
    const prev = this.selection;
    this.selection = sel;
    this._selAdj = new Set();
    if (sel && sel.kind === 'node') this._selAdj = new Set(this.adj.get(sel.id) || EMPTY);
    // Dimming touches every node's color; an agent selection only touches that agent.
    if ((prev && prev.kind === 'node') || (sel && sel.kind === 'node')) this._allNodesDirty = true;
    for (const s of [prev, sel]) {
      if (s && s.kind === 'agent') {
        const agent = this.agents.get(s.id);
        if (agent) {
          this._writeAgent(agent);
          this._writeAgentColor(agent);
        }
      }
    }
    this._rebuildHighlight();
  }

  _label(id) {
    const slot = this.nodeIndex.get(id);
    const node = slot === undefined ? null : this.nodes[slot];
    return node && node.label ? node.label : id;
  }

  // Everything the inspector shows for a node or agent.
  describe(sel) {
    if (!sel) return null;
    if (sel.kind === 'node') {
      const slot = this.nodeIndex.get(sel.id);
      if (slot === undefined) return null;
      const node = this.nodes[slot];
      const neighbors = Array.from(this.adj.get(node.id) || EMPTY);
      const here = [];
      for (const a of this.agents.values()) if (a.at === node.id) here.push(a.id);
      const rows = [['id', node.id]];
      if (node.group !== null) rows.push(['group', node.group]);
      rows.push(['connections', String(neighbors.length)]);
      if (node.value !== undefined) rows.push(['value', String(node.value)]);
      rows.push(['agents here', String(here.length)]);
      if (node.attrs) for (const [k, v] of Object.entries(node.attrs)) rows.push([k, String(v)]);
      return {
        kind: 'node',
        id: node.id,
        title: node.label || node.id,
        rows,
        links: neighbors.slice(0, 40).map((id) => ({ kind: 'node', id, text: this._label(id) })),
        linksTitle: `connections${neighbors.length > 40 ? ' (first 40)' : ''}`,
        links2: here.slice(0, 40).map((id) => ({ kind: 'agent', id, text: this._agentLabel(id) })),
        links2Title: `agents here${here.length > 40 ? ' (first 40)' : ''}`,
      };
    }
    const agent = this.agents.get(sel.id);
    if (!agent) return null;
    const rows = [['id', agent.id]];
    rows.push(['at', this._label(agent.at)]);
    rows.push(['shape', agent.shape]);
    rows.push(['moves', String(agent.moves)]);
    if (agent.attrs) for (const [k, v] of Object.entries(agent.attrs)) rows.push([k, String(v)]);
    return {
      kind: 'agent',
      id: agent.id,
      title: agent.name || agent.id,
      rows,
      links: [{ kind: 'node', id: agent.at, text: this._label(agent.at) }],
      linksTitle: 'current location',
      links2: [],
      links2Title: '',
    };
  }

  _agentLabel(id) {
    const a = this.agents.get(id);
    return a && a.name ? a.name : id;
  }

  // First node (or, failing that, agent) whose id/label/name matches `query`.
  search(query) {
    const q = String(query).trim().toLowerCase();
    if (!q) return null;
    const exact = this.nodeIndex.get(String(query).trim());
    if (exact !== undefined) return { kind: 'node', id: this.nodes[exact].id };
    for (const n of this.nodes) {
      if ((n.label && n.label.toLowerCase().includes(q)) || n.id.toLowerCase() === q) return { kind: 'node', id: n.id };
    }
    for (const a of this.agents.values()) {
      if (a.id.toLowerCase() === q || (a.name && a.name.toLowerCase().includes(q))) return { kind: 'agent', id: a.id };
    }
    return null;
  }

  // Aims the camera at a node or agent, keeping the current viewing direction.
  focus(sel) {
    let target = null;
    if (sel.kind === 'node') {
      const slot = this.nodeIndex.get(sel.id);
      if (slot !== undefined) target = this.nodes[slot].position;
    } else {
      const agent = this.agents.get(sel.id);
      if (agent) target = agent.cur;
    }
    if (!target) return;
    const cam = this.vizScene.camera;
    const controls = this.vizScene.controls;
    const offset = cam.position.clone().sub(controls.target).setLength(30);
    controls.target.copy(target);
    cam.position.copy(target).add(offset);
    this._userMoved = true;
  }

  // Largest communities first, for the legend.
  getGroups(limit = 12) {
    return Array.from(this.groupInfo.values())
      .filter((g) => g.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((g) => ({ group: g.group, count: g.count, color: '#' + g.color.getHexString() }));
  }

  get groupCount() {
    return Array.from(this.groupInfo.values()).filter((g) => g.count > 0).length;
  }

  dispose() {
    this._stopFrame();
    this.vizScene.controls.removeEventListener('start', this._onControlStart);
    this.nodePool.dispose();
    for (const pool of Object.values(this.agentPools)) pool.dispose();
    this.edgeLines.geometry.dispose();
    this.edgeLines.material.dispose();
    this.highlightLines.geometry.dispose();
    this.highlightLines.material.dispose();
    this.vizScene.scene.remove(this.group);
  }
}

const EMPTY = new Set();
