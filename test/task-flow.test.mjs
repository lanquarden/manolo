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
  let gateNextPark;
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
      const body = await response.text();
      if (gateNextPark && req.url.endsWith('/inbox') && response.ok) {
        const gate = gateNextPark;
        gateNextPark = undefined;
        await gate;
      }
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(body);
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
    const payload = await response.json();
    return [...payload.active, ...payload.history];
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
  // A dispatch that races the stop is refused by the worker's cancelled-execution tombstone.
  const late = await request(worker.url, `/v1/tasks/${cancellable.id}/executions`, { authorization: `Bearer ${env.CANARY_TOKEN}` }, 'POST',
    { executionId: 'f'.repeat(32), task: { title: 'Late dispatch', input: 'Should not run.' } });
  const lateBody = await late.json();
  assert.equal(late.status, 409, JSON.stringify(lateBody));
  assert.equal(lateBody.reason, 'task_cancelled');
  assert.equal((await request(relay.web, `/api/tasks/${cancellable.id}/inbox/${cancelledDetail.task.items[0].id}/respond`,
    auth, 'POST', { answer: 'Too late' }, mutation)).status, 409);
  assert.equal((await tasksOf(relay.web)).find(row => row.id === cancellable.id).status, 'cancelled');

  // The relay exposes the item before the worker receives its park receipt. Answer during that window.
  let allowPark;
  gateNextPark = new Promise(resolve => { allowPark = resolve; });
  try {
    await createTask(relay.web, 'delegate-early', { title: 'Early answer', task: childInput });
    const earlyItem = await until(async () => (await inboxOf(relay.web)).taskItems.find(entry => entry.taskTitle === 'Early answer'), 'visible Inbox item before worker park');
    const earlyExecution = ledger(earlyItem.taskId).execution_id;
    assert.equal((await request(relay.web, `/api/tasks/${earlyItem.taskId}/inbox/${earlyItem.id}/respond`,
      auth, 'POST', { answer: 'Friday' }, mutation)).status, 200);
    await until(() => ledger(earlyItem.taskId).dispatch_attempts > 0, 'early answer is retried while park receipt is held');
    assert.equal(ledger(earlyItem.taskId).status, 'running');
    allowPark();
    await until(() => ledger(earlyItem.taskId).status === 'done', 'same execution consumes early answer');
    assert.equal(ledger(earlyItem.taskId).execution_id, earlyExecution);
    const detail = await (await request(relay.web, `/api/tasks/${earlyItem.taskId}`, auth)).json();
    assert.ok(detail.task.items[0].deliveredAt);
  } finally {
    allowPark();
  }

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
  assert.deepEqual((await (await request(otherWeb, '/api/tasks', otherAuth)).json()),
    { active: [], history: [], blueprints: [] });
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
    assert.equal(store.resumeDelivered({ taskId: task.id, executionId, itemId: parked.itemId }), true);
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
    // An unacknowledged dispatch keeps the Task running under the same execution identity, stays durably pending and is
    // re-driven after the backoff. It is never re-claimed or replaced.
    const retried = store.create({ ...base, title: 'Retry', key: 'create-4' });
    const claimedRetry = store.claim(4_000);
    assert.equal(claimedRetry.id, retried.id);
    assert.equal(claimedRetry.dispatch_pending, 1, 'the claim records a durable pending dispatch');
    assert.equal(store.retryDispatch(claimedRetry.id, claimedRetry.execution_id, 4_000, 'Worker unreachable.'), 'pending');
    assert.equal(store.meta(claimedRetry.id).status, 'running');
    assert.deepEqual(store.dueDispatch(4_000 + 1_000), [], 'the backoff holds the retry back');
    const due = store.dueDispatch(4_000 + 2_000);
    assert.deepEqual(due.map(row => row.id), [retried.id]);
    assert.equal(due[0].execution_id, claimedRetry.execution_id, 'a retry reuses the execution identity');
    assert.equal(store.claim(4_000 + 2_000), undefined, 'a pending dispatch is never claimed again');
    // A write from that same current execution is accepted while the acknowledgement is still owed.
    assert.deepEqual(store.progress({ taskId: retried.id, executionId: claimedRetry.execution_id, note: 'still working', key: 'p-9' }), { ok: true });
    assert.equal(store.ackDispatch(retried.id, claimedRetry.execution_id), true);
    assert.deepEqual(store.dueDispatch(4_000 + 2_000), [], 'an acknowledged dispatch is not re-driven');
    assert.equal(store.failExecution(retried.id, claimedRetry.execution_id, 'Blueprint revision gone'), true);
    assert.equal(store.get(scope, retried.id).status, 'failed');
    assert.equal(store.get(scope, retried.id).failure, 'Blueprint revision gone');
    assert.equal(store.failExecution(retried.id, claimedRetry.execution_id, 'again'), false, 'a terminal Task is fenced');
    // Owner isolation: another scope cannot read or respond.
    assert.equal(store.get('other', task.id), undefined);
    assert.throws(() => store.respond('other', parked.itemId, 'Answer'), { statusCode: 404 });
    assert.throws(() => store.cancel('other', task.id), { statusCode: 404 });
  } finally {
    db.close();
  }
});

