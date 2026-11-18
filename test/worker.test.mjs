import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../src/worker.mjs', import.meta.url));
const token = 'fixture-private-bearer-long-enough';
const auth = { authorization: `Bearer ${token}` };

async function until(check, label) {
  const deadline = Date.now() + 5000;
  do {
    const result = await check();
    if (result) return result;
    await sleep(20);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}

async function dataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'manolo-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function launch(t, dir, options = {}) {
  // Inherit no workstation credentials, NODE_OPTIONS, HOME, or proxy settings.
  const child = spawn(process.execPath, [workerPath], {
    env: {
      MANOLO_DATA_DIR: dir, MANOLO_MODE: 'fixture', MANOLO_AGENT_ID: 'test-manolo', MANOLO_AGENT_TOKEN: token,
      PORT: '0', ...options,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  const stop = async (signal = 'SIGTERM') => {
    child.kill(signal);
    return closed;
  };
  t.after(() => stop('SIGKILL'));
  return {
    stop, closed, logs: () => stdout + stderr,
    async start() {
      const port = await until(() => {
        assert.equal(child.exitCode, null, stdout + stderr);
        return /Manolo worker listening on (\d+)/.exec(stdout)?.[1];
      }, 'worker listener');
      return `http://127.0.0.1:${port}`;
    },
  };
}

async function request(url, path, opts) {
  const response = await fetch(url + path, { signal: AbortSignal.timeout(3000), ...opts });
  assert.match(response.headers.get('content-type'), /^application\/json/);
  return { code: response.status, body: await response.json() };
}

function put(url, id, sessionId, text) {
  return request(url, `/v1/turns/${id}`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, text }),
  });
}
function get(url, id) {
  return request(url, `/v1/turns/${id}`, { headers: auth });
}
async function settled(url, id) {
  return until(async () => {
    const { code, body } = await get(url, id);
    assert.equal(code, 200, JSON.stringify(body));
    if (body.status !== 'pending') return body;
  }, `terminal turn ${id}`);
}
function rows(dir, sql) {
  const db = new DatabaseSync(join(dir, 'harness.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(); }
  finally { db.close(); }
}

const expected = text => ({ status: 'done', text: `Fixture: ${text}` });

test('auth, request boundaries, and secret-safe responses', { timeout: 15_000 }, async t => {
  const dir = await dataDir(t);
  const worker = launch(t, dir);
  const url = await worker.start();
  assert.deepEqual(await request(url, '/healthz'), { code: 200, body: { status: 'ok' } });
  assert.equal((await request(url, '/v1/turns/unknown')).code, 401);
  assert.equal((await request(url, '/v1/turns/unknown', { method: 'PUT', headers: { authorization: 'Bearer wrong' }, body: 'not JSON' })).code, 401);
  assert.equal((await get(url, 'unknown')).code, 404);
  assert.equal((await get(url, 'invalid%2Fid')).code, 404);
  assert.equal((await put(url, 'bad-session', '../bad', 'text')).code, 400);
  assert.equal((await put(url, 'oversize-text', 'session', '🙂'.repeat(2001))).code, 400);
  const raw = body => request(url, '/v1/turns/bad', { method: 'PUT', headers: auth, body });
  assert.equal((await raw('{wrong')).code, 400);
  assert.equal((await raw(Buffer.from([0xff]))).code, 400);
  assert.equal((await raw(JSON.stringify({ sessionId: 's', text: 'x', agent: 'spoof' }))).code, 400);
  assert.equal((await raw(' '.repeat(40 * 1024))).code, 413);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(40 * 1024, 0x20)); controller.close(); } });
  assert.equal((await request(url, '/v1/turns/huge', { method: 'PUT', headers: auth, duplex: 'half', body: stream })).code, 413);
  const maxUnits = '🙂'.repeat(2000);
  assert.ok((await put(url, '__proto__', '__proto__', maxUnits)).code < 300);
  assert.deepEqual(await settled(url, '__proto__'), expected(maxUnits));
  assert.ok((await put(url, 'secret', 'other', `not for output: ${token}`)).code < 300);
  assert.deepEqual(await settled(url, 'secret'), expected('not for output: [redacted]'));
  assert.doesNotMatch(worker.logs(), new RegExp(token));
  assert.deepEqual(await worker.stop(), [0, null]);
});

