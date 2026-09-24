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
 *   serves a recorded run's raw event log for client-side replay/scrub, or
 *   with ?tail=N just its last N steps behind a state snapshot (windowed
 *   replay - see KEYFRAME_EVERY).
 * - A new `init` for an existing runId starts a fresh recording file; the old
 *   one is kept under a timestamped name.
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
// An ES module shared with the browser (needs Node >= 22.12, see package.json).
const { RunState } = require('./public/src/runState.js');
const { parseJsonTolerant } = require('./public/src/json.js');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const RECORDINGS_DIR = process.env.MASS_VIZ_RECORDINGS_DIR || path.join(__dirname, 'recordings');
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

/** @type {Map<string, ReturnType<typeof newRun>>} */
const runs = new Map();
/** @type {Map<string, Set<import('ws').WebSocket>>} runId -> watching sockets */
const watchers = new Map();
/** @type {Map<string, {fd: number, file: string, buf: string[], events: number, bytes: number, timer: NodeJS.Timeout|null}>} */
const recorders = new Map();

// Runs with no events and no watchers for this long are dropped from memory
// (their recording stays on disk and stays listable/replayable).
const IDLE_EVICT_MS = Number(process.env.MASS_VIZ_IDLE_MS || 10 * 60 * 1000);

// Windowed replay: the server snapshots each run's full state every
// KEYFRAME_EVERY step markers, remembering the recording's byte offset at that
// point. GET /recordings/<id>.ndjson?tail=N can then start from the nearest
// snapshot instead of sending the whole file - a busy run (e.g. 10k vertices,
// 2k agents) records ~250 KB per step, so a long run's file is far too big to
// ship to the browser just to pause and look at the last few steps.
// At most MAX_KEYFRAMES are kept; past that, every other older one is dropped.
const KEYFRAME_EVERY = 50;
const MAX_KEYFRAMES = 64;

// Parses incoming JSON, repairing bare NaN/Infinity tokens (see json.js) with a warning.
const parseJson = (text) =>
  parseJsonTolerant(text, () => console.warn('[mass-viz] replaced non-finite number literal(s) with null in incoming JSON'));

// One run on the server: its reduced state - the same RunState class the
// viewer uses for replay keyframes (public/src/runState.js), so the two can't
// drift apart - plus the bookkeeping for windowed replay.
function newRun(runId) {
  return {
    runId,
    state: new RunState(),
    initSeen: false, // keyframes are only valid for a run whose init (and file start) this server saw
    stepMarkers: 0, // step events recorded since init == frames in the recording
    keyframes: [], // {frame, offset, state}, ascending
    updatedAt: Date.now(),
  };
}

function getOrCreateRun(runId) {
  let run = runs.get(runId);
  if (!run) {
    run = newRun(runId);
    runs.set(runId, run);
  }
  return run;
}

function applyEvent(run, event) {
  run.updatedAt = Date.now();
  run.state.apply(event);
  if (event.type === 'init') {
    run.initSeen = true;
    run.stepMarkers = 0;
    run.keyframes = [];
  }
}

function noteStepMarker(run, rec) {
  if (!run.initSeen) return;
  const frame = run.stepMarkers++;
  if (frame % KEYFRAME_EVERY !== 0) return;
  // clone(): later events mutate the live state in place (agent positions, grid values)
  run.keyframes.push({ frame, offset: rec.bytes, state: run.state.clone().toSnapshot() });
  if (run.keyframes.length > MAX_KEYFRAMES) {
    const last = run.keyframes.length - 1;
    run.keyframes = run.keyframes.filter((k, i) => i % 2 === 0 || i === last);
  }
}

const STEP_LINE = /"type"\s*:\s*"step"/;
// Recordings smaller than this are always sent whole; scanning them buys nothing.
const WINDOW_SCAN_MIN_BYTES = Number(process.env.MASS_VIZ_WINDOW_MIN_BYTES || 20 * 1024 * 1024);

