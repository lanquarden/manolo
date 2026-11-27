import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { key } from '../src/relay-config.mjs';

const cwd = new URL('../', import.meta.url);
const secret = () => randomBytes(24).toString('hex');
const addr = port => `http://127.0.0.1:${port}`;
const basic = (user, pw) => ({ authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}` });
const mutation = { 'x-manolo-request': '1' };
const fixtureTool = (name, args) => `fixture-tool:${JSON.stringify({ name, args })}`;
const request = (url, path, auth, method = 'GET', body, extra = {}) => fetch(`${url}${path}`, {
  method, headers: { ...auth, ...(body && { 'content-type': 'application/json' }), ...extra },
  body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000),
});

async function until(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function start(t, filename, env) {
  const child = spawn(process.execPath, [`src/${filename}.mjs`], {
    cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const closed = once(child, 'exit');
  return {
    log: () => log,
    async port(re) {
      return until(() => {
        assert.equal(child.exitCode, null, log);
        return Number(re.exec(log)?.[1]) || null;
      }, `listener for ${filename}`);
    },
    async end(signal = 'SIGKILL') {
      child.kill(signal);
      await closed;
    },
  };
}

test('a durable Task queues, parks on Inbox, survives relay and worker restart, resumes once, and settles without a new chat turn', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { CANARY_TOKEN: secret(), OWNER_PASSWORD: secret() };
  const relayData = join(root, 'relay');
  const workerData = join(root, 'worker');
  const configPath = join(root, 'relay.json');
  // The worker reaches the relay's internal listener through a stable address that survives relay restarts.
  const paths = [];
  let internal = 'http://127.0.0.1:1';
  const proxy = createServer(async (req, res) => {
    paths.push(req.url);
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(internal + req.url, {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers)
          .filter(([name]) => ['authorization', 'content-type', 'idempotency-key'].includes(name))),
        body: Buffer.concat(chunks),
      });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(await response.text());
    } catch {
      res.writeHead(503).end();
    }
  }).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());

  const launchWorker = async () => {
    const worker = start(t, 'worker', {
      MANOLO_AGENT_ID: 'canary', MANOLO_AGENT_TOKEN: env.CANARY_TOKEN, MANOLO_DATA_DIR: workerData,
      MANOLO_MODE: 'fixture', MANOLO_CODING_TOOLS: '0', MANOLO_FIXTURE_TOOLS: '1',
      MANOLO_FIXTURE_INSPECT_SETUP: '1', PORT: '0',
      MANOLO_RELAY_URL: addr(proxy.address().port),
      MANOLO_WORK_BLUEPRINTS: JSON.stringify({ review: { description: 'Review notes', instructions: 'Lead with the conclusion.' } }),
    });
    const url = addr(await worker.port(/worker listening on (\d+)/));
    return { worker, url };
  };
  const launchRelay = async () => {
    const relay = start(t, 'relay', {
      ...env, MANOLO_RELAY_CONFIG: configPath, MANOLO_DATA_DIR: relayData,
      MANOLO_WORK_SESSION_AGENT: 'canary', PORT: '0', MANOLO_INTERNAL_PORT: '0',
    });
    internal = addr(await relay.port(/internal listening on .*:(\d+)/));
    return { relay, web: addr(await relay.port(/web listening on .*:(\d+)/)) };
  };
  const writeConfig = workerUrl => writeFile(configPath, JSON.stringify({
    agents: { canary: { url: workerUrl, tokenEnv: 'CANARY_TOKEN' } },
    owners: { owner: { agent: 'canary', passwordEnv: 'OWNER_PASSWORD' } }, routes: [], inbox: [],
  }));

  let worker = await launchWorker();
  await writeConfig(worker.url);
  let relay = await launchRelay();
  const auth = basic('owner', env.OWNER_PASSWORD);
  const tasksOf = async base => {
    const response = await request(base, '/api/tasks', auth);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).tasks;
  };
  const inboxOf = async base => {
    const response = await request(base, '/api/inbox', auth);
    assert.equal(response.status, 200);
    return response.json();
  };
  const turnsOf = async base => (await (await request(base, '/api/turns', auth)).json()).turns;
  const createTask = async (base, id, args) => {
    const response = await request(base, '/api/turns', auth, 'POST', { id, text: fixtureTool('create_task', args) }, mutation);
    assert.equal(response.status, 200, await response.clone().text());
  };

  // 1. The orchestrator creates a Task from a web turn. The Task is a durable row, not the chat turn.
  const prompt = 'Which date should I use?';
  const childInput = fixtureTool('post_inbox', { kind: 'question', prompt });
  await createTask(relay.web, 'delegate-one', { title: 'Lunch note', task: childInput, blueprint: 'review' });
  const task = await until(async () => (await tasksOf(relay.web)).find(row => row.title === 'Lunch note'), 'task row');
  assert.equal(task.status, 'queued');
  assert.deepEqual(task.blueprint.id, 'review');
  assert.match(task.blueprint.revision, /^[0-9a-f]{64}$/);
  assert.equal(task.originTurnId, 'delegate-one');
  assert.equal(task.scheduled, false);
  const waiting = await until(async () => {
    const row = (await tasksOf(relay.web)).find(item => item.id === task.id);
    return row?.status === 'waiting' && row;
  }, 'task waits for input');
  assert.equal(waiting.status, 'waiting', 'waiting for input is not running');
  assert.equal(waiting.executionId, undefined, 'the scheduler slot is released while waiting');
  const inbox = await until(async () => {
    const payload = await inboxOf(relay.web);
    return payload.taskItems?.find(item => item.taskId === task.id) && payload;
  }, 'task inbox item');
  const item = inbox.taskItems.find(entry => entry.taskId === task.id);
  assert.equal(item.kind, 'question');
  assert.equal(item.prompt, prompt);
  assert.equal(item.taskTitle, 'Lunch note');
  const historyBefore = await until(async () => {
    const turns = await turnsOf(relay.web);
    return turns.length === 1 && turns[0].status === 'done' && turns;
  }, 'originating turn completes');
  assert.deepEqual(historyBefore.map(row => row.id), ['delegate-one']);
  // One execution was admitted, and the scheduler released its slot while the Task waited.
  const ledger = id => {
    const db = new DatabaseSync(join(relayData, 'relay.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT status, execution_id, execution_kind, dispatch_attempts FROM tasks WHERE id=?').get(id);
    } finally {
      db.close();
    }
  };
  const firstExecution = ledger(task.id);
  assert.equal(firstExecution.status, 'waiting');
  assert.equal(firstExecution.dispatch_attempts, 0);
  assert.match(firstExecution.execution_id, /^[0-9a-f]{32}$/);
  // The worker opened exactly one Inbox item for this Task.
  assert.equal(paths.filter(path => path === `/v1/tasks/${task.id}/inbox`).length, 1);
  const notices = await (await request(relay.web, '/api/tasks/events', auth)).json();
  assert.ok(notices.events.some(event => event.kind === 'inbox' && event.text.includes('Lunch note')), JSON.stringify(notices));

  // 2. The relay and the worker both restart while the Task waits. Nothing is lost: the row, the item and the parked
  //    child execution are all durable.
  await relay.relay.end('SIGKILL');
  await worker.worker.end('SIGKILL');
  worker = await launchWorker();
  await writeConfig(worker.url);
  relay = await launchRelay();
  assert.deepEqual((await tasksOf(relay.web)).map(row => [row.id, row.status]), [[task.id, 'waiting']]);

  // 3. The authoritative web Inbox response queues the SAME Task exactly once and inserts no chat turn.
  const respondPath = `/api/tasks/${task.id}/inbox/${item.id}/respond`;
  assert.equal((await request(relay.web, respondPath, {}, 'POST', { answer: 'Tuesday' }, mutation)).status, 401);
  assert.equal((await request(relay.web, respondPath, auth, 'POST', { answer: 'Tuesday' })).status, 403);
  const answered = await request(relay.web, respondPath, auth, 'POST', { answer: 'Tuesday' }, mutation);
  assert.equal(answered.status, 200, await answered.clone().text());
  const receipt = await answered.json();
  assert.deepEqual(receipt, { itemId: item.id, taskId: task.id, status: 'answered', taskStatus: 'queued' });
  assert.deepEqual(await (await request(relay.web, respondPath, auth, 'POST', { answer: 'Tuesday' }, mutation)).json(), receipt);
  assert.equal((await request(relay.web, respondPath, auth, 'POST', { answer: 'Wednesday' }, mutation)).status, 409);
  assert.equal((await request(relay.web, respondPath, auth, 'POST', { decline: true }, mutation)).status, 409);
  assert.deepEqual((await inboxOf(relay.web)).taskItems, []);
  // The response resumes the parked execution: the same execution ID, never a second execution of the Task.
  const settled = await until(async () => {
    const row = (await tasksOf(relay.web)).find(entry => entry.id === task.id);
    return row?.status === 'done' && row;
  }, 'task settles after resume');
  assert.equal(settled.outcome, 'Fixture tool succeeded');
  const resumedExecution = ledger(task.id);
  assert.equal(resumedExecution.execution_id, firstExecution.execution_id, 'the same child execution resumed');
  assert.equal(resumedExecution.execution_kind, 'start');
  assert.equal(resumedExecution.dispatch_attempts, 0);
  assert.equal(paths.filter(path => path === `/v1/tasks/${task.id}/settle`).length, 1, 'the outcome was reported once');
  const detail = await (await request(relay.web, `/api/tasks/${task.id}`, auth)).json();
  assert.equal(detail.task.status, 'done');
  assert.deepEqual(detail.task.items.map(entry => [entry.status, entry.response]), [['answered', 'Tuesday']]);
  assert.ok(detail.task.items[0].deliveredAt, 'the response reached the parked call');
  assert.ok(Array.isArray(detail.transcript));
  assert.ok(detail.transcript.some(entry => entry.role === 'user' && entry.text.includes(childInput)));
  assert.equal(detail.transcript.at(-1).role, 'assistant');
  // The originating conversation gained a durable notice, not a user turn, and no answer text leaked into history.
  const historyAfter = await turnsOf(relay.web);
  assert.deepEqual(historyAfter.map(row => row.id), ['delegate-one']);
  assert.equal(JSON.stringify(historyAfter).includes('Tuesday'), false);
  const after = await (await request(relay.web, '/api/tasks/events', auth)).json();
  assert.ok(after.events.some(event => event.kind === 'response' && event.taskId === task.id));
  assert.ok(after.events.some(event => event.kind === 'outcome' && event.text.includes('finished')));

  // The next orchestrator turn is told about those events without polling; the one after that is not, because the
  // notice was delivered once. The fixture echoes the instructions it actually received.
  const probe = async id => {
    assert.equal((await request(relay.web, '/api/turns', auth, 'POST', { id, text: 'fixture:instructions' }, mutation)).status, 200);
    return until(async () => {
      const row = await (await request(relay.web, `/api/turns/${id}`, auth)).json();
      return row.status === 'done' && row.text;
    }, `instructions probe ${id}`);
  };
  const exposed = await probe('notice-probe');
  assert.ok(exposed.includes('Task notifications since your last turn'), exposed);
  assert.ok(exposed.includes('Lunch note'), exposed);
  assert.ok(exposed.includes('finished'), exposed);
  const quiet = await probe('notice-probe-two');
  assert.equal(quiet.includes('Task notifications since your last turn'), false, quiet);

  // 4. Progress is non-blocking, and a report-for-review is another typed pause.
  await createTask(relay.web, 'delegate-two', { title: 'Progress note', task: fixtureTool('report_progress', { note: 'Halfway through' }) });
  const progress = await until(async () => {
    const row = (await tasksOf(relay.web)).find(entry => entry.title === 'Progress note');
    return row?.status === 'done' && row;
  }, 'progress task settles');
  const progressDetail = await (await request(relay.web, `/api/tasks/${progress.id}`, auth)).json();
  assert.deepEqual(progressDetail.task.progress.map(note => note.note), ['Halfway through']);

  // 5. A future not-before keeps a Task scheduled: it is queued, not claimed, and never dispatched.
  const notBefore = new Date(Date.now() + 3_600_000).toISOString();
  await createTask(relay.web, 'delegate-three', { title: 'Later task', task: 'Nothing urgent.', notBefore });
  const scheduled = await until(async () => (await tasksOf(relay.web)).find(row => row.title === 'Later task'), 'scheduled task');
  assert.equal(scheduled.status, 'queued');
  assert.equal(scheduled.scheduled, true);
  assert.equal(scheduled.notBefore, notBefore);
  await sleep(500);
  assert.equal(ledger(scheduled.id).execution_id, null, 'a scheduled Task is never claimed early');

  // 6. Cancellation closes the open item, fences the execution, and refuses a late answer.
  await createTask(relay.web, 'delegate-four', { title: 'Cancelled task', task: fixtureTool('post_inbox', { kind: 'report', prompt: 'Please review.' }) });
  const cancellable = await until(async () => {
    const row = (await tasksOf(relay.web)).find(entry => entry.title === 'Cancelled task');
    return row?.status === 'waiting' && row;
  }, 'cancellable task waits');
  const cancelPath = `/api/tasks/${cancellable.id}/cancel`;
  assert.equal((await request(relay.web, cancelPath, auth, 'POST', {}, {})).status, 403);
  const cancelled = await request(relay.web, cancelPath, auth, 'POST', {}, mutation);
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');
  const cancelledItem = (await inboxOf(relay.web)).taskItems.find(entry => entry.taskId === cancellable.id);
  assert.equal(cancelledItem, undefined, 'cancellation closes the pending item');
  assert.deepEqual((await tasksOf(relay.web)).map(row => [row.title, row.status]).sort(), [
    ['Cancelled task', 'cancelled'], ['Later task', 'queued'], ['Lunch note', 'done'], ['Progress note', 'done'],
  ]);
  const cancelledDetail = await (await request(relay.web, `/api/tasks/${cancellable.id}`, auth)).json();
  assert.deepEqual(cancelledDetail.task.items.map(entry => entry.status), ['cancelled']);
  assert.equal((await request(relay.web, `/api/tasks/${cancellable.id}/inbox/${cancelledDetail.task.items[0].id}/respond`,
    auth, 'POST', { answer: 'Too late' }, mutation)).status, 409);
  assert.equal((await tasksOf(relay.web)).find(row => row.id === cancellable.id).status, 'cancelled');

  // 7. Owner isolation: another signed-in owner sees no tasks of this conversation.
  const otherConfig = join(root, 'relay-other.json');
  await relay.relay.end('SIGTERM');
  await writeFile(otherConfig, JSON.stringify({
    agents: { canary: { url: worker.url, tokenEnv: 'CANARY_TOKEN' } },
    owners: { other: { agent: 'canary', passwordEnv: 'OWNER_PASSWORD' } }, routes: [], inbox: [],
  }));
  const other = start(t, 'relay', {
    ...env, MANOLO_RELAY_CONFIG: otherConfig, MANOLO_DATA_DIR: relayData,
    MANOLO_WORK_SESSION_AGENT: 'canary', PORT: '0', MANOLO_INTERNAL_PORT: '0',
  });
  const otherWeb = addr(await other.port(/web listening on .*:(\d+)/));
  const otherAuth = basic('other', env.OWNER_PASSWORD);
  assert.deepEqual((await (await request(otherWeb, '/api/tasks', otherAuth)).json()).tasks, []);
  assert.equal((await request(otherWeb, `/api/tasks/${task.id}`, otherAuth)).status, 404);
  assert.equal((await request(otherWeb, '/api/tasks', auth)).status, 401);
});

test('a Task ledger refuses stale executions, keeps retries stable, and fences cancellation', async () => {
  const { openTaskStore } = await import('../src/task-store.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const store = openTaskStore(db);
  try {
    const scope = 'scope';
    const base = { owner: 'owner', agent: 'canary', scope, originTurnId: 'turn', title: 'Title', input: 'Do it', now: 1_000 };
    const task = store.create({ ...base, key: 'create-1' });
    assert.deepEqual(store.create({ ...base, title: 'Other', key: 'create-1' }), task, 'a replayed create returns the same Task');
    const second = store.create({ ...base, title: 'Second', key: 'create-2' });
    assert.notEqual(second.id, task.id);
    // Two Tasks with distinct keys, claimed one at a time in creation order.
    const claimed = store.claim(1_000);
    assert.equal(claimed.id, task.id);
    assert.equal(claimed.status, 'running');
    const claimedSecond = store.claim(1_000);
    assert.equal(claimedSecond.id, second.id);
    assert.equal(store.claim(1_000), undefined, 'no eligible Task is claimed twice');
    const executionId = claimed.execution_id;
    assert.throws(() => store.progress({ taskId: task.id, executionId: 'f'.repeat(32), note: 'stale', key: 'p-1' }), { statusCode: 409 });
    assert.deepEqual(store.progress({ taskId: task.id, executionId, note: 'working', key: 'p-2' }), { ok: true });
    assert.deepEqual(store.progress({ taskId: task.id, executionId, note: 'working', key: 'p-2' }), { ok: true }, 'a replayed progress note is a receipt');
    const parked = store.park({ taskId: task.id, executionId, kind: 'question', prompt: 'Which?', key: 'i-1' });
    assert.equal(parked.status, 'open');
    assert.throws(() => store.park({ taskId: task.id, executionId, kind: 'question', prompt: 'Again?', key: 'i-2' }), { statusCode: 409 });
    assert.equal(store.get(scope, task.id).status, 'waiting');
    assert.throws(() => store.progress({ taskId: task.id, executionId, note: 'after yield', key: 'p-3' }), { statusCode: 409 });
    // A response queues the same Task for the same execution and is idempotent.
    const receipt = store.respond(scope, parked.itemId, 'Answer');
    assert.deepEqual(receipt, { itemId: parked.itemId, taskId: task.id, status: 'answered', taskStatus: 'queued' });
    assert.deepEqual(store.respond(scope, parked.itemId, 'Answer'), receipt);
    assert.throws(() => store.respond(scope, parked.itemId, 'Different'), { statusCode: 409 });
    const resumed = store.claim(2_000);
    assert.equal(resumed.id, task.id);
    assert.equal(resumed.execution_id, executionId, 'a resume reuses the parked execution');
    assert.equal(resumed.execution_kind, 'resume');
    assert.equal(store.deliveryResult({ taskId: task.id, executionId, itemId: parked.itemId, delivered: true }), true);
    assert.equal(store.inboxItem(parked.itemId).delivered_at !== null, true);
    assert.deepEqual(store.settle({ taskId: task.id, executionId, outcome: 'done', summary: 'Done', key: 's-1' }), { status: 'done' });
    assert.deepEqual(store.settle({ taskId: task.id, executionId, outcome: 'done', summary: 'Done', key: 's-1' }), { status: 'done' });
    assert.equal(store.get(scope, task.id).status, 'done');
    assert.throws(() => store.settle({ taskId: task.id, executionId, outcome: 'failed', summary: 'Late', key: 's-2' }), { statusCode: 409 });
    // Cancellation fences the execution and closes an open item.
    store.park({ taskId: second.id, executionId: claimedSecond.execution_id, kind: 'report', prompt: 'Review', key: 'i-3' });
    const cancelled = store.cancel(scope, second.id);
    assert.equal(cancelled.task.status, 'cancelled');
    assert.equal(cancelled.executionId, claimedSecond.execution_id, 'a waiting task still names the execution to abort');
    assert.equal(store.get(scope, second.id).items[0].status, 'cancelled');
    assert.throws(() => store.respond(scope, store.get(scope, second.id).items[0].id, 'Late'), { statusCode: 409 });
    // A dispatch the worker never accepted is retried under the same execution identity, then fails closed.
    const retried = store.create({ ...base, title: 'Retry', key: 'create-4' });
    const claimedRetry = store.claim(4_000);
    assert.equal(claimedRetry.id, retried.id);
    assert.equal(store.retryDispatch(claimedRetry.id, claimedRetry.execution_id, 4_000, 'Worker unreachable.'), 'queued');
    assert.equal(store.claim(4_000 + 1_000), undefined, 'the backoff holds the Task back');
    const again = store.claim(4_000 + 2_000);
    assert.equal(again.id, retried.id);
    assert.equal(again.execution_id, claimedRetry.execution_id, 'a retry reuses the execution identity');
    assert.equal(store.failExecution(again.id, again.execution_id, 'Blueprint revision gone'), true);
    assert.equal(store.get(scope, again.id).status, 'failed');
    assert.equal(store.get(scope, again.id).failure, 'Blueprint revision gone');
    assert.equal(store.failExecution(again.id, again.execution_id, 'again'), false, 'a terminal Task is fenced');
    // Owner isolation: another scope cannot read or respond.
    assert.equal(store.get('other', task.id), undefined);
    assert.throws(() => store.respond('other', parked.itemId, 'Answer'), { statusCode: 404 });
    assert.throws(() => store.cancel('other', task.id), { statusCode: 404 });
  } finally {
    db.close();
  }
});

test('a response whose parked execution is gone restarts the same Task with the answer in its input', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const dataDir = join(root, 'relay');
  const dispatches = [];
  let relayInternal = 'http://127.0.0.1:1';
  const relayCall = async (path, body, key) => {
    const response = await fetch(`${relayInternal}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key && { 'idempotency-key': key }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return [response.status, await response.json()];
  };
  // A worker stand-in: it admits the first execution, parks, then reports that the parked call is gone on resume.
  const stub = createServer(async (req, res) => {
    const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v1/turns/')) {
      for await (const chunk of req) void chunk;
      return json({ status: 'done', text: 'ok' });
    }
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions$/.exec(req.url);
    const resume = /^\/v1\/tasks\/([0-9a-f]{32})\/resume$/.exec(req.url);
    if (dispatch) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      dispatches.push(parsed);
      if (dispatches.length === 1) {
        // Park once, then leave the parked call unanswerable.
        const [parkStatus] = await relayCall(`/v1/tasks/${dispatch[1]}/inbox`,
          { executionId: parsed.executionId, kind: 'question', prompt: 'Which date?' }, 'park-1');
        assert.equal(parkStatus, 200);
      } else {
        const [settleStatus, settled] = await relayCall(`/v1/tasks/${dispatch[1]}/settle`,
          { executionId: parsed.executionId, outcome: 'done', summary: 'Restarted with the answer.' }, 'settle-1');
        assert.equal(settleStatus, 200);
        assert.equal(settled.status, 'done');
      }
      return json({ status: 'running' });
    }
    if (resume) {
      for await (const chunk of req) void chunk;
      return json({ delivered: false, reason: 'no_parked_call' });
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(stub, 'listening');
  t.after(() => stub.close());
  const config = join(root, 'relay.json');
  await writeFile(config, JSON.stringify({
    agents: { canary: { url: addr(stub.address().port), tokenEnv: 'CANARY_TOKEN' } },
    owners: { owner: { agent: 'canary', passwordEnv: 'OWNER_PASSWORD' } }, routes: [], inbox: [],
  }));
  const relay = start(t, 'relay', {
    CANARY_TOKEN: token, OWNER_PASSWORD: password, MANOLO_RELAY_CONFIG: config, MANOLO_DATA_DIR: dataDir,
    MANOLO_WORK_SESSION_AGENT: 'canary', PORT: '0', MANOLO_INTERNAL_PORT: '0',
  });
  relayInternal = addr(await relay.port(/internal listening on .*:(\d+)/));
  const web = addr(await relay.port(/web listening on .*:(\d+)/));
  const auth = basic('owner', password);
  assert.equal((await request(web, '/api/turns', auth, 'POST', { id: 'origin', text: 'Start' }, mutation)).status, 200);
  const workerTurn = key('web', 'owner', 'canary', 'origin');
  const created = await request(relayInternal, '/v1/tasks', { authorization: `Bearer ${token}` }, 'POST',
    { turnId: workerTurn, title: 'Fallback task', task: 'Do the work.' }, { 'idempotency-key': 'create-fallback' });
  assert.equal(created.status, 200, await created.clone().text());
  const tasksOf = async () => (await (await request(web, '/api/tasks', auth)).json()).tasks;
  const waiting = await until(async () => (await tasksOf()).find(row => row.status === 'waiting'), 'stub parks the task');
  const item = (await (await request(web, '/api/inbox', auth)).json()).taskItems[0];
  assert.equal(item.taskId, waiting.id);
  const responded = await request(web, `/api/tasks/${waiting.id}/inbox/${item.id}/respond`, auth, 'POST', { answer: 'Tuesday' }, mutation);
  assert.equal(responded.status, 200);
  const done = await until(async () => (await tasksOf()).find(row => row.status === 'done'), 'task settles after restart');
  assert.equal(done.outcome, 'Restarted with the answer.');
  assert.equal(dispatches.length, 2, 'a fresh execution was dispatched');
  assert.notEqual(dispatches[1].executionId, dispatches[0].executionId);
  assert.match(dispatches[1].task.context, /Tuesday/, 'the answer travels in the child input');
  const detail = await (await request(web, `/api/tasks/${waiting.id}`, auth)).json();
  assert.deepEqual(detail.task.items.map(entry => [entry.status, entry.response, entry.deliveredAt ?? null]), [['answered', 'Tuesday', null]]);
  const turns = (await (await request(web, '/api/turns', auth)).json()).turns;
  assert.deepEqual(turns.map(row => row.id), ['origin'], 'no chat turn was inserted for the response');
});
