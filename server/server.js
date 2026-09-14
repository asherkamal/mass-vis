'use strict';

/**
 * mass-viz relay/recording server.
 *
 * - Producers (MASS Java/C++/CUDA adapters, or any script) connect over
 *   WebSocket and send protocol events (see ../PROTOCOL.md). Each event is
 *   applied to an in-memory RunState for its runId, broadcast to every
 *   viewer currently watching that runId, and appended to
 *   recordings/<runId>.ndjson.
 * - Viewers (the browser page) connect over WebSocket and send a control
 *   message {type:"watch", runId} to subscribe; they immediately receive a
 *   {type:"snapshot", state} reconstructing everything seen so far, then
 *   live events as they arrive.
 * - GET /recordings lists past/active runs; GET /recordings/<runId>.ndjson
 *   serves a recorded run's raw event log for client-side replay/scrub.
 * - POST /event accepts a single protocol event (or a JSON array of them)
 *   as its body, for quick manual/scripted testing with curl instead of a
 *   WebSocket client. Goes through the same handleIncomingEvent() path as
 *   the WebSocket producer route, so it's applied/recorded/broadcast
 *   identically.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const VENDOR_FILES = {
  '/vendor/three.module.js': path.join(__dirname, 'node_modules/three/build/three.module.js'),
  '/vendor/OrbitControls.js': path.join(
    __dirname,
    'node_modules/three/examples/jsm/controls/OrbitControls.js'
  ),
};

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
};

/** @type {Map<string, RunState>} */
const runs = new Map();
/** @type {Map<string, Set<import('ws').WebSocket>>} runId -> watching sockets */
const watchers = new Map();
/** @type {Map<string, fs.WriteStream>} */
const recordingStreams = new Map();

function placeKey(index) {
  return index.join(',');
}

