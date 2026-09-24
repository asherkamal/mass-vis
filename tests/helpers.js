// Shared helpers for the test suite: starting a real server on a free port with
// a throw-away recordings directory, posting events, and watching a run over
// WebSocket the way the viewer does.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocket } = require(path.join(ROOT, 'server/node_modules/ws'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(predicate, timeoutMs = 8000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Starts server/server.js on a free port. `dir` reuses an existing recordings
// directory (to test a restart); otherwise a fresh temp directory is made.
export async function startServer({ dir, env = {} } = {}) {
  const port = await freePort();
  const recordingsDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'massviz-test-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(port), MASS_VIZ_RECORDINGS_DIR: recordingsDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  let exited = false;
  child.on('exit', () => (exited = true));
  await waitFor(() => log.includes('listening') || exited, 10000, 'server start');
  if (exited) throw new Error('server exited on start:\n' + log);

  const server = {
    port,
    dir: recordingsDir,
    url: `http://localhost:${port}`,
    log: () => log,
    async stop() {
      if (exited) return;
      child.kill();
      await waitFor(() => exited, 5000, 'server exit');
    },
    async cleanup() {
      await server.stop();
      fs.rmSync(recordingsDir, { recursive: true, force: true });
    },
  };
  return server;
}

export async function post(server, body) {
  const res = await fetch(`${server.url}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

export async function getText(server, urlPath) {
  const res = await fetch(server.url + urlPath);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

export const parseNdjson = (text) =>
  text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// Connects like the viewer does: opens a WebSocket, sends {type:'watch'}, and
// collects every message.
export async function watch(server, runId) {
  const ws = new WebSocket(`ws://localhost:${server.port}`);
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'watch', runId }));
  await waitFor(() => messages.some((m) => m.type === 'snapshot'), 5000, 'snapshot');
  return {
    messages,
    snapshot: () => messages.find((m) => m.type === 'snapshot'),
    close: () => ws.close(),
  };
}

// Builds `n` step batches of a small dense grid run: events for one run.
export function gridRunEvents(runId, { width = 4, height = 3, steps = 5, withInitialMarker = false } = {}) {
  const ev = [{ v: 1, runId, type: 'init', mode: 'grid', dims: [width, height], runName: 'T' }];
  const grid = (s) => Array.from({ length: width * height }, (_, i) => s * 100 + i);
  ev.push({ v: 1, runId, type: 'agent_spawn', id: 'a', at: [0, 0] });
  if (withInitialMarker) {
    ev.push({ v: 1, runId, type: 'place_grid', values: grid(-1 + 0) });
    ev.push({ v: 1, runId, type: 'step', step: -1 });
  }
  for (let s = 0; s < steps; s++) {
    ev.push({ v: 1, runId, type: 'place_grid', values: grid(s) });
    ev.push({ v: 1, runId, type: 'agent_move', id: 'a', to: [s % width, 0] });
    ev.push({ v: 1, runId, type: 'step', step: s });
  }
  return ev;
}
