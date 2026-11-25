import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../src/worker.mjs', import.meta.url));
const token = 'fixture-private-worker-inbox-token';
const name = 'request_human_input';
const receipt = { id: 'inbox-question-123', status: 'open' };
const fixtureTool = (toolName, args) => `fixture-tool:${JSON.stringify({ name: toolName, args })}`;
const question = args => fixtureTool(name, args);

async function until(check, label, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await sleep(20);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}

async function dataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'manolo-worker-inbox-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeRelay(t, respond = (_call, res) => json(res, receipt, 201)) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
    calls.push(call);
    respond(call, res, calls.length);
  });
  server.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  await once(server, 'listening');
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

function json(res, value, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function startWorker(t, dir, relay) {
  const child = spawn(process.execPath, [workerPath], {
    env: {
      MANOLO_DATA_DIR: dir, MANOLO_MODE: 'fixture', MANOLO_AGENT_ID: 'test-manolo', MANOLO_AGENT_TOKEN: token,
      MANOLO_FIXTURE_INSPECT_SETUP: '1', MANOLO_CODING_TOOLS: '0', PORT: '0',
      ...(relay && { MANOLO_RELAY_URL: relay.url, MANOLO_FIXTURE_TOOLS: '1' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  const kill = () => { child.kill('SIGKILL'); return closed; };
  t.after(kill);
  const port = await until(() => {
    assert.equal(child.exitCode, null, stdout + stderr);
    return /Manolo worker listening on (\d+)/.exec(stdout)?.[1];
  }, 'worker listener');
  return { url: `http://127.0.0.1:${port}`, kill, logs: () => stdout + stderr };
}

async function turn(worker, id, body) {
  const response = await fetch(`${worker.url}/v1/turns/${id}`, {
    method: body ? 'PUT' : 'GET', signal: AbortSignal.timeout(3_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { code: response.status, body: await response.json() };
}

async function submit(worker, id, text, workSessions, sessionId = 'web-parent-session') {
  const result = await turn(worker, id, { sessionId, text, workSessions });
  assert.equal(result.code, 202, JSON.stringify(result));
}

async function settled(worker, id, timeout) {
  return until(async () => {
    const { code, body } = await turn(worker, id);
    assert.equal(code, 200, JSON.stringify(body));
    if (body.status !== 'pending') return body;
  }, `settled turn ${id}`, timeout);
}

function tool(body, toolName = name) {
  assert.equal(body.status, 'done', JSON.stringify(body));
  const call = body.tools?.find(each => each.name === toolName);
  assert.ok(call, JSON.stringify(body));
  return call;
}

test('only a trusted parent turn is offered the Inbox question tool and can send a question', { timeout: 15_000 }, async t => {
  const relay = await fakeRelay(t);
  const worker = await startWorker(t, await dataDir(t), relay);
  await submit(worker, 'web-setup', 'fixture:setup', true);
  assert.ok(JSON.parse((await settled(worker, 'web-setup')).text).tools.includes(name));
  await submit(worker, 'web-question', question({ prompt: `Which site? ${token}` }), true);
  const opened = tool(await settled(worker, 'web-question'));
  assert.equal(opened.status, 'ok');
  assert.deepEqual(JSON.parse(opened.output), receipt);
  assert.equal(relay.calls.length, 1);
  const [call] = relay.calls;
  assert.deepEqual({ method: call.method, path: call.path, body: call.body }, {
    method: 'POST', path: '/v1/inbox/question', body: { turnId: 'web-question', prompt: 'Which site? [redacted]' },
  });
  assert.equal(call.headers.authorization, `Bearer ${token}`);
  assert.equal(call.headers['content-type'], 'application/json');
  assert.match(call.headers['idempotency-key'], /^[a-f0-9]{64}$/);

  // The same session immediately accepts a new turn without waiting for an Inbox answer; missing/false are both untrusted.
  await submit(worker, 'unflagged-setup', 'fixture:setup', undefined);
  assert.ok(!JSON.parse((await settled(worker, 'unflagged-setup')).text).tools.includes(name));
  for (const [id, flag] of [['telegram-like', undefined], ['device-like', false]]) {
    await submit(worker, id, question({ prompt: 'Must not open' }), flag);
    assert.equal(tool(await settled(worker, id)).status, 'error');
  }
  await submit(worker, 'child-attempt', fixtureTool('delegate_work', {
    title: 'Untrusted child', task: question({ prompt: 'Must not open' }),
  }), true);
  const child = tool(await settled(worker, 'child-attempt'), 'delegate_work');
  // The child cannot open a question: it is not offered request_human_input, and the relay is never called.
  assert.equal(child.status, 'ok');
  assert.equal(JSON.parse(child.output).result, 'Fixture tool failed');
  assert.equal(relay.calls.length, 1);
});

test('a restart after the relay receives a question replays the exact operation identity', { timeout: 15_000 }, async t => {
  const answered = { ...receipt, status: 'answered' };
  const relay = await fakeRelay(t, (_call, res, count) => {
    // Simulate an operation accepted by the relay before the worker is able to record its result.
    if (count > 1) json(res, answered);
  });
  const dir = await dataDir(t);
  const before = await startWorker(t, dir, relay);
  await submit(before, 'replay-question', question({ prompt: 'Which site?' }), true);
  const first = await until(() => relay.calls[0], 'the original relay request');
  assert.deepEqual(await before.kill(), [null, 'SIGKILL']);
  const after = await startWorker(t, dir, relay);
  assert.deepEqual(JSON.parse(tool(await settled(after, 'replay-question')).output), answered);
  assert.equal(relay.calls.length, 2);
  assert.deepEqual(relay.calls[1].body, first.body);
  assert.equal(relay.calls[1].headers['idempotency-key'], first.headers['idempotency-key']);
  const recovered = await turn(after, 'replay-question', { sessionId: 'web-parent-session', text: question({ prompt: 'Which site?' }) });
  assert.equal(recovered.code, 200);
  assert.equal(relay.calls.length, 2);
  await submit(after, 'new-question', question({ prompt: 'Which site?' }), true);
  assert.equal(tool(await settled(after, 'new-question')).status, 'ok');
  assert.notEqual(relay.calls[2].headers['idempotency-key'], first.headers['idempotency-key']);
});

test('invalid prompts stay local and invalid or oversized relay receipts stay out of tool errors', { timeout: 15_000 }, async t => {
  const relay = await fakeRelay(t, (call, res) => {
    if (call.body.prompt === 'error') return json(res, { error: token }, 503);
    if (call.body.prompt.startsWith('rejected-')) return json(res, { error: token }, Number(call.body.prompt.slice(9)));
    if (call.body.prompt === 'bad-id') return json(res, { id: token, status: 'open' });
    if (call.body.prompt === 'extra') return json(res, { ...receipt, leak: token });
    if (call.body.prompt === 'redirect') {
      res.writeHead(307, { location: '/redirect-target' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (call.body.prompt === 'malformed') return res.end(`broken receipt: ${token}`);
    res.write(' '.repeat(2048));
    res.end(JSON.stringify(receipt));
  });
  const worker = await startWorker(t, await dataDir(t), relay);
  for (const [i, args] of [{ prompt: ' \n ' }, { prompt: 'ok', turnId: 'forged' }, { prompt: '🦀'.repeat(1500) }].entries()) {
    const id = `invalid-${i}`;
    await submit(worker, id, question(args), true);
    assert.equal(tool(await settled(worker, id)).status, 'error');
  }
  assert.equal(relay.calls.length, 0);
  for (const prompt of ['error', 'bad-id', 'extra', 'redirect', 'malformed', 'oversized']) {
    await submit(worker, `receipt-${prompt}`, question({ prompt }), true);
    const result = tool(await settled(worker, `receipt-${prompt}`));
    assert.equal(result.status, 'error');
    assert.match(result.output, /outcome unknown/);
    assert.doesNotMatch(result.output, new RegExp(`${token}|127\\.0\\.0\\.1|redirect-target`));
  }
  for (const code of [400, 401, 403, 404, 409]) {
    await submit(worker, `rejected-${code}`, question({ prompt: `rejected-${code}` }), true);
    const result = tool(await settled(worker, `rejected-${code}`));
    assert.equal(result.status, 'error');
    assert.match(result.output, /rejected.*no new question/i);
    assert.doesNotMatch(result.output, new RegExp(`${token}|127\\.0\\.0\\.1`));
  }
  assert.equal(relay.calls.length, 11);
  assert.doesNotMatch(worker.logs(), new RegExp(token));
});

test('a stalled Inbox receipt reaches the deadline and remains an unknown outcome', { timeout: 15_000 }, async t => {
  const relay = await fakeRelay(t, (_call, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(`{"id":"${token}`); // Never finish the response body.
  });
  const worker = await startWorker(t, await dataDir(t), relay);
  await submit(worker, 'stalled-receipt', question({ prompt: 'Which site?' }), true);
  const result = tool(await settled(worker, 'stalled-receipt', 12_000));
  assert.equal(result.status, 'error');
  assert.match(result.output, /outcome unknown/);
  assert.doesNotMatch(result.output, new RegExp(token));
  assert.equal(relay.calls.length, 1);
});

test('the question tool is not offered when no relay is configured', { timeout: 10_000 }, async t => {
  const worker = await startWorker(t, await dataDir(t));
  await submit(worker, 'off-setup', 'fixture:setup', true);
  assert.ok(!JSON.parse((await settled(worker, 'off-setup')).text).tools.includes(name));
});