function newRunState(runId) {
  return {
    runId,
    mode: null,
    dims: null,
    source: null,
    runName: null,
    placeRange: null,
    places: new Map(), // key -> {index, value}
    vertices: new Map(), // id -> vertex
    placeValues: new Map(), // id -> value
    agents: new Map(), // id -> {id, at, to, color, shape}
    lastStep: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function getOrCreateRun(runId) {
  let run = runs.get(runId);
  if (!run) {
    run = newRunState(runId);
    runs.set(runId, run);
  }
  return run;
}

function applyEvent(run, event) {
  run.updatedAt = Date.now();
  switch (event.type) {
    case 'init':
      run.mode = event.mode;
      run.dims = event.dims || null;
      run.source = event.source || null;
      run.runName = event.runName || run.runId;
      run.places.clear();
      run.vertices.clear();
      run.placeValues.clear();
      run.agents.clear();
      run.placeRange = null;
      run.lastStep = null;
      break;
    case 'place':
      if (Array.isArray(event.places)) {
        for (const p of event.places) {
          if (p && Array.isArray(p.index)) run.places.set(placeKey(p.index), p);
        }
      } else if (Array.isArray(event.index)) {
        run.places.set(placeKey(event.index), { index: event.index, value: event.value });
      }
      break;
    case 'place_grid': {
      const [w, h] = run.dims || [];
      if (Array.isArray(event.values) && w && h) {
        for (let i = 0; i < event.values.length; i++) {
          const x = i % w;
          const y = Math.floor(i / w);
          run.places.set(placeKey([x, y]), { index: [x, y], value: event.values[i] });
        }
      }
      break;
    }
    case 'place_range':
      run.placeRange = { min: event.min, max: event.max };
      break;
    case 'vertex':
      run.vertices.set(String(event.id), event);
      break;
    case 'place_value':
      run.placeValues.set(String(event.id), event.value);
      break;
    case 'agent_spawn':
      run.agents.set(String(event.id), {
        id: event.id,
        at: event.at,
        color: event.color,
        shape: event.shape,
      });
      break;
    case 'agent_move': {
      const agent = run.agents.get(String(event.id));
      if (agent) agent.at = event.to;
      break;
    }
    case 'agent_remove':
      run.agents.delete(String(event.id));
      break;
    case 'step':
      run.lastStep = event.step;
      break;
    default:
      break; // unknown event types are relayed but not applied to state
  }
}

function serializeRunState(run) {
  return {
    runId: run.runId,
    mode: run.mode,
    dims: run.dims,
    source: run.source,
    runName: run.runName,
    placeRange: run.placeRange,
    places: Array.from(run.places.values()),
    vertices: Array.from(run.vertices.values()),
    placeValues: Array.from(run.placeValues.entries()).map(([id, value]) => ({ id, value })),
    agents: Array.from(run.agents.values()),
    lastStep: run.lastStep,
  };
}

function recordEvent(runId, event) {
  let stream = recordingStreams.get(runId);
  if (!stream) {
    const file = path.join(RECORDINGS_DIR, `${sanitizeRunId(runId)}.ndjson`);
    stream = fs.createWriteStream(file, { flags: 'a' });
    recordingStreams.set(runId, stream);
  }
  stream.write(JSON.stringify(event) + '\n');
}

function sanitizeRunId(runId) {
  return String(runId).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'run';
}

// Shared by the WebSocket producer route and POST /event: applies one
// protocol event to its run's state, records it, and broadcasts it to
// watchers. `watch`/`list_runs` control messages are handled by the caller
// before reaching here, since POST /event has no persistent connection to
// reply on.
function handleIncomingEvent(event) {
  if (!event || !event.type || !event.runId) return false; // protocol events require runId
  // A malformed event from any producer (a WIP adapter, a hand-typed curl
  // payload mangled by a terminal, ...) must never take the whole server
  // down and disconnect every other viewer - reject just this one event.
  try {
    const run = getOrCreateRun(event.runId);
    applyEvent(run, event);
    recordEvent(event.runId, event);
    broadcastToWatchers(event.runId, event);
    return true;
  } catch (e) {
    console.error('[mass-viz] rejected malformed event:', e.message, JSON.stringify(event).slice(0, 500));
    return false;
  }
}

function broadcastToWatchers(runId, payload) {
  const sockets = watchers.get(runId);
  if (!sockets) return;
  const msg = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function watchRun(ws, runId) {
  for (const set of watchers.values()) set.delete(ws);
  if (!watchers.has(runId)) watchers.set(runId, new Set());
  watchers.get(runId).add(ws);
  ws._watchingRunId = runId;

  const run = runs.get(runId);
  if (run) {
    ws.send(JSON.stringify({ type: 'snapshot', runId, state: serializeRunState(run) }));
  } else {
    ws.send(JSON.stringify({ type: 'snapshot', runId, state: null }));
  }
}

function listRuns() {
  const active = Array.from(runs.values()).map((r) => ({
    runId: r.runId,
    runName: r.runName,
    mode: r.mode,
    source: r.source,
    active: true,
    updatedAt: r.updatedAt,
  }));
  const activeIds = new Set(active.map((r) => r.runId));
  let recorded = [];
  try {
    recorded = fs
      .readdirSync(RECORDINGS_DIR)
      .filter((f) => f.endsWith('.ndjson'))
      .map((f) => f.slice(0, -'.ndjson'.length))
      .filter((id) => !activeIds.has(id))
      .map((id) => ({ runId: id, active: false }));
  } catch (e) {
    // recordings dir missing is fine, mkdir'd at startup
  }
  return active.concat(recorded);
}

// ---------------------------------------------------------------- HTTP ----

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req, callback) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => callback(Buffer.concat(chunks).toString('utf8')));
  // An EventEmitter throws (crashing the process) if an 'error' event fires
  // with no listener - a client aborting mid-upload is routine, not fatal.
  req.on('error', (e) => console.error('[mass-viz] request stream error:', e.message));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', runs: runs.size, watchers: watchers.size });
    return;
  }

  if (url.pathname === '/event' && req.method === 'POST') {
    readBody(req, (body) => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const events = Array.isArray(payload) ? payload : [payload];
      let accepted = 0;
      for (const event of events) {
        if (handleIncomingEvent(event)) accepted++;
      }
      sendJson(res, 200, { accepted, rejected: events.length - accepted });
    });
    return;
  }

  if (url.pathname === '/recordings') {
    sendJson(res, 200, { recordings: listRuns() });
    return;
  }

  if (VENDOR_FILES[url.pathname]) {
    fs.readFile(VENDOR_FILES[url.pathname], (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME['.js'] });
      res.end(data);
    });
    return;
  }

  if (url.pathname.startsWith('/recordings/')) {
    const name = sanitizeRunId(url.pathname.slice('/recordings/'.length).replace(/\.ndjson$/, ''));
    const file = path.join(RECORDINGS_DIR, `${name}.ndjson`);
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME['.ndjson'] });
      res.end(data);
    });
    return;
  }

  serveStatic(req, res, url.pathname);
});

// ----------------------------------------------------------- WebSocket ----

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch (e) {
      return; // ignore malformed frames, matching the permissive-relay pattern
    }

    if (event.type === 'watch') {
      watchRun(ws, event.runId || 'default');
      return;
    }

    if (event.type === 'list_runs') {
      ws.send(JSON.stringify({ type: 'run_list', runs: listRuns() }));
      return;
    }

    handleIncomingEvent(event);
  });

  ws.on('close', () => {
    for (const set of watchers.values()) set.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`mass-viz server listening on http://localhost:${PORT}`);
});
