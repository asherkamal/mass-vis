import * as THREE from '/vendor/three.module.js';
import { ColorScale } from './colorScale.js';

const NODE_RADIUS = 0.6;
const AGENT_HOVER_HEIGHT = NODE_RADIUS + 0.6; // clears the node sphere's surface with a visible gap
const AGENT_MOVE_SECONDS = 0.6;
const SHAPE_GEOMETRY = {
  sphere: () => new THREE.SphereGeometry(0.35, 14, 10),
  cube: () => new THREE.BoxGeometry(0.5, 0.5, 0.5),
  cone: () => new THREE.ConeGeometry(0.35, 0.7, 12),
};

// Renders an arbitrary MASS graph (GraphPlaces/VertexPlace topology) as
// spheres + line edges, with agents animated moving vertex-to-vertex.
// Vertices without an explicit position are laid out deterministically on a
// Fibonacci sphere, scaled to the vertex count, so the graph stays legible
// without needing a force-directed layout pass.
export class GraphRenderer {
  constructor(vizScene) {
    this.vizScene = vizScene;
    this.vizScene.useCamera('3d');
    this.colorScale = new ColorScale(0, 1);

    this.group = new THREE.Group();
    this.vizScene.scene.add(this.group);

    this.vertices = new Map(); // id -> {position, mesh, edgeSet}
    this.edgeKeys = new Set();
    this.edgeLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x5b7083 })
    );
    this.group.add(this.edgeLines);

    this.agents = new Map(); // id -> {mesh, from, to, t}
    this._stopFrame = this.vizScene.onFrame((dt) => this._animateAgents(dt));

    this._nextLayoutIndex = 0;
    this._layoutRadius = 8;
  }

  _fibonacciSpherePosition(i, n) {
    const radius = this._layoutRadius * (1 + Math.log2(Math.max(2, n)) * 0.25);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    return new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).multiplyScalar(radius);
  }

  upsertVertex(event) {
    const id = String(event.id);
    let v = this.vertices.get(id);
    if (!v) {
      const geometry = new THREE.SphereGeometry(NODE_RADIUS, 16, 12);
      const material = new THREE.MeshLambertMaterial({ color: 0x6fa8dc });
      const mesh = new THREE.Mesh(geometry, material);
      this.group.add(mesh);
      v = { position: null, mesh };
      this.vertices.set(id, v);
    }

    const position = event.position
      ? new THREE.Vector3(event.position[0], event.position[1], event.position[2])
      : this._fibonacciSpherePosition(this._nextLayoutIndex++, Math.max(this.vertices.size, 8));
    v.position = position;
    v.mesh.position.copy(position);

    if (Array.isArray(event.neighbors)) {
      for (const n of event.neighbors) {
        const key = [id, String(n)].sort().join('|');
        this.edgeKeys.add(key);
      }
    }
    this._rebuildEdges();
  }

  setPlaceValue(id, value) {
    const v = this.vertices.get(String(id));
    if (!v) return;
    this.colorScale.observe(value);
    v.mesh.material.color.setHex(this.colorScale.colorFor(value));
  }

  setPlaceRange(min, max) {
    this.colorScale.setRange(min, max);
  }

  _rebuildEdges() {
    const positions = [];
    for (const key of this.edgeKeys) {
      const [a, b] = key.split('|');
      const va = this.vertices.get(a);
      const vb = this.vertices.get(b);
      if (!va || !vb) continue;
      positions.push(va.position.x, va.position.y, va.position.z);
      positions.push(vb.position.x, vb.position.y, vb.position.z);
    }
    this.edgeLines.geometry.dispose();
    this.edgeLines.geometry = new THREE.BufferGeometry();
    this.edgeLines.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3)
    );
  }

  // Agents hover above their vertex rather than sitting at its exact
  // center - otherwise a resting agent (radius ~0.35) is fully engulfed
  // inside the node sphere (radius 0.6) and invisible except mid-flight,
  // when it's briefly at some distinct point between two vertices.
  _agentRestPosition(vertexPosition) {
    return vertexPosition.clone().add(new THREE.Vector3(0, AGENT_HOVER_HEIGHT, 0));
  }

  spawnAgent(id, at, color, shape) {
    const v = this.vertices.get(String(at));
    if (!v) return;
    const geometry = (SHAPE_GEOMETRY[shape] || SHAPE_GEOMETRY.sphere)();
    const material = new THREE.MeshLambertMaterial({ color: color ?? 0xffee55 });
    const mesh = new THREE.Mesh(geometry, material);
    const pos = this._agentRestPosition(v.position);
    mesh.position.copy(pos);
    this.group.add(mesh);
    this.agents.set(String(id), { mesh, from: pos.clone(), to: pos.clone(), t: 1 });
  }

  moveAgent(id, to, instant) {
    const agent = this.agents.get(String(id));
    const v = this.vertices.get(String(to));
    if (!agent || !v) return;
    const target = this._agentRestPosition(v.position);
    if (instant) {
      agent.mesh.position.copy(target);
      agent.from = target.clone();
      agent.to = target.clone();
      agent.t = 1;
      return;
    }
    agent.from = agent.mesh.position.clone();
    agent.to = target;
    agent.t = 0;
  }

  removeAgent(id) {
    const agent = this.agents.get(String(id));
    if (!agent) return;
    this.group.remove(agent.mesh);
    agent.mesh.geometry.dispose();
    agent.mesh.material.dispose();
    this.agents.delete(String(id));
  }

  _animateAgents(dt) {
    for (const agent of this.agents.values()) {
      if (agent.t >= 1) continue;
      agent.t = Math.min(1, agent.t + dt / AGENT_MOVE_SECONDS);
      agent.mesh.position.lerpVectors(agent.from, agent.to, agent.t);
    }
  }

  dispose() {
    this._stopFrame();
    for (const id of Array.from(this.agents.keys())) this.removeAgent(id);
    for (const v of this.vertices.values()) {
      this.group.remove(v.mesh);
      v.mesh.geometry.dispose();
      v.mesh.material.dispose();
    }
    this.edgeLines.geometry.dispose();
    this.vizScene.scene.remove(this.group);
  }
}