// The same windowing as the in-memory keyframes, for a recording the server
// isn't holding state for (a finished run, an evicted one, or one from before
// a restart): stream the file once to count step markers, then again to
// rebuild state up to the marker `tail` steps from the end. Returns null when
// the recording has no more than `tail` steps (send it whole).
async function windowFromFile(file, tail) {
  const readline = require('readline');
  const lines = () => readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  let total = 0;
  for await (const line of lines()) if (STEP_LINE.test(line)) total++;
  if (total <= tail) return null;

  const wanted = total - tail; // snapshot = state right after this (0-based) step marker
  const state = new RunState();
  let offset = 0;
  let frame = 0;
  for await (const line of lines()) {
    offset += Buffer.byteLength(line) + 1; // + the '\n' readline strips
    if (!line.trim()) continue;
    let event;
    try {
      event = parseJson(line);
    } catch (e) {
      continue;
    }
    state.apply(event);
    if (event.type === 'step' && frame++ === wanted) {
      return { baseFrame: wanted, totalFrames: total, offset, state: state.toSnapshot() };
    }
  }
  return null;
}

function recordingPath(runId) {
  return path.join(RECORDINGS_DIR, `${sanitizeRunId(runId)}.ndjson`);
}

function getRecorder(runId) {
  let rec = recorders.get(runId);
  if (!rec) {
    const file = recordingPath(runId);
    const fd = fs.openSync(file, 'a');
    rec = { fd, file, buf: [], events: 0, timer: null, bytes: fs.fstatSync(fd).size };
    recorders.set(runId, rec);
  }
  return rec;
}

// Writes are buffered and flushed synchronously (a timer, plus explicitly
// before a recording is served, rotated or the process exits) so that
// GET /recordings/<id>.ndjson always sees every event received so far -
// pause/replay of a still-running run depends on that.
function flushRecorder(rec) {
  if (rec.timer) {
    clearTimeout(rec.timer);
    rec.timer = null;
  }
  if (rec.buf.length === 0) return;
  const data = rec.buf.join('');
  rec.buf = [];
  fs.writeSync(rec.fd, data);
}

function flushRecording(runId) {
  const rec = recorders.get(runId);
  if (rec) flushRecorder(rec);
}

function closeRecorder(runId) {
  const rec = recorders.get(runId);
  if (!rec) return;
  flushRecorder(rec);
  fs.closeSync(rec.fd);
  recorders.delete(runId);
}

// A new `init` for a runId that already has a recording starts a fresh file;
// the old one is kept as <runId>.<timestamp>.ndjson instead of having the
// new run appended to it (which would put two runs on one replay timeline).
// A run that only ever received its init (e.g. a hand-sent curl init that is
// then re-sent by a generator) is just truncated rather than archived.
function startFreshRecording(runId) {
  const file = recordingPath(runId);
  const rec = recorders.get(runId);
  const trivial = rec && rec.events <= 1;
  closeRecorder(runId);
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) return;
    if (trivial) {
      fs.truncateSync(file, 0);
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(file, path.join(RECORDINGS_DIR, `${sanitizeRunId(runId)}.${stamp}.ndjson`));
    }
  } catch (e) {
    console.error('[mass-viz] could not rotate recording:', e.message);
  }
}

function recordEvent(runId, event) {
  const rec = getRecorder(runId);
  const line = JSON.stringify(event) + '\n';
  rec.buf.push(line);
  rec.events++;
  rec.bytes += Buffer.byteLength(line);
  if (!rec.timer) rec.timer = setTimeout(() => flushRecorder(rec), 50);
  return rec;
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
    if (event.type === 'init') startFreshRecording(event.runId);
    const run = getOrCreateRun(event.runId);
    applyEvent(run, event);
    const rec = recordEvent(event.runId, event);
    if (event.type === 'step') noteStepMarker(run, rec);
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
  ws.send(JSON.stringify({ type: 'snapshot', runId, state: run ? run.state.toSnapshot() : null }));
}

