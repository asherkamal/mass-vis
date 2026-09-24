import * as THREE from '/vendor/three.module.js';
import { MassVizScene } from './scene.js';
import { GridRenderer } from './gridRenderer.js';
import { GraphRenderer } from './graphRenderer.js';
import { RunConnection } from './connection.js';
import { PlaybackControls } from './playback.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const runSelect = $('runSelect');
const sourceMode = $('sourceMode');
const connectBtn = $('connectBtn');
const statusEl = $('status');
const legendEl = $('legend');
const legendMin = $('legendMin');
const legendMax = $('legendMax');
const groupLegendEl = $('groupLegend');
const graphControls = $('graphControls');
const searchBox = $('searchBox');
const edgeModeSel = $('edgeMode');
const colorModeSel = $('colorMode');
const agentsToggle = $('agentsToggle');
const inspectorEl = $('inspector');
const tipEl = $('tip');
const pauseBtn = $('pauseBtn');
const endBtn = $('endBtn');
const goLiveBtn = $('goLiveBtn');
const refreshBtn = $('refreshBtn');
const liveStepEl = $('liveStep');
// How much history a replay loads: the last N steps (0 = the whole recording).
// A busy run records hundreds of KB per step, so the default is a window.
const windowSelect = $('windowSelect');

const vizScene = new MassVizScene(viewport);
let activeRenderer = null; // GridRenderer | GraphRenderer
let activeMode = null; // "grid" | "graph"
let activeRunId = null;
let selection = null; // {kind, id} - survives renderer rebuilds (replay seeks)
let replayLiveCapable = false; // replay of a run that may still be producing: offer Go Live / Refresh
const activeRuns = new Set(); // runIds the server currently has in memory

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

// ------------------------------------------------------------- legends

let legendPending = false;
function updateLegend() {
  if (legendPending) return; // events arrive in bursts of thousands; repaint once per frame
  legendPending = true;
  requestAnimationFrame(() => {
    legendPending = false;
    if (!activeRenderer) return;
    const scale = activeRenderer.colorScale;
    legendMin.textContent = scale.isSet ? scale.min.toFixed(2) : '–';
    legendMax.textContent = scale.isSet ? scale.max.toFixed(2) : '–';
  });
}

function refreshLegendVisibility() {
  const graph = activeMode === 'graph';
  graphControls.classList.toggle('active', graph);
  const showGradient = !!activeRenderer && (!graph || activeRenderer.colorMode === 'value');
  legendEl.style.display = showGradient ? 'flex' : 'none';
  if (!(graph && activeRenderer && activeRenderer.colorMode === 'group')) groupLegendEl.classList.remove('active');
}

function refreshGroupLegend() {
  if (activeMode !== 'graph' || !activeRenderer || activeRenderer.colorMode !== 'group') return;
  const groups = activeRenderer.getGroups(12);
  if (groups.length === 0) {
    groupLegendEl.classList.remove('active');
    return;
  }
  groupLegendEl.replaceChildren();
  const title = document.createElement('div');
  title.className = 'legendTitle';
  const total = activeRenderer.groupCount;
  title.textContent = total > groups.length ? `groups (largest ${groups.length} of ${total})` : 'groups';
  groupLegendEl.appendChild(title);
  for (const g of groups) {
    const row = document.createElement('div');
    row.className = 'groupRow';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = g.color;
    row.append(sw, document.createTextNode(`${g.group} · ${g.count}`));
    groupLegendEl.appendChild(row);
  }
  groupLegendEl.classList.add('active');
}
setInterval(refreshGroupLegend, 700);

// ----------------------------------------------------------- renderer

function teardownRenderer() {
  if (activeRenderer) {
    activeRenderer.dispose();
    activeRenderer = null;
    activeMode = null;
  }
  refreshLegendVisibility();
}

// `keepView`: a rebuild of the same graph (replay seek) must not reset the
// camera the user has orbited/zoomed to.
function setupRenderer(mode, dims, keepView) {
  teardownRenderer();
  activeMode = mode;
  if (mode === 'grid') {
    activeRenderer = new GridRenderer(vizScene, dims || [16, 16]);
  } else {
    activeRenderer = new GraphRenderer(vizScene, { keepView });
    activeRenderer.setEdgeMode(edgeModeSel.value);
    activeRenderer.setColorMode(colorModeSel.value);
    activeRenderer.setAgentsVisible(agentsToggle.checked);
  }
  refreshLegendVisibility();
  updateLegend();
}

