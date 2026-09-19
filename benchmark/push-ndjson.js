'use strict';
// Replays a recorded .ndjson file into a *live* run on a running mass-viz
// server, by POSTing its events to /event (which accepts a JSON array and
// applies it in order - see ../PROTOCOL.md and server.js's handleIncomingEvent).
//
// Why this exists: the C++, CUDA and FLAME GPU2 adapters are file-only
// writers with no WebSocket client, so on their own they can only ever be
// checked in Replay mode. Pushing their output through here paces it like a
// real simulation, which is the only way to exercise live rendering and -
// more importantly - the late-join snapshot path (open a second browser tab
// mid-push; it must immediately show full state, not an empty scene).
//
// Events are batched per simulation tick: everything up to and including
// each `step` event goes in one POST, then we wait --interval before the
// next. Events after the final `step` (or a file with no `step` at all) are
// flushed as a last batch.
//
// Usage:
//   node push-ndjson.js <file.ndjson> [--runId=<id>] [--interval=200]
//                       [--server=http://localhost:8080] [--no-rewrite-id]
//
// --runId overrides the runId on every event, so the same recording can be
// pushed repeatedly under fresh ids without colliding with an existing run's
// recorded state on the server. Defaults to "<file basename>-live".
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v === undefined ? true : v];
    })
);

const file = positional[0];
if (!file) {
  console.error('Usage: node push-ndjson.js <file.ndjson> [--runId=<id>] [--interval=200] [--server=http://localhost:8080]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const INTERVAL = Number(flags.interval || 200);
const serverUrl = new URL(flags.server || 'http://localhost:8080');
const rewriteId = flags['no-rewrite-id'] !== true;
const runId = flags.runId || `${path.basename(file, '.ndjson')}-live`;

function post(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: serverUrl.hostname,
        port: serverUrl.port || 80,
        path: '/event',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${out}`));
          resolve(out);
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  let batch = [];
  let ticks = 0;
  let sent = 0;
  let skipped = 0;
  const start = Date.now();

  const flush = async () => {
    if (batch.length === 0) return;
    const payload = batch;
    batch = [];
    await post(payload);
    sent += payload.length;
  };

  console.log(`[push] ${file} -> ${serverUrl.origin}/event as runId="${runId}" (${INTERVAL}ms/tick)`);

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (e) {
      // A malformed line is the adapter's bug, not a reason to abort the
      // whole push - report it and keep going so the rest still renders.
      skipped++;
      console.error(`[push] skipping unparseable line: ${e.message}`);
      continue;
    }
    if (rewriteId) event.runId = runId;
    batch.push(event);

    if (event.type === 'step') {
      await flush();
      ticks++;
      if (ticks % 25 === 0) console.log(`[push] ${ticks} ticks, ${sent} events`);
      await sleep(INTERVAL);
    }
  }

  await flush();

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[push] done: ${sent} events across ${ticks} ticks in ${secs}s${skipped ? `, ${skipped} unparseable lines skipped` : ''}`);
  console.log(`[push] view it at ${serverUrl.origin} - mode Live (or Replay), run "${runId}"`);
}

main().catch((e) => {
  console.error(`[push] failed: ${e.message}`);
  process.exit(1);
});