test('racing PUTs preserve one input per ID and separate answers/sessions', { timeout: 15_000 }, async t => {
  const dir = await dataDir(t);
  const url = await launch(t, dir, { MANOLO_FIXTURE_DELAY_MS: '100' }).start();
  const attempts = await Promise.all([
    ...Array.from({ length: 8 }, () => put(url, 'once', 'a', 'first')),
    put(url, 'once', 'b', 'different input'),
  ]);
  const won = attempts[0].code !== 409;
  assert.ok(attempts.slice(0, 8).every(({ code }) => won ? code === 202 || code === 200 : code === 409));
  assert.ok(won ? attempts.at(-1).code === 409 : [200, 202].includes(attempts.at(-1).code));
  const same = await Promise.all(['second', 'third', 'fourth'].map(text => put(url, text, 'a', text)));
  assert.ok(same.every(({ code }) => [200, 202].includes(code)));
  assert.deepEqual(await settled(url, 'fourth'), expected('fourth'));
  for (const id of ['second', 'third', 'fourth']) assert.deepEqual(await settled(url, id), expected(id));
  assert.deepEqual(await settled(url, 'once'), expected(won ? 'first' : 'different input'));
  assert.equal((await put(url, 'once', won ? 'a' : 'b', 'wrong text')).code, 409);
  assert.equal((await put(url, 'once', won ? 'b' : 'a', won ? 'first' : 'different input')).code, 409);
  const admissions = rows(dir, "SELECT conversation_id, json_extract(record, '$.requestId') AS request_id FROM submissions ORDER BY id");
  const a = admissions.filter(row => row.request_id !== 'once');
  assert.equal(admissions.length, 4);
  assert.equal(new Set(a.map(row => row.conversation_id)).size, 1);
  assert.ok((await put(url, 'history-b', 'b', 'fixture:history')).code < 300);
  assert.deepEqual(await settled(url, 'history-b'), { status: 'done', text: JSON.stringify(won ? [] : ['different input']) });
  assert.ok((await put(url, 'history-a', 'a', 'fixture:history')).code < 300);
  assert.deepEqual(await settled(url, 'history-a'), { status: 'done', text: JSON.stringify(admissions.filter(row => row.conversation_id === a[0].conversation_id).map(row => row.request_id === 'once' ? 'first' : row.request_id)) });
  await put(url, 'fails', 'c', 'fixture:fail');
  await put(url, 'after-failure', 'c', 'still answered');
  assert.deepEqual(await settled(url, 'fails'), { status: 'failed' });
  assert.deepEqual(await settled(url, 'after-failure'), expected('still answered'));
});

test('kill mid-generation and resume placed and queued submissions without a retry PUT', { timeout: 15_000 }, async t => {
  const dir = await dataDir(t);
  const oldWorker = launch(t, dir, { MANOLO_FIXTURE_DELAY_MS: '30000' });
  const url = await oldWorker.start();
  assert.deepEqual(await put(url, 'interrupted', 'resume-session', 'recover me'), { code: 202, body: { status: 'pending' } });
  assert.deepEqual(await put(url, 'queued', 'resume-session', 'after recovery'), { code: 202, body: { status: 'pending' } });
  const active = await until(() => rows(dir, `SELECT record FROM tasks WHERE json_extract(record, '$.kind') = 'pi.generation' AND status = 'running'
    AND json_extract(record, '$.state.checkpoint.phase') = 'request'`).length, 'committed model request checkpoint');
  assert.equal(active, 1);
  const competing = launch(t, dir);
  assert.deepEqual(await competing.closed, [1, null]);
  assert.match(competing.logs(), /already has a writer/);
  assert.deepEqual(await oldWorker.stop('SIGKILL'), [null, 'SIGKILL']);

  const foreign = launch(t, dir, { MANOLO_AGENT_ID: 'wrong-agent' });
  assert.deepEqual(await foreign.closed, [1, null]);
  assert.match(foreign.logs(), /belongs to another agent/);
  const next = await launch(t, dir).start();
  assert.deepEqual(await settled(next, 'queued'), expected('after recovery'));
  assert.deepEqual(await settled(next, 'interrupted'), expected('recover me'));
  assert.deepEqual(await put(next, 'interrupted', 'resume-session', 'recover me'), { code: 200, body: expected('recover me') });
  assert.equal((await put(next, 'interrupted', 'resume-session', 'different')).code, 409);
  assert.equal(rows(dir, 'SELECT id FROM submissions').length, 2);
  assert.equal(rows(dir, `SELECT id FROM entries WHERE json_extract(record, '$.kind') = 'pi.user'`).length, 2);
});

