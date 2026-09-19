import * as THREE from '/vendor/three.module.js';
import { ColorScale } from './colorScale.js';

const CELL_SIZE = 1;
const CELL_GAP = 0.08;
const CELL_HEIGHT = 0.15; // thin flat tile - this is a top-down 2D view, height is never actually seen
const AGENT_HEIGHT = 0.3; // small lift above the tile surface, purely to avoid z-fighting
const AGENT_MOVE_SECONDS = 0.5;

// Renders a 2D lattice of MASS Places as an instanced tile mesh, colored by
// each place's scalar value, viewed top-down (see scene.js's useCamera('2d')
// - orthographic, no rotation, pan/zoom only), plus agents as small marker
// meshes that smoothly move between cell centers.
export class GridRenderer {
  constructor(vizScene, dims) {
    this.vizScene = vizScene;
    this.vizScene.useCamera('2d');
    this.dims = dims;
    this.colorScale = new ColorScale(0, 1);
    this.cellIndex = new Map(); // "x,y" -> instance id

    const [w, h] = this.dims;
    const count = w * h;
    const geometry = new THREE.BoxGeometry(CELL_SIZE - CELL_GAP, CELL_HEIGHT, CELL_SIZE - CELL_GAP);
    // Deliberately NOT { vertexColors: true } here: for an InstancedMesh,
    // having instanceColor set already defines USE_INSTANCING_COLOR (and,
    // in the fragment shader, USE_COLOR via an OR with instancingColor) -
    // everything needed. Setting material.vertexColors also defines
    // USE_COLOR in the *vertex* shader, which then does `vColor *= color`
    // against this BoxGeometry's nonexistent per-vertex `color` attribute
    // (reads as (0,0,0) per WebGL's default for an unbound attribute),
    // zeroing every instance to black before the instanceColor multiply
    // ever runs. Confirmed by reading three.js's own WebGLProgram.js
    // (vertex-shader USE_COLOR is keyed only off material.vertexColors;
    // fragment-shader USE_COLOR also accepts instancingColor) and the
    // color_vertex/color_fragment shader chunks.
    const material = new THREE.MeshLambertMaterial();
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);

    const dummy = new THREE.Object3D();
    let i = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const pos = this._cellToWorld([x, y]);
        dummy.position.copy(pos);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(i, dummy.matrix);
        this.mesh.setColorAt(i, new THREE.Color(0x334455));
        this.cellIndex.set([x, y].join(','), i);
        i++;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.vizScene.scene.add(this.group);

    this.agents = new Map(); // id -> {mesh, from, to, t}
    this._stopFrame = this.vizScene.onFrame((dt) => this._animateAgents(dt));

    const center = this._cellToWorld([(w - 1) / 2, (h - 1) / 2]);
    this.vizScene.camera.position.set(center.x, this.vizScene.camera.position.y, center.z);
    this.vizScene.camera.lookAt(center);
    this.vizScene.controls.target.copy(center);
  }

  // World X = grid x (screen right), world Z = -grid y (screen up), world Y
  // is the fixed top-down viewing axis - see scene.js's '2d' camera, which
  // looks straight down with up=(0,0,-1) so this mapping reads correctly.
  _cellToWorld([x, y]) {
    const [w, h] = this.dims;
    return new THREE.Vector3(
      (x - (w - 1) / 2) * CELL_SIZE,
      0,
      -(y - (h - 1) / 2) * CELL_SIZE
    );
  }

  setPlace(index, value) {
    const key = index.join(',');
    const i = this.cellIndex.get(key);
    if (i === undefined) return;
    // A non-finite value (a diverging simulation, or a `null` an adapter
    // emitted in place of NaN/Infinity - see PROTOCOL.md) carries no color
    // information. Leave the cell at its last known color rather than
    // painting it whatever colorFor() coerces a null into.
    if (!Number.isFinite(value)) return;
    this.colorScale.observe(value);
    this.mesh.setColorAt(i, new THREE.Color(this.colorScale.colorFor(value)));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  // Dense/full-grid update: values[i] is cell [x,y] where i = y*width + x,
  // matching how cellIndex was built in the constructor. Skips the
  // per-cell Map-key-string churn setPlace does, and only flags
  // instanceColor dirty once for the whole grid instead of once per cell.
  setPlaceGrid(values) {
    const [w, h] = this.dims;
    const color = new THREE.Color();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const value = values[i];
        if (!Number.isFinite(value)) continue; // undefined, null, NaN - see setPlace
        this.colorScale.observe(value);
        this.mesh.setColorAt(i, color.setHex(this.colorScale.colorFor(value)));
      }
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  setPlaceRange(min, max) {
    this.colorScale.setRange(min, max);
  }

  spawnAgent(id, at, color) {
    const geometry = new THREE.SphereGeometry(CELL_SIZE * 0.28, 16, 12);
    const material = new THREE.MeshLambertMaterial({ color: color ?? 0xffee55 });
    const mesh = new THREE.Mesh(geometry, material);
    const pos = this._cellToWorld(at).add(new THREE.Vector3(0, AGENT_HEIGHT, 0));
    mesh.position.copy(pos);
    this.group.add(mesh);
    this.agents.set(String(id), { mesh, from: pos.clone(), to: pos.clone(), t: 1 });
  }

  moveAgent(id, to, instant) {
    const agent = this.agents.get(String(id));
    if (!agent) return;
    const target = this._cellToWorld(to).add(new THREE.Vector3(0, AGENT_HEIGHT, 0));
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
    this.vizScene.scene.remove(this.group);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
