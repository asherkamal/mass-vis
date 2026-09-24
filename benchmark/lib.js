'use strict';
// Helpers shared by the benchmark scripts.
const http = require('http');

// `--key=value` and bare `--flag` arguments become `flags` (a bare flag is
// `true`); everything else is `positional`.
function parseArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      flags[key] = value === undefined ? true : value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// POSTs `body` as JSON to http://<hostname>:<port><path>. Resolves with
// {status, text} once the response has been fully read.
function postJson({ hostname = 'localhost', port = 8080, path = '/event', body }) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname,
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { parseArgs, postJson };