test('relay tools use fixed authenticated requests and do not replay an interrupted write', { timeout: 20_000 }, async t => {
  const dir = await dataDir(t);
  const calls = [];
  const relay = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, key: req.headers['idempotency-key'], body });
    if (body.text !== 'commit but do not acknowledge') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([1, null]));
    }
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); return new Promise(resolve => relay.close(resolve)); });
  const opts = { MANOLO_RELAY_URL: `http://127.0.0.1:${relay.address().port}`, MANOLO_FIXTURE_TOOLS: '1' };
  const worker = launch(t, dir, opts);
  const url = await worker.start();
  const toolInput = (name, args) => `fixture-tool:${JSON.stringify({ name, args })}`;
  const tool = (id, name, args) => put(url, id, 'tools', toolInput(name, args));
  const inbox = { to: 'allowed', text: 'hello' };
  const draft = { title: 'Title', widgets: [{ kind: 'heading', text: 'Section' }, { kind: 'note', text: 'Note' }] };
  const success = { status: 'done', text: 'Fixture tool succeeded' };
  const fail = { status: 'done', text: 'Fixture tool failed' };
  await tool('inbox', 'send_inbox', inbox);
  assert.deepEqual(await settled(url, 'inbox'), success);
  await tool('draft', 'write_dashboard_draft', draft);
  assert.deepEqual(await settled(url, 'draft'), success);
  await tool('no-bash', 'bash', { command: 'not allowed' });
  assert.deepEqual(await settled(url, 'no-bash'), fail);
  await tool('no-sender', 'send_inbox', { ...inbox, sender: 'forged' });
  assert.deepEqual(await settled(url, 'no-sender'), fail);
  assert.deepEqual(calls.map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'POST', path: '/v1/inbox', body: inbox },
    { method: 'PUT', path: '/v1/dashboard/draft', body: draft },
  ]);

  const interrupted = { ...inbox, text: 'commit but do not acknowledge' };
  await tool('interrupted-tool', 'send_inbox', interrupted);
  await until(() => calls.length === 3, 'side effect recorded by loopback relay');
  assert.deepEqual(await worker.stop('SIGKILL'), [null, 'SIGKILL']);
  const next = await launch(t, dir, opts).start();
  assert.deepEqual(await settled(next, 'interrupted-tool'), fail);
  assert.deepEqual(await put(next, 'interrupted-tool', 'tools', toolInput('send_inbox', interrupted)), { code: 200, body: fail });
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(call => call.key)).size, 3);
  for (const call of calls) {
    assert.equal(call.auth, auth.authorization);
    assert.match(call.key, /^[a-f0-9]{64}$/);
  }
});

test('live-mode startup validates the pinned provider catalog and explicit keys without making a request', { timeout: 15_000 }, async t => {
  const dir = await dataDir(t);
  const opts = { MANOLO_MODE: 'live', MANOLO_PROVIDER: 'openai', MANOLO_MODEL: 'gpt-6-sol' };
  const noKey = launch(t, dir, { ...opts, OPENAI_CODEX_TOKEN: 'should-not-be-used' });
  assert.deepEqual(await noKey.closed, [1, null]);
  const worker = launch(t, dir, { ...opts, OPENAI_API_KEY: 'test-not-a-real-key' });
  const url = await worker.start();
  assert.deepEqual(await request(url, '/healthz'), { code: 200, body: { status: 'ok' } });
  assert.deepEqual(await worker.stop(), [0, null]);
  assert.doesNotMatch(worker.logs(), /test-not-a-real-key/);
});
