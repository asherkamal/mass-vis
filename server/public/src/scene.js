import * as THREE from '/vendor/three.module.js';
import { OrbitControls } from '/vendor/OrbitControls.js';

// Shared three.js scene/renderer/lights used by both the grid and graph
// renderers, plus a per-frame animation callback registry so each renderer
// can drive its own agent-position interpolation. Camera/controls are
// switchable per mode via useCamera(): grid mode is a true 2D top-down
// orthographic view (pan/zoom only, no rotation - there's no third
// dimension to look at from an angle), graph mode keeps a 3D perspective
// orbit view since its layout is genuinely spatial.
export class MassVizScene {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0f14);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 1.1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(50, 80, 30);
    this.scene.add(dir);

    this.camera = null;
    this.controls = null;
    this.cameraMode = null;
    this.useCamera('3d');

    this._frameCallbacks = new Set();
    this._clock = new THREE.Clock();

    window.addEventListener('resize', () => this._onResize());
    this._tick();
    this._startFpsDisplay();
  }

  // mode: "2d" (orthographic, top-down, pan/zoom only) or "3d" (perspective, free orbit).
  useCamera(mode) {
    if (mode === this.cameraMode) return;
    if (this.controls) this.controls.dispose();

    const aspect = this.container.clientWidth / this.container.clientHeight;

    if (mode === '2d') {
      const viewHeight = 20; // half-height of the view in world units at default zoom
      this.camera = new THREE.OrthographicCamera(
        -viewHeight * aspect,
        viewHeight * aspect,
        viewHeight,
        -viewHeight,
        0.1,
        2000
      );
      this.camera.position.set(0, 50, 0);
      this.camera.up.set(0, 0, -1); // looking straight down; keeps grid "up" mapped to screen "up"
      this.camera.lookAt(0, 0, 0);

      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableRotate = false;
      this.controls.screenSpacePanning = true;
      this.controls.enableDamping = true;
    } else {
      this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 2000);
      this.camera.position.set(30, 40, 60);

      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
    }

    this.cameraMode = mode;
  }

  _onResize() {
    const aspect = this.container.clientWidth / this.container.clientHeight;
    if (this.camera.isOrthographicCamera) {
      const viewHeight = this.camera.top;
      this.camera.left = -viewHeight * aspect;
      this.camera.right = viewHeight * aspect;
    } else {
      this.camera.aspect = aspect;
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  onFrame(cb) {
    this._frameCallbacks.add(cb);
    return () => this._frameCallbacks.delete(cb);
  }

  _tick = () => {
    requestAnimationFrame(this._tick);
    const dt = this._clock.getDelta();
    for (const cb of this._frameCallbacks) cb(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._frameCount = (this._frameCount || 0) + 1;
  };

  // Updates the #fps readout in the top bar once a second from the number
  // of actual render() calls (started in the constructor; also what the
  // mass-viz vs. graphosaurus comparison in benchmark/RESULTS.md read).
  _startFpsDisplay() {
    let lastCount = 0;
    let lastTime = performance.now();
    setInterval(() => {
      const now = performance.now();
      const count = this._frameCount || 0;
      const dt = (now - lastTime) / 1000;
      const fps = dt > 0 ? (count - lastCount) / dt : 0;
      const el = document.getElementById('fps');
      if (el) el.textContent = fps.toFixed(1) + ' FPS';
      lastCount = count;
      lastTime = now;
    }, 1000);
  }
}