async function launchTaskRelay(t, { root, dataDir, stubUrl, token, password, name = 'relay' }) {
  const config = join(root, `${name}.json`);
  await writeFile(config, JSON.stringify({
    agents: { canary: { url: stubUrl, tokenEnv: 'CANARY_TOKEN' } },
    owners: { owner: { agent: 'canary', passwordEnv: 'OWNER_PASSWORD' } }, routes: [], inbox: [],
  }));
  const relay = start(t, 'relay', {
    CANARY_TOKEN: token, OWNER_PASSWORD: password, MANOLO_RELAY_CONFIG: config, MANOLO_DATA_DIR: dataDir,
    MANOLO_WORK_SESSION_AGENT: 'canary', PORT: '0', MANOLO_INTERNAL_PORT: '0',
  });
  const internal = addr(await relay.port(/internal listening on .*:(\d+)/));
  const web = addr(await relay.port(/web listening on .*:(\d+)/));
  return { relay, internal, web };
}

async function createTaskForTest(web, internal, token, auth, { id = 'origin', title, task = 'Do the work.' } = {}) {
  assert.equal((await request(web, '/api/turns', auth, 'POST', { id, text: 'Start' }, mutation)).status, 200);
  const turnId = key('web', 'owner', 'canary', id);
  const created = await request(internal, '/v1/tasks', { authorization: `Bearer ${token}` }, 'POST',
    { turnId, title, task }, { 'idempotency-key': `create-${id}` });
  assert.equal(created.status, 200, await created.clone().text());
  return created.json();
}

async function taskList(web, auth) {
  const response = await request(web, '/api/tasks', auth);
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  return [...payload.active, ...payload.history];
}