function restoreSelection() {
  if (!selection || activeMode !== 'graph' || !activeRenderer) return;
  if (!activeRenderer.describe(selection)) {
    selection = null;
    return;
  }
  activeRenderer.setSelection(selection);
}

function applyEvent(event, opts) {
  const instant = !!(opts && opts.instant);
  if (event.type === 'init') {
    activeRunId = event.runId;
    setupRenderer(event.mode, event.dims, false);
    selection = null;
    setStatus(`${event.runName || event.runId || 'run'} — ${event.mode}${event.source ? ' · ' + event.source : ''}`, 'ok');
    return;
  }
  if (event.type === 'step') {
    if (connection.mode === 'live') liveStepEl.textContent = `step ${event.step}`;
    return;
  }
  if (!activeRenderer) return; // events before init are ignored, matches server's permissive relay

  switch (event.type) {
    case 'place':
      // Sparse per-cell updates only exist for grids; a graph addresses
      // Places by vertex id (place_value) instead.
      if (activeMode !== 'grid') break;
      if (Array.isArray(event.places)) {
        for (const p of event.places) activeRenderer.setPlace(p.index, p.value);
      } else {
        activeRenderer.setPlace(event.index, event.value);
      }
      break;
    case 'place_grid':
      if (activeMode === 'grid' && Array.isArray(event.values)) activeRenderer.setPlaceGrid(event.values);
      break;
    case 'place_range':
      activeRenderer.setPlaceRange(event.min, event.max);
      break;
    case 'vertex':
      if (activeMode === 'graph') activeRenderer.upsertVertex(event);
      break;
    case 'place_value':
      if (activeMode === 'graph') activeRenderer.setPlaceValue(event.id, event.value);
      break;
    case 'agent_spawn':
      activeRenderer.spawnAgent(event.id, event.at, event.color, event.shape, event.name, event.attrs);
      break;
    case 'agent_move':
      activeRenderer.moveAgent(event.id, event.to, instant, event.speed);
      break;
    case 'agent_update':
      if (activeMode === 'graph') activeRenderer.updateAgent(event);
      break;
    case 'agent_remove':
      activeRenderer.removeAgent(event.id);
      break;
    default:
      return;
  }
  if (event.type === 'place' || event.type === 'place_grid' || event.type === 'place_range' || event.type === 'place_value') {
    updateLegend();
  }
}

// `state` is either the server's live snapshot (grid cells as `places`) or a
// replay keyframe (dense grid as `gridValues`) - see runState.js.
function applySnapshot(state) {
  const sameRun = !!(state && activeRenderer && activeMode === state.mode && activeRunId === state.runId);
  if (!state || !state.mode) {
    teardownRenderer();
    if (connection.mode === 'live') setStatus('watching — waiting for producer to send init…', 'ok');
    return;
  }
  activeRunId = state.runId;
  setupRenderer(state.mode, state.dims, sameRun && state.mode === 'graph');
  if (state.placeRange) activeRenderer.setPlaceRange(state.placeRange.min, state.placeRange.max);
  if (state.mode === 'grid') {
    if (state.gridValues) activeRenderer.setPlaceGrid(state.gridValues);
    for (const p of state.places || []) activeRenderer.setPlace(p.index, p.value);
  } else {
    for (const v of state.vertices) activeRenderer.upsertVertex(v);
    for (const pv of state.placeValues) activeRenderer.setPlaceValue(pv.id, pv.value);
  }
  for (const a of state.agents) activeRenderer.spawnAgent(a.id, a.at, a.color, a.shape, a.name, a.attrs);
  restoreSelection();
  updateLegend();
  if (connection.mode === 'live') {
    liveStepEl.textContent = state.lastStep !== null && state.lastStep !== undefined ? `step ${state.lastStep}` : '';
    setStatus(`${state.runName || state.runId} — ${state.mode}${state.source ? ' · ' + state.source : ''}`, 'ok');
  }
}

const connection = new RunConnection({
  onReset: applySnapshot,
  onEvent: applyEvent,
  onLiveClosed: () => setStatus('live connection closed — press Connect to reconnect', 'err'),
});

const playback = new PlaybackControls(connection, {
  panelEl: $('playback'),
  playPauseBtn: $('playPauseBtn'),
  slider: $('stepSlider'),
  stepLabel: $('stepLabel'),
  speedSelect: $('speedSelect'),
});

