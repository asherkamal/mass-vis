// The producer-side adapters. Python and Java are tested when their toolchains
// are present (skipped otherwise). The C++ and CUDA adapters need the real
// mass_cpp_core / mass_cuda_core built inside WSL, so those build-and-run tests
// are opt-in:  MASS_VIZ_TEST_WSL=1 npm test
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, getText, parseNdjson, startServer } from './helpers.js';

const which = (cmd) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
};

describe('FLAME GPU2 adapter (Python)', () => {
  const python = which('python') || which('python3');
  test('NaN/Infinity -> null, row-major packing, agent diffing, step -1 after the initial state', { skip: !python && 'python not found' }, () => {
    const r = spawnSync(python, ['-m', 'unittest', 'discover', '-s', path.join(ROOT, 'tests', 'adapters'), '-p', 'test_flamegpu2_adapter.py', '-v'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

// ---------------------------------------------------------------- Java ----

function findJdkBin() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin'));
  for (const base of ['C:/Program Files/Microsoft', 'C:/Program Files/Java', 'C:/Program Files/Eclipse Adoptium']) {
    if (fs.existsSync(base)) for (const d of fs.readdirSync(base)) if (/jdk/i.test(d)) candidates.push(path.join(base, d, 'bin'));
  }
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const bin of candidates) if (fs.existsSync(path.join(bin, 'javac' + exe))) return bin;
  const onPath = which('javac');
  return onPath ? path.dirname(onPath) : null;
}

function findJars(dir, test) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (test(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe('Java adapter', () => {
  const bin = findJdkBin();
  const massClasses = path.resolve(ROOT, '..', 'mass_java_core', 'target', 'classes');
  const gson = findJars(path.join(os.homedir(), '.m2', 'repository', 'com', 'google', 'code', 'gson'), (p) => /gson-[\d.]+\.jar$/.test(p))[0];
  const skip = !bin ? 'no JDK found' : !fs.existsSync(massClasses) ? 'mass_java_core/target/classes not built' : !gson ? 'gson jar not in ~/.m2' : false;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const sep = path.delimiter;

  const compile = () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'massviz-java-'));
    const sources = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.java') && sources.push(path.join(d, e.name))));
    walk(path.join(ROOT, 'java', 'src', 'main', 'java'));
    sources.push(path.join(ROOT, 'tests', 'adapters', 'java', 'VizAdapterTest.java'));
    const cp = [massClasses, gson].join(sep);
    execFileSync(path.join(bin, 'javac' + exe), ['-proc:none', '-d', out, '-cp', cp, ...sources], { encoding: 'utf8' });
    return { out, cp: [out, cp].join(sep) };
  };

  test('the adapter compiles against the real MASS core; JSON building maps NaN to null and carries group/attrs/names', { skip }, () => {
    const { out, cp } = compile();
    try {
      const r = spawnSync(path.join(bin, 'java' + exe), ['-cp', cp, 'edu.uw.bothell.css.dsl.MASS.viz.VizAdapterTest'], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /ok: vertex: attrs, with NaN -> null/);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  test('a JVM configured only by -Dmassviz.url/-Dmassviz.runId connects and delivers events (the worker-JVM fallback)', { skip }, async () => {
    const server = await startServer();
    const { out, cp } = compile();
    try {
      const r = spawnSync(
        path.join(bin, 'java' + exe),
        [`-Dmassviz.url=ws://localhost:${server.port}`, '-Dmassviz.runId=javaworker', '-cp', cp, 'edu.uw.bothell.css.dsl.MASS.viz.VizAdapterTest'],
        { encoding: 'utf8' }
      );
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const events = parseNdjson((await getText(server, '/recordings/javaworker.ndjson')).text);
      assert.deepEqual(events.map((e) => e.type), ['agent_spawn', 'step']);
      assert.deepEqual(events[0].at, [3, 4]);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
      await server.cleanup();
    }
  });
});

// ------------------------------------------- C++ / CUDA (real libs, WSL) ----

function wsl(script) {
  // wsl.exe reads its own argv; a script file avoids every quoting problem
  const file = path.join(os.tmpdir(), `massviz-wsl-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(file, script.replace(/\r/g, ''));
  const wslPath = '/mnt/' + file[0].toLowerCase() + file.slice(2).replace(/\\/g, '/');
  try {
    return spawnSync('wsl', ['-d', 'Ubuntu-24.04', '--', 'bash', wslPath], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, timeout: 900000 });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// Every recorded agent move must be to a cell at most one step away, except the
// row-wrap moves mass_cuda_core itself makes (west of x=0 is index-1, i.e. the
// end of the previous row) - see cuda/README.md.
function agentMoveProblems(events, width, height, allowRowWrap) {
  const pos = new Map();
  const bad = [];
  for (const e of events) {
    if (e.type === 'agent_spawn') pos.set(e.id, e.at);
    if (e.type !== 'agent_move') continue;
    const [px, py] = pos.get(e.id);
    const [x, y] = e.to;
    const inside = x >= 0 && y >= 0 && x < width && y < height;
    const adjacent = Math.abs(px - x) + Math.abs(py - y) <= 1;
    const wrap = allowRowWrap && Math.abs(x - px) === width - 1 && Math.abs(y - py) === 1;
    if (!inside || !(adjacent || wrap)) bad.push(`${e.id}: [${px},${py}] -> [${x},${y}]`);
    pos.set(e.id, e.to);
  }
  return bad;
}

const wslEnabled = process.env.MASS_VIZ_TEST_WSL === '1';
describe('real-library demos (opt-in: MASS_VIZ_TEST_WSL=1) - C++ and CUDA built in WSL, FLAME GPU2 on Windows Python', () => {
  const winToWsl = (p) => '/mnt/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
  const demo = (name) => winToWsl(path.join(ROOT, 'examples', name));

  test('cpp-grid-demo builds, runs, and records legal moves reported after manageAll', { skip: !wslEnabled && 'set MASS_VIZ_TEST_WSL=1' }, () => {
    const r = wsl(`set -e
cd ${demo('cpp-grid-demo')}
export MASS_DIR=$HOME/mass-build/mass_cpp_core/ubuntu
bash ./compile.sh
bash ./run.sh > /dev/null
`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const events = parseNdjson(fs.readFileSync(path.join(ROOT, 'examples', 'cpp-grid-demo', 'cpp-grid-demo.ndjson'), 'utf8'));
    assert.equal(events.find((e) => e.type === 'step').step, -1);
    assert.equal(events.filter((e) => e.type === 'step').length, 41);
    assert.deepEqual(agentMoveProblems(events, 12, 9, false), []);
  });

  test('cuda-grid-demo builds (adapter with plain g++), runs on the GPU, and agents land on the right cells', { skip: !wslEnabled && 'set MASS_VIZ_TEST_WSL=1' }, () => {
    const r = wsl(`set -e
export PATH=$PATH:/usr/local/cuda/bin
cd ${demo('cuda-grid-demo')}
export MASS_CUDA_DIR=$HOME/mass-build/mass_cuda_core
export BOOST_DIR=$MASS_CUDA_DIR/lib/boost-1.84.0
bash ./compile.sh > /dev/null 2>&1
bash ./run.sh > /dev/null 2>&1
`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const events = parseNdjson(fs.readFileSync(path.join(ROOT, 'examples', 'cuda-grid-demo', 'cuda-grid-demo.ndjson'), 'utf8'));
    assert.equal(events.find((e) => e.type === 'step').step, -1);
    assert.equal(events.filter((e) => e.type === 'step').length, 41);
    assert.deepEqual(agentMoveProblems(events, 16, 10, true), []);
  });

  test('the FLAME GPU2 demo runs on the GPU and records a valid initial state', { skip: !wslEnabled && 'set MASS_VIZ_TEST_WSL=1' }, () => {
    const python = which('python');
    if (!python) return;
    const r = spawnSync(python, [path.join(ROOT, 'examples', 'flamegpu2-grid-demo', 'flamegpu2_grid_demo.py')], { encoding: 'utf8', cwd: path.join(ROOT, 'examples', 'flamegpu2-grid-demo'), timeout: 280000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const events = parseNdjson(fs.readFileSync(path.join(ROOT, 'examples', 'flamegpu2-grid-demo', 'flamegpu2-grid-demo.ndjson'), 'utf8'));
    assert.equal(events.find((e) => e.type === 'step').step, -1);
    assert.deepEqual(agentMoveProblems(events, 16, 10, false), []);
  });
});
