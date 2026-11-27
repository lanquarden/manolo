#!/usr/bin/env node
// Mixed-version Task compatibility runner.
//
// Extracts two git refs into isolated temporary checkouts and runs the real relay and worker processes from them, so a
// rollout pairing is exercised by the code that actually ships instead of by a fixture that imitates it. It never
// touches the working tree, never pushes or deploys, and never reaches anything but loopback.
//
//   node scripts/task-compat.mjs --old e93ec28 --candidate HEAD
//
// Each side reuses this repository's node_modules only when its package-lock.json is byte-identical, which proves the
// installed dependency tree is the one both refs declare. Otherwise the runner refuses instead of guessing.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const secret = () => randomBytes(24).toString('hex');
const addr = port => `http://127.0.0.1:${port}`;
const basic = (user, password) => ({ authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` });
const mutation = { 'x-manolo-request': '1' };
const q = value => `'${String(value).replaceAll("'", "'\\''")}'`;

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const oldRef = option('old', 'e93ec28');
const candidateRef = option('candidate', 'HEAD');
const keep = argv.includes('--keep');

async function until(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function extract(ref, dir) {
  await mkdir(dir, { recursive: true });
  // git archive | tar keeps the checkout to exactly the committed ref: no untracked files and no local modifications.
  await exec('bash', ['-o', 'pipefail', '-c', `git -C ${q(repo)} archive ${q(ref)} | tar -x -C ${q(dir)}`]);
  return dir;
}

function launch(label, dir, env) {
  const child = spawn(process.execPath, [`src/${label}.mjs`], {
    cwd: dir, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const closed = once(child, 'exit');
  return {
    log: () => log,
    async port(re) {
      return until(() => {
        if (child.exitCode !== null) throw new Error(`${label} exited (${child.exitCode}):\n${log}`);
        return Number(re.exec(log)?.[1]) || null;
      }, `${label} listener`);
    },
    async end() {
      if (child.exitCode === null) child.kill('SIGKILL');
      await closed;
    },
  };
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// A transparent loopback forwarder. Every body is JSON on these routes; GET requests carry none, and fetch refuses a
// body on them.
function forwarder(target, record) {
  return async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let parsed;
    try { parsed = body.length ? JSON.parse(body.toString('utf8')) : undefined; } catch { parsed = undefined; }
    record?.({ method: req.method, path: req.url, body: parsed });
    try {
      const response = await fetch(target() + req.url, {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers)
          .filter(([name]) => ['authorization', 'content-type', 'idempotency-key'].includes(name))),
        body: body.length ? body : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(await response.text());
    } catch {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"forwarder failed"}');
    }
  };
}

const request = (url, path, auth, method = 'GET', body, extra = {}) => fetch(`${url}${path}`, {
  method, headers: { ...auth, ...(body && { 'content-type': 'application/json' }), ...extra },
  body: body && JSON.stringify(body), signal: AbortSignal.timeout(15_000),
});

const tasksOf = async (web, auth) => {
  const response = await request(web, '/api/tasks', auth);
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  return [...payload.active, ...payload.history];
};

async function createUnstructuredTask(web, auth, id, title) {
  const text = `fixture-tool:${JSON.stringify({ name: 'create_task', args: { title, task: 'fixture:bare' } })}`;
  const response = await request(web, '/api/turns', auth, 'POST', { id, text }, mutation);
  assert.equal(response.status, 200, await response.clone().text());
}

function ledger(dataDir) {
  return (id) => {
    const db = new DatabaseSync(join(dataDir, 'relay.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
    finally { db.close(); }
  };
}

// One pairing: real relay process from `relaySide`, real worker process from `workerSide`, one unstructured Task created
// through the actual web turn and executed by the actual Task scheduler.
async function pairing({ relaySide, workerSide, finishMode, expect }) {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-compat-'));
  const workerData = join(root, 'worker');
  const relayData = join(root, 'relay');
  const configPath = join(root, 'relay.json');
  const token = secret();
  const password = secret();
  const relayCalls = [];
  const workerCalls = [];
  let internal = 'http://127.0.0.1:1';
  let workerUrl = 'http://127.0.0.1:1';
  const toRelay = await listen(forwarder(() => internal, call => relayCalls.push(call)));
  const toWorker = await listen(forwarder(() => workerUrl, call => workerCalls.push(call)));
  let worker;
  let relay;
  try {
    worker = launch('worker', workerSide, {
      MANOLO_AGENT_ID: 'canary', MANOLO_AGENT_TOKEN: token, MANOLO_DATA_DIR: workerData,
      MANOLO_MODE: 'fixture', MANOLO_CODING_TOOLS: '0', MANOLO_FIXTURE_TOOLS: '1', PORT: '0',
      MANOLO_RELAY_URL: addr(toRelay.address().port),
    });
    workerUrl = addr(await worker.port(/worker listening on (\d+)/));
    await writeFile(configPath, JSON.stringify({
      agents: { canary: { url: addr(toWorker.address().port), tokenEnv: 'CANARY_TOKEN' } },
      owners: { owner: { agent: 'canary', passwordEnv: 'OWNER_PASSWORD' } }, routes: [], inbox: [],
    }));
    relay = launch('relay', relaySide, {
      CANARY_TOKEN: token, OWNER_PASSWORD: password, MANOLO_RELAY_CONFIG: configPath,
      MANOLO_DATA_DIR: relayData, MANOLO_WORK_SESSION_AGENT: 'canary', PORT: '0', MANOLO_INTERNAL_PORT: '0',
      ...(finishMode && { MANOLO_TASK_FINISH: finishMode }),
    });
    const web = addr(await relay.port(/web listening on .*:(\d+)/));
    internal = addr(await relay.port(/internal listening on .*:(\d+)/));
    const auth = basic('owner', password);
    const id = `compat-${secret().slice(0, 12)}`;
    const title = `compat ${secret().slice(0, 8)}`;
    await createUnstructuredTask(web, auth, id, title);
    const turn = await until(async () => {
      const response = await request(web, `/api/turns/${encodeURIComponent(id)}`, auth);
      if (response.status !== 200) return undefined;
      const row = await response.json();
      return row.status === 'done' && row;
    }, `${expect.label}: originating turn`);
    assert.equal(turn.text, 'Fixture tool succeeded', JSON.stringify(turn));
    const created = await until(async () => (await tasksOf(web, auth)).find(row => row.title === title),
      `${expect.label}: Task row`);
    const taskId = created.id;
    const terminal = await until(async () => {
      const row = (await tasksOf(web, auth)).find(entry => entry.id === taskId);
      return (row?.status === 'done' || row?.status === 'failed' || row?.blocked) && row;
    }, `${expect.label}: Task reaches its expected state`);
    await expect.check({ terminal, taskId, relayCalls, workerCalls, rowOf: ledger(relayData) });
    assert.doesNotMatch(worker.log(), /Task request failed|Unhandled|AssertionError/);
    assert.doesNotMatch(relay.log(), /Unhandled|AssertionError/);
  } catch (error) {
    error.message += `\nworker log:\n${worker?.log() ?? ''}\nrelay log:\n${relay?.log() ?? ''}`;
    throw error;
  } finally {
    await relay?.end().catch(() => {});
    await worker?.end().catch(() => {});
    toRelay.closeAllConnections();
    toRelay.close();
    toWorker.closeAllConnections();
    toWorker.close();
    if (keep) console.log(`kept ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}

function settleCalls(calls, taskId) {
  return calls.filter(call => call.path === `/v1/tasks/${taskId}/settle`);
}

function dispatchCalls(calls, taskId) {
  return calls.filter(call => call.method === 'POST' && /^\/v1\/tasks\/[0-9a-f]{32}\/executions(?:\/v2)?$/.test(call.path)
    && call.path.startsWith(`/v1/tasks/${taskId}/`));
}

const results = [];

async function run(name, options) {
  process.stdout.write(`\n${name}\n`);
  try {
    await pairing(options);
    results.push({ name, ok: true });
    process.stdout.write(`  PASS\n`);
  } catch (error) {
    results.push({ name, ok: false, error });
    process.stdout.write(`  FAIL: ${error.message}\n`);
  }
}

const extracted = await mkdtemp(join(tmpdir(), 'manolo-task-compat-refs-'));
try {
  const oldDir = await extract(oldRef, join(extracted, 'old'));
  const candidateDir = await extract(candidateRef, join(extracted, 'candidate'));
  // Reusing one installed tree is safe only when both refs declare exactly the tree that is installed here. The Task
  // runtime's dependencies did not move between these refs; if they ever do, the runner refuses and asks for an isolated
  // install instead of silently testing a different dependency set.
  const installedLock = await readFile(join(repo, 'package-lock.json'), 'utf8');
  for (const [label, dir] of [[`old ${oldRef}`, oldDir], [`candidate ${candidateRef}`, candidateDir]]) {
    const sideLock = await readFile(join(dir, 'package-lock.json'), 'utf8');
    if (sideLock !== installedLock) throw new Error(`${label} pins a different dependency tree; install it in an isolated copy first.`);
    await symlink(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
  }

  await run(`candidate relay + old worker ${oldRef} (MANOLO_TASK_FINISH=legacy)`, {
    relaySide: candidateDir, workerSide: oldDir, finishMode: 'legacy',
    expect: {
      label: 'new relay + old worker',
      async check({ terminal, taskId, relayCalls, workerCalls, rowOf: readLedger }) {
        assert.equal(terminal.status, 'done', JSON.stringify(terminal));
        assert.match(terminal.outcome, /fixture:bare/);
        const row = readLedger(taskId);
        assert.equal(row.finish_required, 0, 'the relay marked the unstructured Task legacy');
        assert.equal(row.status, 'done');
        assert.equal(row.execution_kind, 'start');
        const dispatches = dispatchCalls(workerCalls, taskId);
        assert.equal(dispatches.length, 1, 'one plain dispatch, never the v2 route');
        assert.ok(dispatches[0].path.endsWith('/executions'));
        assert.equal(dispatches[0].body.task.protocol, undefined, 'the old worker was never sent a v2 assignment');
        assert.equal(dispatches[0].body.admission, 2, 'the new relay still offers its admission contract');
        const settles = settleCalls(relayCalls, taskId);
        assert.equal(settles.length, 1, 'one settlement');
        assert.equal(settles[0].body.outcome, 'done');
        assert.equal(settles[0].body.run, undefined, 'the old worker reports in the runless shape');
        assert.equal(relayCalls.filter(call => call.path === `/v1/tasks/${taskId}/finish`).length, 0,
          'the old worker has no finish tool and never pretends to call it');
        process.stdout.write(`  evidence: finish_required=${row.finish_required} dispatch=${dispatches[0].path} settle.run=absent\n`);
      },
    },
  });

  await run(`old relay ${oldRef} + candidate worker (true legacy Task)`, {
    relaySide: oldDir, workerSide: candidateDir,
    expect: {
      label: 'old relay + new worker',
      async check({ terminal, taskId, relayCalls, workerCalls, rowOf: readLedger }) {
        assert.equal(terminal.status, 'done', JSON.stringify(terminal));
        assert.equal(terminal.outcome, 'Bare final without finish.');
        assert.equal(readLedger(taskId).status, 'done');
        const dispatches = dispatchCalls(workerCalls, taskId);
        assert.equal(dispatches.length, 1, 'one dispatch on the old route');
        assert.ok(dispatches[0].path.endsWith('/executions'));
        assert.equal(dispatches[0].body.task.finishRequired, undefined, 'the old relay carries no finish protocol');
        assert.equal(dispatches[0].body.task.protocol, undefined);
        assert.equal(dispatches[0].body.admission, undefined, 'the old relay never offers the admission contract');
        const settles = settleCalls(relayCalls, taskId);
        assert.equal(settles.length, 1, 'one settlement');
        assert.equal(settles[0].body.outcome, 'done');
        assert.equal(settles[0].body.run, undefined, 'the new worker keeps the old report shape it was not offered');
        assert.equal(relayCalls.filter(call => call.path === `/v1/tasks/${taskId}/finish`).length, 0,
          'a true legacy execution does not use the finish route');
        process.stdout.write(`  evidence: dispatch=${dispatches[0].path} settle.run=absent outcome=legacy bare final\n`);
      },
    },
  });

  // The prerequisite itself. A new relay without the legacy override still protects structured assignments, and an
  // unstructured Task on a pre-finish worker is held at dispatch instead of being run under a contract the worker cannot
  // honour. That is why relay-first rollout needs MANOLO_TASK_FINISH=legacy while old workers still serve new Tasks.
  await run(`candidate relay without MANOLO_TASK_FINISH + old worker ${oldRef} (refused, not run wrongly)`, {
    relaySide: candidateDir, workerSide: oldDir,
    expect: {
      label: 'new relay default + old worker',
      async check({ terminal, taskId, workerCalls, rowOf: readLedger }) {
        assert.equal(terminal.status, 'running');
        assert.match(terminal.blocked ?? '', /does not support the Task protocol/);
        assert.equal(readLedger(taskId).finish_required, 1);
        assert.equal(dispatchCalls(workerCalls, taskId).length, 0, 'nothing was dispatched to a worker that cannot honour it');
        process.stdout.write('  evidence: finish_required=1 blocked before dispatch; set MANOLO_TASK_FINISH=legacy to serve the old worker\n');
      },
    },
  });
} finally {
  if (keep) console.log(`kept ${extracted}`);
  else await rm(extracted, { recursive: true, force: true });
}

const failed = results.filter(result => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} compatibility cases passed (old ${oldRef}, candidate ${candidateRef})\n`);
process.exit(failed.length ? 1 : 0);