// ------------------------------------------------- live <-> replay flow

function updateLiveControls() {
  const live = connection.mode === 'live' && !!connection.ws;
  const replay = connection.mode === 'replay';
  const canReturn = replay && replayLiveCapable && activeRuns.has(connection.runId);
  pauseBtn.style.display = live ? '' : 'none';
  endBtn.style.display = live ? '' : 'none';
  goLiveBtn.style.display = canReturn ? '' : 'none';
  refreshBtn.style.display = canReturn ? '' : 'none';
  liveStepEl.style.display = live ? '' : 'none';
}

async function enterReplay(runId, { absoluteFrame, allowLive }) {
  setStatus(`loading replay ${runId}…`);
  try {
    await connection.loadReplay(runId, { absoluteFrame, tail: Number(windowSelect.value) });
    replayLiveCapable = !!allowLive;
    playback.showForReplay();
    const skipped = connection.skippedLines ? ` — ${connection.skippedLines} unreadable line(s) skipped` : '';
    const w = connection.windowInfo;
    const size = w ? `last ${connection.stepCount - 1} of ${w.totalFrames} steps` : `${connection.stepCount} steps`;
    setStatus(`replay ${runId} (${size})${skipped}`, connection.skippedLines ? 'err' : 'ok');
  } catch (e) {
    replayLiveCapable = false;
    playback.hide();
    setStatus(`could not load replay of ${runId}: ${e.message}`, 'err');
  }
  updateLiveControls();
}

function goLive(runId) {
  // The scene is left in place until the server's snapshot replaces it, so
  // returning to live from a pause keeps the camera where the user put it.
  playback.hide();
  replayLiveCapable = false;
  setStatus(`connecting to ${runId}…`);
  connection.connectLive(runId);
  updateLiveControls();
}

connectBtn.addEventListener('click', () => {
  const runId = runSelect.value || 'default';
  if (sourceMode.value === 'live') goLive(runId);
  else enterReplay(runId, { allowLive: activeRuns.has(runId) });
});
// Pause: freeze on the recorded history so far, scrub freely, and return with Go Live.
pauseBtn.addEventListener('click', () => enterReplay(connection.runId, { allowLive: true }));
// End live: same replay view, but the run is treated as finished (no way back to live).
endBtn.addEventListener('click', () => enterReplay(connection.runId, { allowLive: false }));
goLiveBtn.addEventListener('click', () => goLive(connection.runId));
refreshBtn.addEventListener('click', () => enterReplay(connection.runId, { absoluteFrame: connection.absoluteFrame(connection.currentStep), allowLive: true }));
windowSelect.addEventListener('change', () => {
  if (connection.mode !== 'replay') return;
  enterReplay(connection.runId, { absoluteFrame: connection.absoluteFrame(connection.currentStep), allowLive: replayLiveCapable });
});

async function refreshRunList() {
  try {
    const runs = await connection.listRuns();
    const prev = runSelect.value;
    runSelect.innerHTML = '';
    activeRuns.clear();
    for (const r of runs) {
      if (r.active) activeRuns.add(r.runId);
      const opt = document.createElement('option');
      opt.value = r.runId;
      opt.textContent = `${r.runId}${r.active ? ' (active)' : ''}`;
      runSelect.appendChild(opt);
    }
    if (runs.some((r) => r.runId === prev)) runSelect.value = prev;
    updateLiveControls();
  } catch (e) {
    setStatus('could not reach server', 'err');
  }
}

// -------------------------------------------------------- graph controls

edgeModeSel.addEventListener('change', () => activeRenderer && activeRenderer.setEdgeMode && activeRenderer.setEdgeMode(edgeModeSel.value));
colorModeSel.addEventListener('change', () => {
  if (activeRenderer && activeRenderer.setColorMode) activeRenderer.setColorMode(colorModeSel.value);
  refreshLegendVisibility();
  refreshGroupLegend();
  updateLegend();
});
agentsToggle.addEventListener('change', () => activeRenderer && activeRenderer.setAgentsVisible && activeRenderer.setAgentsVisible(agentsToggle.checked));

function select(sel, focusCamera) {
  selection = sel;
  if (activeMode === 'graph' && activeRenderer) {
    activeRenderer.setSelection(sel);
    if (sel && focusCamera) activeRenderer.focus(sel);
  }
  renderInspector();
}

