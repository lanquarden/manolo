import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { key } from '../src/relay-config.mjs';
import { openRelayStore } from '../src/relay-store.mjs';

const addr = port => `http://127.0.0.1:${port}`;
const basic = (name, password) => `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
const workerTurnId = (owner, agent, id) => key('web', owner, agent, id);

async function until(check, description) {
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await sleep(25)) {
    const result = await check();
    if (result) return result;
  }
  assert.fail(`Timed out: ${description}`);
}

async function request(base, path, authorization, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(authorization && { authorization }), ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000),
  });
  return [response.status, await response.json()];
}

test('relay persists scoped inbox questions, responds exactly once, and dispatches in original web FIFO after restart', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'manolo-inbox-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokens = Object.fromEntries(['CANARY', 'OTHER', 'OWNER', 'TESTER'].map(name => [name, randomBytes(24).toString('hex')]));
  const canary = `Bearer ${tokens.CANARY}`;
  const other = `Bearer ${tokens.OTHER}`;
  const owner = basic('owner', tokens.OWNER);
  const tester = basic('tester', tokens.TESTER);
  const mutation = { 'x-manolo-request': '1' };
  const inbox = '/api/inbox';
  const parent = workerTurnId('owner', 'canary', 'origin');
  const later = workerTurnId('owner', 'canary', 'later');
  const submissions = [];
  let releaseParent = false;
  const worker = createServer(async (req, res) => {
    const id = req.url.split('/').at(-1);
    if (req.method === 'PUT') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      submissions.push({ id, ...JSON.parse(raw) });
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(id === parent && !releaseParent ? { status: 'pending' } : { status: 'done', text: 'ok' }));
  }).listen(0, '127.0.0.1');
  await once(worker, 'listening');
  t.after(() => worker.close());

  const url = addr(worker.address().port);
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({
    agents: { canary: { url, tokenEnv: 'CANARY' }, other: { url, tokenEnv: 'OTHER' } },
    owners: { owner: { agent: 'canary', passwordEnv: 'OWNER' }, tester: { agent: 'other', passwordEnv: 'TESTER' } },
    routes: [], inbox: [{ from: 'other', to: 'canary' }],
  }));
  // Device submissions use the same store entrypoint but a reserved owner namespace.
  const database = openRelayStore(join(dir, 'relay.sqlite'));
  database.webSubmit('device:mic', 'canary', 'voice', 'Device input');
  database.db.exec('DROP TABLE relay_inbox_questions'); // Simulate an existing pre-feature database.
  database.db.close();
  const start = async (enabled = true) => {
    const child = spawn(process.execPath, ['src/relay.mjs'], {
      cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...tokens, MANOLO_DATA_DIR: dir, MANOLO_RELAY_CONFIG: config,
        ...(enabled && { MANOLO_WORK_SESSION_AGENT: 'canary' }), PORT: '0', MANOLO_INTERNAL_PORT: '0' },
    });
    const closed = once(child, 'exit');
    const stop = async (signal = 'SIGKILL') => { child.kill(signal); await closed; };
    t.after(() => stop());
    let log = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk; });
    const port = name => until(() => {
      assert.equal(child.exitCode, null, log);
      return new RegExp(`${name} listening on .*:(\\d+)`).exec(log)?.[1];
    }, `${name} listener`);
    return { web: addr(await port('web')), internal: addr(await port('internal')), stop };
  };
  const first = await start();
  const create = (relay, body, idem = 'question-1', auth = canary) => request(relay.internal, '/v1/inbox/question', auth, body,
    idem === null ? {} : { 'idempotency-key': idem });
  const prompt = '  Which date?\n(Use local time.)  ';
  const question = { turnId: parent, prompt };
  assert.equal((await request(first.web, inbox))[0], 401);
  assert.deepEqual(await request(first.web, inbox, owner), [200, { messages: [], questions: [], taskItems: [] }]);
  assert.deepEqual(await request(first.web, inbox, tester), [200, { messages: [] }]);
  assert.equal((await request(first.internal, '/v1/inbox', other, { to: 'canary', text: 'Existing message' }))[0], 200);
  assert.equal((await request(first.web, '/api/turns', owner, { id: 'origin', text: 'Start here' }, mutation))[0], 200);
  assert.equal((await request(first.web, '/api/turns', owner, { id: 'later', text: 'Already in FIFO' }, mutation))[0], 200);
  assert.equal((await request(first.web, '/api/turns', tester, { id: 'outside', text: 'Other agent' }, mutation))[0], 200);
  await until(() => submissions.find(row => row.id === parent), 'worker starts parent');

  assert.equal((await create(first, question, 'test', null))[0], 401);
  assert.equal((await create(first, question, 'test', other))[0], 403);
  for (const id of ['origin', workerTurnId('device:mic', 'canary', 'voice'), workerTurnId('tester', 'other', 'outside')]) {
    assert.equal((await create(first, { ...question, turnId: id }))[0], 404);
  }
  for (const idem of [null, '', 'contains*punctuation', 'x'.repeat(129)]) assert.equal((await create(first, question, idem))[0], 400);
  for (const body of [{ ...question, owner: 'owner' }, { ...question, prompt: ' ' }, { ...question, prompt: 'x'.repeat(2001) }]) {
    assert.equal((await create(first, body))[0], 400);
  }
  const [created, open] = await create(first, question);
  assert.equal(created, 200);
  const { id } = open;
  assert.ok(id);
  assert.deepEqual(open, { id, status: 'open' });
  assert.deepEqual(await create(first, question), [200, open]);
  assert.equal((await create(first, { ...question, prompt: 'Different' }))[0], 409);
  assert.equal((await create(first, { ...question, turnId: later }))[0], 409);
  assert.equal((await create(first, question, 'different-key-for-same-parent'))[0], 409);
  const [listed, data] = await request(first.web, inbox, owner);
  assert.equal(listed, 200);
  assert.deepEqual(data.questions, [{ id, parentTurnId: 'origin', prompt, status: 'open' }]);
  assert.equal(data.messages[0].text, 'Existing message');
  const path = `${inbox}/questions/${id}/respond`;
  const answer = '  Use Tuesday.  ';
  assert.equal((await request(first.web, path, null, { answer }, mutation))[0], 401);
  assert.equal((await request(first.web, path, owner, { answer }))[0], 403);
  assert.equal((await request(first.web, path, tester, { answer }, mutation))[0], 404);
  for (const invalid of [{}, { answer: ' ' }, { decline: false }, { answer, decline: true }, { answer: 'x'.repeat(4000) }]) {
    assert.equal((await request(first.web, path, owner, invalid, mutation))[0], 400);
  }
  const response = () => request(first.web, path, owner, { answer }, mutation);
  const [[answered, receipt], duplicate] = await Promise.all([response(), response()]);
  const { continuationTurnId } = receipt;
  assert.ok(continuationTurnId);
  assert.equal(answered, 200);
  assert.deepEqual(receipt, { id, status: 'answered', continuationTurnId });
  assert.deepEqual(duplicate, [200, receipt]);
  assert.equal((await request(first.web, '/api/turns', owner, { id: continuationTurnId, text: 'Spoof' }, mutation))[0], 409);
  assert.equal((await request(first.web, path, owner, { answer: answer.trim() }, mutation))[0], 409);
  assert.deepEqual(await create(first, question), [200, { id, status: 'answered' }]);
  assert.equal((await create(first, question, 'new-key-after-answer'))[0], 409);
  assert.ok(!submissions.some(row => row.id === later || row.id === workerTurnId('owner', 'canary', continuationTurnId)));

  const [madeSecond, second] = await create(first, { turnId: later, prompt: 'Do you have more details?' }, 'question-2');
  assert.equal(madeSecond, 200);
  const declinePath = `${inbox}/questions/${second.id}/respond`;
  const decline = { id: second.id, status: 'declined' };
  assert.deepEqual(await request(first.web, declinePath, owner, { decline: true }, mutation), [200, decline]);
  assert.equal((await request(first.web, declinePath, owner, { answer }, mutation))[0], 409);
  await first.stop(); // Abrupt stop while parent still blocks the queued continuation.

  const restarted = await start();
  assert.deepEqual(await request(restarted.web, path, owner, { answer }, mutation), [200, receipt]);
  assert.equal((await request(restarted.web, path, owner, { decline: true }, mutation))[0], 409);
  assert.deepEqual(await request(restarted.web, declinePath, owner, { decline: true }, mutation), [200, decline]);
  const [, afterRestart] = await request(restarted.web, inbox, owner);
  assert.deepEqual(afterRestart.messages, data.messages);
  assert.deepEqual(afterRestart.questions.find(q => q.id === id), { ...receipt, parentTurnId: 'origin', prompt });
  releaseParent = true;
  const [, settled] = await until(async () => {
    const result = await request(restarted.web, `/api/turns/${continuationTurnId}`, owner);
    return result[1].status === 'done' && result;
  }, 'continuation dispatch');
  assert.equal(settled.text, 'ok');
  const [, history] = await request(restarted.web, '/api/turns', owner);
  assert.deepEqual(history.turns.map(row => row.id), ['origin', 'later', continuationTurnId]);
  const ownSubmissions = submissions.filter(row => row.sessionId === key('web-session', 'owner', 'canary'));
  assert.deepEqual(ownSubmissions.map(row => row.id), [parent, later, workerTurnId('owner', 'canary', continuationTurnId)]);
  const { text, workSessions, ...transport } = ownSubmissions.at(-1);
  assert.equal(workSessions, true);
  assert.deepEqual(Object.keys(transport).sort(), ['id', 'sessionId'], 'no approval metadata travels to worker');
  for (const part of ['Previous assistant context', 'Owner input', id, 'origin', JSON.stringify(prompt), JSON.stringify(answer)]) {
    assert.ok(text.includes(part), `Continuation text contains ${part}`);
  }
  await restarted.stop('SIGTERM');
  const disabled = await start(false);
  assert.deepEqual(await request(disabled.web, inbox, owner), [200, { messages: data.messages }]);
  assert.equal((await request(disabled.web, path, owner, { answer }, mutation))[0], 404);
  assert.equal((await create(disabled, question))[0], 404);
});

test('a SQLite failure recording the response rolls back its continuation turn', () => {
  const store = openRelayStore(':memory:');
  try {
    store.webSubmit('owner', 'canary', 'original', 'Start');
    const { id } = store.openInboxQuestion('canary', workerTurnId('owner', 'canary', 'original'), 'When?', 'retry-key', () => true);
    store.db.exec(`CREATE TRIGGER fail_response BEFORE UPDATE ON relay_inbox_questions BEGIN SELECT RAISE(ABORT, 'response write failed'); END`);
    assert.throws(() => store.respondInboxQuestion('owner', 'canary', id, 'Tuesday'), /response write failed/);
    assert.deepEqual(store.webHistory('owner', 'canary').map(row => row.id), ['original']);
    assert.equal(store.inboxQuestions('owner', 'canary')[0].status, 'open');
    store.db.exec('DROP TRIGGER fail_response');
    const answer = 'Keep exact: \u0000\ud800\n';
    const receipt = store.respondInboxQuestion('owner', 'canary', id, answer);
    assert.equal(receipt.status, 'answered');
    assert.deepEqual(store.respondInboxQuestion('owner', 'canary', id, answer), receipt);
    assert.throws(() => store.respondInboxQuestion('owner', 'canary', id, answer.replace('\ud800', '\ufffd')), { statusCode: 409 });
    const history = store.webHistory('owner', 'canary');
    assert.deepEqual(history.map(row => row.id), ['original', receipt.continuationTurnId]);
    assert.ok(history.at(-1).text.endsWith(JSON.stringify(answer)));
  } finally {
    store.db.close();
  }
});

test('active question cap is scoped to an owner and a replay does not consume capacity', () => {
  const store = openRelayStore(':memory:');
  try {
    const ask = (owner, i) => store.openInboxQuestion('canary', workerTurnId(owner, 'canary', `turn-${i}`), 'When?', `${owner}-${i}`, () => true);
    for (let i = 0; i <= 50; i++) store.webSubmit('owner', 'canary', `turn-${i}`, 'Start');
    for (let i = 0; i < 50; i++) assert.equal(ask('owner', i).status, 'open');
    assert.equal(ask('owner', 0).status, 'open');
    assert.throws(() => ask('owner', 50), { statusCode: 429 });
    store.webSubmit('old-owner', 'canary', 'turn-0', 'Start');
    assert.equal(ask('old-owner', 0).status, 'open');
    assert.equal(store.inboxQuestions('old-owner', 'canary').length, 1);
    const { id } = ask('owner', 0);
    assert.throws(() => store.respondInboxQuestion('old-owner', 'canary', id, null), { statusCode: 404 });
    store.respondInboxQuestion('owner', 'canary', id, null);
    assert.equal(ask('owner', 50).status, 'open');
    assert.equal(store.inboxQuestions('owner', 'canary').filter(row => row.status === 'open').length, 50);
  } finally {
    store.db.close();
  }
});