function listRuns() {
  const active = Array.from(runs.values()).map((r) => ({
    runId: r.runId,
    runName: r.state.runName,
    mode: r.state.mode,
    source: r.state.source,
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

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  sendFile(res, filePath, MIME[path.extname(filePath)] || 'application/octet-stream');
}

// A windowed recording response: one `snapshot` line (the run's state after
// step marker `baseFrame`) followed by the file's bytes from `from` up to
// (not including) `to`, or to the end when `to` is omitted.
function sendWindow(res, file, { baseFrame, totalFrames, state }, from, to) {
  res.writeHead(200, { 'Content-Type': MIME['.ndjson'] });
  res.write(JSON.stringify({ type: 'snapshot', baseFrame, totalFrames, state }) + '\n');
  if (to !== undefined && to <= from) {
    res.end();
    return;
  }
  const options = to === undefined ? { start: from } : { start: from, end: to - 1 };
  const stream = fs.createReadStream(file, options);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// GET /recordings/<runId>.ndjson[?tail=N]. With tail=N, only about the last N
// steps are sent, as a snapshot line plus the events after it (see
// KEYFRAME_EVERY). The whole file is sent instead when the run is no longer
// than N steps, or no snapshot is available.
function serveRecording(res, url) {
  let rawId = url.pathname.slice('/recordings/'.length).replace(/\.ndjson$/, '');
  try {
    rawId = decodeURIComponent(rawId);
  } catch (e) {
    // leave as-is; sanitizeRunId below neutralizes it
  }
  const file = recordingPath(rawId);
  flushRecording(rawId); // include events still sitting in the write buffer

  const tail = Number(url.searchParams.get('tail')) || 0;
  const run = runs.get(rawId);
  const rec = recorders.get(rawId);
  const sendWhole = () => sendFile(res, file, MIME['.ndjson']);

  // Active run: use the keyframe nearest before the requested window.
  if (tail > 0 && run && rec && run.initSeen && run.stepMarkers > tail) {
    const wanted = run.stepMarkers - tail;
    let kf = null;
    for (const k of run.keyframes) if (k.frame <= wanted) kf = k;
    if (kf) {
      // rec.bytes is read once, so the frame count sent matches the bytes sent
      sendWindow(res, file, { baseFrame: kf.frame, totalFrames: run.stepMarkers, state: kf.state }, kf.offset, rec.bytes);
      return;
    }
  }

  // Not held in memory here (finished, evicted, or from before a restart) but
  // large: rebuild the window from the file.
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (e) {
    // missing file: sendWhole reports the 404
  }
  if (tail > 0 && !(run && rec) && size > WINDOW_SCAN_MIN_BYTES) {
    windowFromFile(file, tail).then(
      (w) => (w ? sendWindow(res, file, w, w.offset) : sendWhole()),
      (e) => {
        console.error('[mass-viz] windowing failed, sending whole file:', e.message);
        sendWhole();
      }
    );
    return;
  }
  sendWhole();
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
    let watching = 0;
    for (const sockets of watchers.values()) watching += sockets.size;
    sendJson(res, 200, { status: 'ok', runs: runs.size, watchers: watching });
    return;
  }

  if (url.pathname === '/event' && req.method === 'POST') {
    readBody(req, (body) => {
      let payload;
      try {
        payload = parseJson(body);
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
    sendFile(res, VENDOR_FILES[url.pathname], MIME['.js']);
    return;
  }

  if (url.pathname.startsWith('/recordings/')) {
    serveRecording(res, url);
    return;
  }

  serveStatic(res, url.pathname);
});

// ----------------------------------------------------------- WebSocket ----

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let event;
    try {
      event = parseJson(raw.toString());
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

function evictIdleRuns() {
  const now = Date.now();
  for (const [runId, run] of runs) {
    const watching = watchers.get(runId);
    if (watching && watching.size > 0) continue;
    if (now - run.updatedAt < IDLE_EVICT_MS) continue;
    closeRecorder(runId);
    runs.delete(runId);
    watchers.delete(runId);
  }
}
setInterval(evictIdleRuns, 30 * 1000).unref();

function shutdown() {
  for (const runId of Array.from(recorders.keys())) closeRecorder(runId);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`mass-viz server listening on http://localhost:${PORT}`);
});
