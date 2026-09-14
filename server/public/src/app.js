import { MassVizScene } from './scene.js';
import { GridRenderer } from './gridRenderer.js';
import { GraphRenderer } from './graphRenderer.js';
import { RunConnection } from './connection.js';
import { PlaybackControls } from './playback.js';

const viewport = document.getElementById('viewport');
const runSelect = document.getElementById('runSelect');
const sourceMode = document.getElementById('sourceMode');
const connectBtn = document.getElementById('connectBtn');
const statusEl = document.getElementById('status');
const legendMin = document.getElementById('legendMin');
const legendMax = document.getElementById('legendMax');

const vizScene = new MassVizScene(viewport);
let activeRenderer = null; // GridRenderer | GraphRenderer
let activeMode = null; // "grid" | "graph"

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

function updateLegend() {
  if (!activeRenderer) return;
  legendMin.textContent = activeRenderer.colorScale.min.toFixed(2);
  legendMax.textContent = activeRenderer.colorScale.max.toFixed(2);
}

function teardownRenderer() {
  if (activeRenderer) {
    activeRenderer.dispose();
    activeRenderer = null;
    activeMode = null;
  }
}

function setupRenderer(mode, dims) {
  teardownRenderer();
  activeMode = mode;
  activeRenderer = mode === 'grid' ? new GridRenderer(vizScene, dims || [16, 16]) : new GraphRenderer(vizScene);
}

function applyEvent(event, opts) {
  const instant = !!(opts && opts.instant);
  if (event.type === 'init') {
    setupRenderer(event.mode, event.dims);
    setStatus(`${event.runName || event.runId || 'run'} — ${event.mode}${event.source ? ' · ' + event.source : ''}`, 'ok');
    return;
  }
  if (!activeRenderer) return; // events before init are ignored, matches server's permissive relay

  switch (event.type) {
    case 'place':
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
      activeRenderer.spawnAgent(event.id, event.at, event.color, event.shape);
      break;
    case 'agent_move':
      activeRenderer.moveAgent(event.id, event.to, instant);
      break;
    case 'agent_remove':
      activeRenderer.removeAgent(event.id);
      break;
    default:
      break;
  }
  updateLegend();
}

function applySnapshot(state) {
  teardownRenderer();
  if (!state || !state.mode) {
    setStatus('watching — waiting for producer to send init…', 'ok');
    return;
  }
  setupRenderer(state.mode, state.dims);
  if (state.placeRange) activeRenderer.setPlaceRange(state.placeRange.min, state.placeRange.max);
  if (state.mode === 'grid') {
    for (const p of state.places) activeRenderer.setPlace(p.index, p.value);
  } else {
    for (const v of state.vertices) activeRenderer.upsertVertex(v);
    for (const pv of state.placeValues) activeRenderer.setPlaceValue(pv.id, pv.value);
  }
  for (const a of state.agents) activeRenderer.spawnAgent(a.id, a.at, a.color, a.shape);
  updateLegend();
  setStatus(`${state.runName || state.runId} — ${state.mode}${state.source ? ' · ' + state.source : ''}`, 'ok');
}

const connection = new RunConnection({
  onReset: applySnapshot,
  onEvent: applyEvent,
});

const playback = new PlaybackControls(connection, {
  panelEl: document.getElementById('playback'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  slider: document.getElementById('stepSlider'),
  stepLabel: document.getElementById('stepLabel'),
  speedSelect: document.getElementById('speedSelect'),
});

async function refreshRunList() {
  try {
    const runs = await connection.listRuns();
    const prev = runSelect.value;
    runSelect.innerHTML = '';
    for (const r of runs) {
      const opt = document.createElement('option');
      opt.value = r.runId;
      opt.textContent = `${r.runId}${r.active ? ' (active)' : ''}`;
      runSelect.appendChild(opt);
    }
    if (runs.some((r) => r.runId === prev)) runSelect.value = prev;
  } catch (e) {
    setStatus('could not reach server', 'err');
  }
}

connectBtn.addEventListener('click', async () => {
  const runId = runSelect.value || 'default';
  const mode = sourceMode.value;
  teardownRenderer();
  if (mode === 'live') {
    playback.hide();
    setStatus(`connecting to ${runId}…`);
    connection.connectLive(runId);
  } else {
    setStatus(`loading replay ${runId}…`);
    try {
      await connection.loadReplay(runId);
      playback.showForReplay();
      setStatus(`loaded replay ${runId} (${connection.stepCount} steps)`, 'ok');
    } catch (e) {
      setStatus(`no recording found for ${runId}`, 'err');
    }
  }
});

refreshRunList();
setInterval(refreshRunList, 5000);