searchBox.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || activeMode !== 'graph' || !activeRenderer) return;
  const hit = activeRenderer.search(searchBox.value);
  if (hit) {
    select(hit, true);
    searchBox.classList.remove('miss');
  } else {
    searchBox.classList.add('miss');
  }
});

// ------------------------------------------------------------ inspector

let inspectorSig = '';
function renderInspector() {
  const info = selection && activeMode === 'graph' && activeRenderer ? activeRenderer.describe(selection) : null;
  if (!info) {
    inspectorSig = '';
    inspectorEl.classList.remove('active');
    return;
  }
  // Skip the DOM rebuild when nothing changed, so a click on a link button
  // isn't lost to the periodic refresh replacing it mid-press.
  const sig = JSON.stringify(info);
  if (sig === inspectorSig) return;
  inspectorSig = sig;
  const frag = document.createDocumentFragment();

  const head = document.createElement('div');
  head.className = 'inspHead';
  const badge = document.createElement('span');
  badge.className = `badge ${info.kind}`;
  badge.textContent = info.kind;
  const title = document.createElement('span');
  title.className = 'inspTitle';
  title.textContent = info.title;
  const close = document.createElement('button');
  close.className = 'inspClose';
  close.textContent = '×';
  close.addEventListener('click', () => select(null));
  head.append(badge, title, close);
  frag.appendChild(head);

  const table = document.createElement('table');
  for (const [k, v] of info.rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = k;
    const td = document.createElement('td');
    td.textContent = v;
    tr.append(th, td);
    table.appendChild(tr);
  }
  frag.appendChild(table);

  for (const [heading, links] of [[info.linksTitle, info.links], [info.links2Title, info.links2]]) {
    if (!links || links.length === 0) continue;
    const h = document.createElement('div');
    h.className = 'linkHead';
    h.textContent = heading;
    frag.appendChild(h);
    const box = document.createElement('div');
    box.className = 'links';
    for (const link of links) {
      const b = document.createElement('button');
      b.className = `link ${link.kind}`;
      b.textContent = link.text;
      b.addEventListener('click', () => select({ kind: link.kind, id: link.id }, true));
      box.appendChild(b);
    }
    frag.appendChild(box);
  }
  inspectorEl.replaceChildren(frag);
  inspectorEl.classList.add('active');
}
// Values change as the run progresses (an agent's location, a node's value).
setInterval(() => {
  if (selection) renderInspector();
}, 400);

// --------------------------------------------------- hover / click picking

const canvas = vizScene.renderer.domElement;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let lastHoverPick = 0;
let down = null;

function pickAt(clientX, clientY) {
  if (activeMode !== 'graph' || !activeRenderer) return null;
  const rect = canvas.getBoundingClientRect();
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, vizScene.camera);
  return activeRenderer.pick(raycaster);
}

canvas.addEventListener('pointermove', (e) => {
  if (activeMode !== 'graph' || !activeRenderer) return;
  if (e.buttons !== 0) {
    tipEl.style.display = 'none'; // dragging/orbiting
    return;
  }
  const now = performance.now();
  if (now - lastHoverPick < 60) return; // ray-testing 10k instances: cap the rate
  lastHoverPick = now;
  const hit = pickAt(e.clientX, e.clientY);
  activeRenderer.setHover(hit);
  const info = hit ? activeRenderer.describe(hit) : null;
  if (!info) {
    tipEl.style.display = 'none';
    canvas.style.cursor = '';
    return;
  }
  const extra = info.rows.filter(([k]) => k === 'group' || k === 'connections' || k === 'at' || k === 'value').map(([k, v]) => `${k}: ${v}`);
  tipEl.textContent = [`${info.kind} ${info.title}`, ...extra].join('\n');
  tipEl.style.left = `${e.clientX + 14}px`;
  tipEl.style.top = `${e.clientY + 14}px`;
  tipEl.style.display = 'block';
  canvas.style.cursor = 'pointer';
});
canvas.addEventListener('pointerleave', () => {
  tipEl.style.display = 'none';
  if (activeRenderer && activeRenderer.setHover) activeRenderer.setHover(null);
});
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down || activeMode !== 'graph') return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 5) return; // an orbit/pan drag, not a click
  select(pickAt(e.clientX, e.clientY), false);
});

refreshRunList();
setInterval(refreshRunList, 5000);
updateLiveControls();
refreshLegendVisibility();