test('a definitively lost execution fails the Task, keeps the answer, and never starts a replacement child', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-lost-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const calls = { dispatch: [], resume: [], cancel: [] };
  let relayInternal = 'http://127.0.0.1:1';
  const relayCall = async (path, body, idem) => {
    const response = await fetch(`${relayInternal}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idem && { 'idempotency-key': idem }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return [response.status, await response.json().catch(() => ({}))];
  };
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions$/.exec(req.url);
    if (dispatch) {
      const body = await read();
      calls.dispatch.push({ taskId: dispatch[1], ...body });
      const [parkStatus] = await relayCall(`/v1/tasks/${dispatch[1]}/inbox`,
        { executionId: body.executionId, kind: 'question', prompt: 'Which date?' }, 'park-1');
      assert.equal(parkStatus, 200);
      return json({ status: 'running' });
    }
    const resume = /^\/v1\/tasks\/([0-9a-f]{32})\/resume$/.exec(req.url);
    if (resume) {
      await read();
      calls.resume.push(resume[1]);
      return json({ delivered: false, reason: 'no_parked_call' });
    }
    const cancel = /^\/v1\/tasks\/([0-9a-f]{32})\/cancel$/.exec(req.url);
    if (cancel) { await read(); calls.cancel.push(cancel[1]); return json({ ok: true }); }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relay = await launchTaskRelay(t, { root, dataDir: join(root, 'relay'), stubUrl: addr(server.address().port), token, password });
  relayInternal = relay.internal;
  const auth = basic('owner', password);
  await createTaskForTest(relay.web, relay.internal, token, auth, { title: 'Lost execution' });
  const waiting = await until(async () => (await taskList(relay.web, auth)).find(row => row.status === 'waiting'), 'stub parks');
  const item = (await (await request(relay.web, '/api/inbox', auth)).json()).taskItems[0];
  assert.equal(item.taskId, waiting.id);
  const responded = await request(relay.web, `/api/tasks/${waiting.id}/inbox/${item.id}/respond`, auth, 'POST', { answer: 'Tuesday' }, mutation);
  assert.equal(responded.status, 200);
  const failed = await until(async () => (await taskList(relay.web, auth)).find(row => row.status === 'failed'), 'task fails clearly');
  assert.match(failed.failure, /no longer available/);
  assert.equal(calls.dispatch.length, 1, 'no replacement child was dispatched');
  const detail = await (await request(relay.web, `/api/tasks/${waiting.id}`, auth)).json();
  assert.deepEqual(detail.task.items.map(entry => [entry.status, entry.response]), [['answered', 'Tuesday']]);
  assert.equal(detail.task.activeItem.status, 'answered');
  const events = (await (await request(relay.web, '/api/tasks/events', auth)).json()).events;
  assert.ok(events.some(event => event.kind === 'outcome' && /response is saved/i.test(event.text)), JSON.stringify(events));
  const turns = (await (await request(relay.web, '/api/turns', auth)).json()).turns;
  assert.deepEqual(turns.map(row => row.id), ['origin'], 'no chat turn was inserted for the response');
});

test('a lost dispatch acknowledgement retries the same execution and accepts a finish that lands meanwhile', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-ack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const calls = { dispatch: [], resume: [], cancel: [], settle: [] };
  const relayInternal = { url: 'http://127.0.0.1:1' };
  const relayCall = async (path, body, idem) => {
    const response = await fetch(`${relayInternal.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idem && { 'idempotency-key': idem }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return [response.status, await response.json().catch(() => ({}))];
  };
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions$/.exec(req.url);
    if (dispatch) {
      const body = await read();
      calls.dispatch.push({ taskId: dispatch[1], ...body });
      if (calls.dispatch.length === 1) {
        // The child finishes immediately, then the relay's read of the acknowledgement fails.
        const [status, settled] = await relayCall(`/v1/tasks/${dispatch[1]}/settle`,
          { executionId: body.executionId, outcome: 'done', summary: 'Finished once.' }, 'settle-ack-1');
        calls.settle.push({ status, settled });
        res.writeHead(502).end();
        return;
      }
      return json({ status: 'running' });
    }
    const cancel = /^\/v1\/tasks\/([0-9a-f]{32})\/cancel$/.exec(req.url);
    if (cancel) { await read(); calls.cancel.push(cancel[1]); return json({ ok: true }); }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relay = await launchTaskRelay(t, { root, dataDir: join(root, 'relay'), stubUrl: addr(server.address().port), token, password });
  relayInternal.url = relay.internal;
  const auth = basic('owner', password);
  await createTaskForTest(relay.web, relay.internal, token, auth, { title: 'Ack lost' });
  const done = await until(async () => (await taskList(relay.web, auth)).find(row => row.status === 'done'), 'task settles from the pending dispatch');
  assert.equal(done.outcome, 'Finished once.');
  // The settle was accepted even though the dispatch acknowledgement was still owed, and no second execution started.
  assert.deepEqual(calls.settle.map(entry => entry.status), [200]);
  assert.equal(calls.settle[0].settled.status, 'done');
  assert.equal(new Set(calls.dispatch.map(entry => entry.executionId)).size, 1, 'one execution identity throughout');
  assert.equal(calls.dispatch.length, 1, 'the terminal Task is never re-dispatched');
  const turns = (await (await request(relay.web, '/api/turns', auth)).json()).turns;
  assert.deepEqual(turns.map(row => row.id), ['origin']);
});

test('a lost resume acknowledgement is retried under the same IDs and is never replaced by a new child', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-resume-ack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const calls = { dispatch: [], resume: [], cancel: [], settle: [] };
  const relayInternal = { url: 'http://127.0.0.1:1' };
  const relayCall = async (path, body, idem) => {
    const response = await fetch(`${relayInternal.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idem && { 'idempotency-key': idem }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return [response.status, await response.json().catch(() => ({}))];
  };
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions$/.exec(req.url);
    if (dispatch) {
      const body = await read();
      calls.dispatch.push({ taskId: dispatch[1], ...body });
      const [parkStatus] = await relayCall(`/v1/tasks/${dispatch[1]}/inbox`,
        { executionId: body.executionId, kind: 'question', prompt: 'Which date?' }, 'park-1');
      assert.equal(parkStatus, 200);
      return json({ status: 'running' });
    }
    const resume = /^\/v1\/tasks\/([0-9a-f]{32})\/resume$/.exec(req.url);
    if (resume) {
      const body = await read();
      calls.resume.push(body);
      if (calls.resume.length === 1) {
        // The child consumes the response and finishes, then the acknowledgement is lost.
        const [status] = await relayCall(`/v1/tasks/${dispatch1TaskId()}/settle`,
          { executionId: body.executionId, outcome: 'done', summary: 'Resumed once.' }, 'settle-resume-1');
        calls.settle.push(status);
        res.writeHead(502).end();
        return;
      }
      return json({ delivered: true, replay: true });
    }
    const cancel = /^\/v1\/tasks\/([0-9a-f]{32})\/cancel$/.exec(req.url);
    if (cancel) { await read(); calls.cancel.push(cancel[1]); return json({ ok: true }); }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const dispatch1TaskId = () => calls.dispatch[0].taskId;
  const relay = await launchTaskRelay(t, { root, dataDir: join(root, 'relay'), stubUrl: addr(server.address().port), token, password });
  relayInternal.url = relay.internal;
  const auth = basic('owner', password);
  await createTaskForTest(relay.web, relay.internal, token, auth, { title: 'Resume ack lost' });
  const waiting = await until(async () => (await taskList(relay.web, auth)).find(row => row.status === 'waiting'), 'stub parks');
  const item = (await (await request(relay.web, '/api/inbox', auth)).json()).taskItems[0];
  assert.equal((await request(relay.web, `/api/tasks/${waiting.id}/inbox/${item.id}/respond`, auth, 'POST', { answer: 'Tuesday' }, mutation)).status, 200);
  const done = await until(async () => (await taskList(relay.web, auth)).find(row => row.status === 'done'), 'task settles after the lost resume ack');
  assert.equal(done.outcome, 'Resumed once.');
  assert.deepEqual(calls.settle, [200], 'the finish that landed during the pending resume was accepted');
  assert.equal(calls.dispatch.length, 1, 'no replacement child was dispatched');
  assert.equal(new Set(calls.resume.map(entry => entry.executionId)).size, 1);
  const detail = await (await request(relay.web, `/api/tasks/${waiting.id}`, auth)).json();
  // The settle arrived with no receipt for the item, so a delivery is not claimed: the answer is saved and the outcome
  // is final, but the ledger does not pretend the response reached a park it never saw acknowledged.
  assert.equal(detail.task.items[0].deliveredAt, undefined, 'a settle without a receipt never fabricates a delivery');
  assert.deepEqual(detail.task.items.map(entry => [entry.status, entry.response]), [['answered', 'Tuesday']]);
});

test('a settle that carries the worker receipt records the delivery when the resume acknowledgement was lost', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-resume-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const calls = { dispatch: [], resume: [], cancel: [], settle: [] };
  const relayInternal = { url: 'http://127.0.0.1:1' };
  const relayCall = async (path, body, idem) => {
    const response = await fetch(`${relayInternal.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idem && { 'idempotency-key': idem }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return [response.status, await response.json().catch(() => ({}))];
  };
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions$/.exec(req.url);
    if (dispatch) {
      const body = await read();
      calls.dispatch.push({ taskId: dispatch[1], ...body });
      const [parkStatus] = await relayCall(`/v1/tasks/${dispatch[1]}/inbox`,
        { executionId: body.executionId, kind: 'question', prompt: 'Which date?' }, 'park-1');
      assert.equal(parkStatus, 200);
      return json({ status: 'running' });
    }
    const resume = /^\/v1\/tasks\/([0-9a-f]{32})\/resume$/.exec(req.url);
    if (resume) {
      const body = await read();
      calls.resume.push(body);
      if (calls.resume.length === 1) {
        // The child consumed the response and finished before the relay read the acknowledgement. The settle carries the
        // worker's own receipt for the item, which is the positive evidence a delivery needs.
        const [status] = await relayCall(`/v1/tasks/${resume[1]}/settle`,
          { executionId: body.executionId, outcome: 'done', summary: 'Resumed once.', deliveredItems: [body.itemId] }, 'settle-receipt-1');
        calls.settle.push(status);
        res.writeHead(502).end();
        return;
      }
      return json({ delivered: true, replay: true });
    }
    const cancel = /^\/v1\/tasks\/([0-9a-f]{32})\/cancel$/.exec(req.url);
    if (cancel) { await read(); calls.cancel.push(cancel[1]); return json({ ok: true }); }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relay = await launchTaskRelay(t, { root, dataDir: join(root, 'relay'), stubUrl: addr(server.address().port), token, password });
  relayInternal.url = relay.internal;
  const auth = basic('owner', password);
  await createTaskForTest(relay.web, relay.internal, token, auth, { title: 'Resume receipt' });
  const waiting = await until(async () => (await taskList(relay.web, auth)).find(row => row.status === 'waiting'), 'stub parks');
  const item = (await (await request(relay.web, '/api/inbox', auth)).json()).taskItems[0];
  assert.equal((await request(relay.web, `/api/tasks/${waiting.id}/inbox/${item.id}/respond`, auth, 'POST', { answer: 'Tuesday' }, mutation)).status, 200);
  const done = await until(async () => (await taskList(relay.web, auth)).find(row => row.status === 'done'), 'task settles after the lost resume ack');
  assert.equal(done.outcome, 'Resumed once.');
  assert.deepEqual(calls.settle, [200]);
  assert.equal(calls.dispatch.length, 1, 'no replacement child was dispatched');
  const detail = await (await request(relay.web, `/api/tasks/${waiting.id}`, auth)).json();
  assert.ok(detail.task.items[0].deliveredAt, 'the worker receipt records the delivery even without the resume acknowledgement');
});

test('an ambiguous resume acknowledgement is retried with the same IDs and answered from the receipt', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-resume-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const calls = { dispatch: [], resume: [], cancel: [] };
  let relayInternal = 'http://127.0.0.1:1';
  const relayCall = async (path, body, idem) => {
    const response = await fetch(`${relayInternal}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idem && { 'idempotency-key': idem }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return [response.status, await response.json().catch(() => ({}))];
  };
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions$/.exec(req.url);
    if (dispatch) {
      const body = await read();
      calls.dispatch.push({ taskId: dispatch[1], ...body });
      const [parkStatus] = await relayCall(`/v1/tasks/${dispatch[1]}/inbox`,
        { executionId: body.executionId, kind: 'question', prompt: 'Which date?' }, 'park-1');
      assert.equal(parkStatus, 200);
      return json({ status: 'running' });
    }
    const resume = /^\/v1\/tasks\/([0-9a-f]{32})\/resume$/.exec(req.url);
    if (resume) {
      const body = await read();
      calls.resume.push({ taskId: resume[1], ...body });
      if (calls.resume.length === 1) {
        // The acknowledgement is ambiguous: the relay must retry, not replace the execution.
        res.writeHead(503).end();
        return;
      }
      assert.equal(body.executionId, calls.resume[0].executionId);
      assert.equal(body.itemId, calls.resume[0].itemId);
      // Answered from the worker's durable receipt: the child already consumed this item.
      const [status] = await relayCall(`/v1/tasks/${resume[1]}/settle`,
        { executionId: body.executionId, outcome: 'done', summary: 'Delivered once.' }, 'settle-resume-retry');
      assert.equal(status, 200);
      return json({ delivered: true, replay: true });
    }
    const cancel = /^\/v1\/tasks\/([0-9a-f]{32})\/cancel$/.exec(req.url);
    if (cancel) { await read(); calls.cancel.push(cancel[1]); return json({ ok: true }); }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relay = await launchTaskRelay(t, { root, dataDir: join(root, 'relay'), stubUrl: addr(server.address().port), token, password });
  relayInternal = relay.internal;
  const auth = basic('owner', password);
  await createTaskForTest(relay.web, relay.internal, token, auth, { title: 'Resume retry' });
  const waiting = await until(async () => (await taskList(relay.web, auth)).find(row => row.status === 'waiting'), 'stub parks');
  const item = (await (await request(relay.web, '/api/inbox', auth)).json()).taskItems[0];
  assert.equal((await request(relay.web, `/api/tasks/${waiting.id}/inbox/${item.id}/respond`, auth, 'POST', { answer: 'Tuesday' }, mutation)).status, 200);
  const done = await until(async () => (await taskList(relay.web, auth)).find(row => row.status === 'done'), 'task settles after the retried resume');
  assert.equal(done.outcome, 'Delivered once.');
  assert.equal(calls.dispatch.length, 1, 'no replacement child was dispatched');
  assert.equal(calls.resume.length, 2, 'the ambiguous resume was retried once');
  assert.equal(new Set(calls.resume.map(entry => `${entry.executionId}:${entry.itemId}`)).size, 1, 'the retry reuses both IDs');
  const detail = await (await request(relay.web, `/api/tasks/${waiting.id}`, auth)).json();
  assert.ok(detail.task.items[0].deliveredAt, 'the receipt confirms the delivery');
});

test('a relay restart between claim and dispatch re-drives the same execution identity', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const dataDir = join(root, 'relay');
  const calls = { dispatch: [], resume: [], cancel: [] };
  let relayInternal = 'http://127.0.0.1:1';
  // The restarted relay re-drives the pending dispatch at once; the stub waits until the test points it at that relay.
  let relayReady;
  const ready = new Promise(resolve => { relayReady = resolve; });
  const relayCall = async (path, body, idem) => {
    const response = await fetch(`${relayInternal}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idem && { 'idempotency-key': idem }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return [response.status, await response.json().catch(() => ({}))];
  };
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions$/.exec(req.url);
    if (dispatch) {
      const body = await read();
      calls.dispatch.push({ taskId: dispatch[1], ...body });
      if (calls.dispatch.length === 1) {
        // Hold the request open: the relay is killed with the dispatch in flight, before any acknowledgement.
        res.on('close', () => {});
        return;
      }
      await ready;
      const [status] = await relayCall(`/v1/tasks/${dispatch[1]}/settle`,
        { executionId: body.executionId, outcome: 'done', summary: 'After restart.' }, 'settle-restart-1');
      assert.equal(status, 200);
      return json({ status: 'running' });
    }
    const cancel = /^\/v1\/tasks\/([0-9a-f]{32})\/cancel$/.exec(req.url);
    if (cancel) { await read(); calls.cancel.push(cancel[1]); return json({ ok: true }); }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const first = await launchTaskRelay(t, { root, dataDir, stubUrl: addr(server.address().port), token, password, name: 'relay-first' });
  relayInternal = first.internal;
  const auth = basic('owner', password);
  const task = await createTaskForTest(first.web, first.internal, token, auth, { title: 'Restart window' });
  await until(() => calls.dispatch.length === 1, 'the dispatch is in flight');
  // The claim is committed and the RPC is owed; kill the relay before it can be acknowledged.
  await first.relay.end('SIGKILL');
  const second = await launchTaskRelay(t, { root, dataDir, stubUrl: addr(server.address().port), token, password, name: 'relay-second' });
  relayInternal = second.internal;
  relayReady();
  const done = await until(async () => (await taskList(second.web, auth)).find(row => row.id === task.id && row.status === 'done'), 'restarted relay re-drives the pending dispatch');
  assert.equal(done.outcome, 'After restart.');
  assert.equal(calls.dispatch.length, 2, 'exactly one retry');
  assert.equal(calls.dispatch[1].executionId, calls.dispatch[0].executionId, 'the retry reuses the execution identity');
});

test('cancelling a Task retries the worker stop, reports it as unconfirmed, and never re-dispatches', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const calls = { dispatch: [], resume: [], cancel: [] };
  let relayInternal = 'http://127.0.0.1:1';
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions$/.exec(req.url);
    if (dispatch) {
      const body = await read();
      calls.dispatch.push(body);
      // The first dispatch is not acknowledged: the Task stays pending while the owner cancels it.
      res.writeHead(502).end();
      return;
    }
    const cancel = /^\/v1\/tasks\/([0-9a-f]{32})\/cancel$/.exec(req.url);
    if (cancel) {
      await read();
      calls.cancel.push(cancel[1]);
      // The worker is unreachable at first, then confirms the stop.
      if (calls.cancel.length === 1) { res.writeHead(503).end(); return; }
      return json({ ok: true });
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relay = await launchTaskRelay(t, { root, dataDir: join(root, 'relay'), stubUrl: addr(server.address().port), token, password });
  relayInternal = relay.internal;
  const auth = basic('owner', password);
  const task = await createTaskForTest(relay.web, relay.internal, token, auth, { title: 'Cancel pending' });
  await until(() => calls.dispatch.length === 1, 'the first dispatch is sent');
  const cancelled = await request(relay.web, `/api/tasks/${task.id}/cancel`, auth, 'POST', {}, mutation);
  assert.equal(cancelled.status, 200);
  const ledgerCancelled = await cancelled.json();
  assert.equal(ledgerCancelled.status, 'cancelled');
  assert.equal(ledgerCancelled.stopPending, true, 'the ledger cancellation is distinct from a confirmed stop');
  const confirmed = await until(async () => {
    const row = (await taskList(relay.web, auth)).find(entry => entry.id === task.id);
    return row && row.stopPending === false && row;
  }, 'the stop is confirmed after retries');
  assert.ok(confirmed.stopConfirmedAt);
  assert.equal(calls.cancel.length, 2, 'the stop was retried');
  assert.equal(calls.dispatch.length, 1, 'the pending dispatch was not retried after cancellation');
  const detail = await (await request(relay.web, `/api/tasks/${task.id}`, auth)).json();
  assert.equal(detail.task.status, 'cancelled');
  assert.equal(detail.task.stopPending, false);
});

test('the detail names the newest open item, and History pages and filters without crowding out active work', async () => {
  const { openTaskStore } = await import('../src/task-store.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const store = openTaskStore(db);
  try {
    const scope = 'scope';
    const base = { owner: 'owner', agent: 'canary', scope, originTurnId: 'turn', title: 'Title', input: 'Do it' };
    let clock = 1_000;
    const task = store.create({ ...base, key: 'create-multi' });
    const claimed = store.claim(clock);
    assert.equal(claimed.id, task.id);
    const executionId = claimed.execution_id;
    const first = store.park({ taskId: task.id, executionId, kind: 'question', prompt: 'First?', key: 'i-1', now: clock });
    store.respond(scope, first.itemId, 'One', clock);
    clock += 1_000;
    assert.equal(store.claim(clock).execution_kind, 'resume');
    store.resumeDelivered({ taskId: task.id, executionId, itemId: first.itemId, now: clock });
    const second = store.park({ taskId: task.id, executionId, kind: 'report', prompt: 'Second?', key: 'i-2', now: clock + 1_000 });
    const detail = store.get(scope, task.id, clock + 2_000);
    assert.deepEqual(detail.items.map(item => item.id), [second.itemId, first.itemId], 'items are newest first');
    assert.equal(detail.activeItem.id, second.itemId, 'the newest open item is the active one');
    store.respond(scope, second.itemId, 'Two', clock + 3_000);
    const answered = store.get(scope, task.id, clock + 4_000);
    assert.equal(answered.activeItem.id, second.itemId, 'the newest item stays the active one once answered');
    assert.deepEqual(answered.items.map(item => [item.id, item.status]), [[second.itemId, 'answered'], [first.itemId, 'answered']]);
    // Finish the paused Task so the terminal-traffic part below starts from a clean queue.
    const resumedAgain = store.claim(clock + 5_000);
    assert.equal(resumedAgain.id, task.id);
    store.settle({ taskId: task.id, executionId, outcome: 'done', summary: 'Multi done', key: 'settle-multi' });

    // Terminal traffic: 30 finished Tasks, one active Task, and a filtered History.
    for (let index = 0; index < 30; index++) {
      const done = store.create({
        ...base, title: `Done ${index}`, input: 'Finished work.', key: `create-done-${index}`,
        blueprint: index % 2 === 0 ? { id: 'review', revision: 'a'.repeat(64) } : undefined,
      });
      const claim = store.claim(clock + 10_000 + index);
      assert.equal(claim.id, done.id);
      store.settle({ taskId: done.id, executionId: claim.execution_id, outcome: 'done', summary: `Outcome ${index}`, key: `settle-${index}` });
    }
    const activeTask = store.create({ ...base, title: 'Still active', input: 'Running work.', key: 'create-active' });
    assert.deepEqual(store.active(scope).map(row => row.id), [activeTask.id], 'active work is independent of terminal rows');
    // 31 terminal Tasks in total: the paused one above and the 30 below.
    const firstPage = store.history(scope, { limit: 25 });
    assert.equal(firstPage.tasks.length, 25);
    assert.ok(firstPage.nextCursor);
    const secondPage = store.history(scope, { limit: 25, cursor: firstPage.nextCursor });
    assert.equal(secondPage.tasks.length, 6);
    assert.equal(secondPage.nextCursor, undefined);
    const seen = new Set([...firstPage.tasks, ...secondPage.tasks].map(row => row.id));
    assert.equal(seen.size, 31, 'paging visits every terminal Task once');
    assert.deepEqual(store.history(scope, { status: 'failed' }).tasks, []);
    assert.deepEqual(store.history(scope, { status: 'done', blueprint: 'review' }).tasks.map(row => row.title),
      ['Done 28', 'Done 26', 'Done 24', 'Done 22', 'Done 20', 'Done 18', 'Done 16', 'Done 14', 'Done 12', 'Done 10',
        'Done 8', 'Done 6', 'Done 4', 'Done 2', 'Done 0']);
    assert.deepEqual(store.history(scope, { status: 'done', text: 'Done 3' }).tasks.map(row => row.title),
      ['Done 3']);
    assert.deepEqual(store.blueprints(scope), ['review']);
    // The Orchestrator read keeps its own shape.
    assert.equal(store.list(scope, { status: 'active' }).length, 1);
  } finally {
    db.close();
  }
});
