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
import { loadWorkBlueprints, sealBlueprintSnapshot } from '../src/work-blueprints.mjs';
import { openTaskStore } from '../src/task-store.mjs';

const cwd = new URL('../', import.meta.url);
const secret = () => randomBytes(24).toString('hex');
const addr = port => `http://127.0.0.1:${port}`;
const basic = (user, pw) => ({ authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}` });
const mutation = { 'x-manolo-request': '1' };
const fixtureTool = (name, args) => `fixture-tool:${JSON.stringify({ name, args })}`;
// A modern worker records an explicit finish before its settle. The relay refuses a success that skipped it.
const finishAndSettle = async (relayCall, taskId, body, key) => {
  const [finishStatus] = await relayCall(`/v1/tasks/${taskId}/finish`,
    { executionId: body.executionId, summary: body.summary }, `finish-${taskId}-${body.executionId}`);
  if (finishStatus !== 200) return [finishStatus, {}];
  return relayCall(`/v1/tasks/${taskId}/settle`, body, key);
};
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
  const late = await request(worker.url, `/v1/tasks/${cancellable.id}/executions/v2`, { authorization: `Bearer ${env.CANARY_TOKEN}` }, 'POST',
    { executionId: 'f'.repeat(32), task: { protocol: 2, finishRequired: true, title: 'Late dispatch', input: 'Should not run.' } });
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
    assert.throws(() => store.settle({ taskId: task.id, executionId, outcome: 'done', summary: 'Bare prose', key: 's-0' }), { statusCode: 409 });
    assert.deepEqual(store.acceptFinish({ taskId: task.id, executionId, summary: 'Done', key: 'f-1' }), { accepted: true });
    assert.deepEqual(store.acceptFinish({ taskId: task.id, executionId, summary: 'Done', key: 'f-1' }), { accepted: true }, 'finish replay is a receipt');
    assert.equal(store.acceptFinish({ taskId: task.id, executionId, summary: 'Again', key: 'f-2' }).replay, true, 'one-way finish boundary');
    assert.throws(() => store.park({ taskId: task.id, executionId, kind: 'question', prompt: 'After finish?', key: 'i-after' }), { statusCode: 409 });
    assert.throws(() => store.progress({ taskId: task.id, executionId, note: 'After finish', key: 'p-after' }), { statusCode: 409 });
    assert.throws(() => store.settle({ taskId: task.id, executionId, outcome: 'failed', summary: 'After finish', key: 's-fail' }), { statusCode: 409 });
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
    // An acknowledgement identifies the exact obligation: an execution ID alone (or an older epoch) is not enough.
    assert.equal(store.ackDispatch(retried.id, claimedRetry.execution_id), false, 'an acknowledgement without its obligation is refused');
    assert.equal(store.ackDispatch(retried.id, claimedRetry.execution_id, claimedRetry.dispatch_epoch - 1), false, 'a stale obligation cannot acknowledge');
    assert.equal(store.dueDispatch(4_000 + 2_000).length, 1, 'the unacknowledged dispatch stays owed');
    assert.equal(store.ackDispatch(retried.id, claimedRetry.execution_id, due[0].dispatch_epoch), true);
    assert.deepEqual(store.dueDispatch(4_000 + 2_000), [], 'an acknowledged dispatch is not re-driven');
    assert.equal(store.failExecution(retried.id, claimedRetry.execution_id, 'Blueprint revision gone'), true);
    assert.equal(store.get(scope, retried.id).status, 'failed');
    assert.equal(store.get(scope, retried.id).failure, 'Blueprint revision gone');
    assert.equal(store.failExecution(retried.id, claimedRetry.execution_id, 'again'), false, 'a terminal Task is fenced');

    // A recoverable block is visible and is cleared only by the acknowledgement that matches the current obligation.
    const blocked = store.create({ ...base, title: 'Blocked', key: 'create-blocked' });
    const claimedBlocked = store.claim(5_000);
    assert.equal(claimedBlocked.id, blocked.id);
    assert.equal(store.block(blocked.id, claimedBlocked.execution_id, 'The Task worktree is missing.', 5_000), true);
    assert.equal(store.get(scope, blocked.id).blocked, 'The Task worktree is missing.');
    assert.equal(store.meta(blocked.id).blocked, 'The Task worktree is missing.');
    const blockItem = store.park({ taskId: blocked.id, executionId: claimedBlocked.execution_id, kind: 'question', prompt: 'Resume?', key: 'i-block' });
    store.respond(scope, blockItem.itemId, 'Yes');
    const resumedBlock = store.claim(6_000);
    assert.equal(resumedBlock.id, blocked.id);
    // An older item's late acknowledgement cannot clear it.
    assert.equal(store.resumeDelivered({ taskId: blocked.id, executionId: resumedBlock.execution_id, itemId: 'f'.repeat(32) }), true);
    assert.equal(store.get(scope, blocked.id).blocked, 'The Task worktree is missing.');
    // Nor can a late acknowledgement of the right item that belongs to an older dispatch obligation.
    assert.equal(store.resumeDelivered({
      taskId: blocked.id, executionId: resumedBlock.execution_id, itemId: blockItem.itemId, epoch: resumedBlock.dispatch_epoch - 1,
    }), true);
    const afterStale = store.db.prepare('SELECT blocked_reason, dispatch_pending, resume_item_id, execution_kind FROM tasks WHERE id=?').get(blocked.id);
    assert.equal(afterStale.blocked_reason, 'The Task worktree is missing.', 'a stale resume acknowledgement cannot clear a newer block');
    assert.equal(afterStale.dispatch_pending, 1, 'the newer recovery stays scheduled');
    // A delivered answer leaves no resume obligation behind: the caller never schedules an empty resume for this item.
    assert.equal(afterStale.resume_item_id, null);
    assert.equal(afterStale.execution_kind, 'start');
    // The scheduled recovery is a plain start for the same execution, and its acknowledgement clears the block.
    const recoveredBlock = store.dueDispatch(70_000)[0];
    assert.equal(recoveredBlock.id, blocked.id);
    assert.equal(store.ackDispatch(blocked.id, recoveredBlock.execution_id, recoveredBlock.dispatch_epoch), true);
    assert.equal(store.get(scope, blocked.id).blocked, undefined, 'the recovery acknowledgement clears the block');

    // The accepted finish is authoritative over an exhausted dispatch retry budget.
    const finished = store.create({ ...base, title: 'Finish then retry', key: 'create-finished' });
    const claimedFinish = store.claim(7_000);
    assert.equal(claimedFinish.id, finished.id);
    assert.deepEqual(store.acceptFinish({ taskId: finished.id, executionId: claimedFinish.execution_id, summary: 'Finished.', key: 'f-retry' }), { accepted: true });
    assert.equal(store.retryDispatch(finished.id, claimedFinish.execution_id, 7_100, 'Worker unreachable.'), 'settled');
    const settledFinished = store.get(scope, finished.id);
    assert.equal(settledFinished.status, 'done');
    assert.equal(settledFinished.outcome, 'Finished.');

    // Pull-request evidence is mandatory for a Task that requires it and is bound to the accepted commit.
    const pr = store.create({ ...base, title: 'PR', key: 'create-pr', requiresPr: true, finishRequired: true });
    const claimedPr = store.claim(8_000);
    assert.equal(claimedPr.id, pr.id);
    assert.throws(() => store.acceptFinish({ taskId: pr.id, executionId: claimedPr.execution_id, summary: 'No PR', key: 'f-pr-0' }),
      { statusCode: 409 });
    assert.throws(() => store.acceptFinish({
      taskId: pr.id, executionId: claimedPr.execution_id, summary: 'Bad PR', key: 'f-pr-1',
      evidence: { commit: 'a'.repeat(40), pullRequest: { url: 'https://github.com/./../pull/1', commit: 'a'.repeat(40) } },
    }), { statusCode: 409 });
    assert.throws(() => store.acceptFinish({
      taskId: pr.id, executionId: claimedPr.execution_id, summary: 'Wrong commit', key: 'f-pr-2',
      evidence: { commit: 'a'.repeat(40), pullRequest: { url: 'https://github.com/lanquarden/manolo/pull/2', commit: 'b'.repeat(40) } },
    }), { statusCode: 409 });
    assert.deepEqual(store.acceptFinish({
      taskId: pr.id, executionId: claimedPr.execution_id, summary: 'With PR', key: 'f-pr-3',
      evidence: { commit: 'a'.repeat(40), pullRequest: { url: 'https://github.com/lanquarden/manolo/pull/2', commit: 'a'.repeat(40) } },
    }).accepted, true);
    // Owner isolation: another scope cannot read or respond.
    assert.equal(store.get('other', task.id), undefined);
    assert.throws(() => store.respond('other', parked.itemId, 'Answer'), { statusCode: 404 });
    assert.throws(() => store.cancel('other', task.id), { statusCode: 404 });
  } finally {
    db.close();
  }
});

async function launchTaskRelay(t, { root, dataDir, stubUrl, token, password, name = 'relay', extraEnv = {} }) {
  const config = join(root, `${name}.json`);
  await writeFile(config, JSON.stringify({
    agents: { canary: { url: stubUrl, tokenEnv: 'CANARY_TOKEN' } },
    owners: { owner: { agent: 'canary', passwordEnv: 'OWNER_PASSWORD' } }, routes: [], inbox: [],
  }));
  const relay = start(t, 'relay', {
    CANARY_TOKEN: token, OWNER_PASSWORD: password, MANOLO_RELAY_CONFIG: config, MANOLO_DATA_DIR: dataDir,
    MANOLO_WORK_SESSION_AGENT: 'canary', PORT: '0', MANOLO_INTERNAL_PORT: '0', ...extraEnv,
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
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions(?:\/v2)?$/.exec(req.url);
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

test('a legacy row without the finish protocol still settles a queued Task', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const raw = JSON.stringify({ review: { description: 'Legacy review', instructions: 'Review locally.' } });
  const revision = loadWorkBlueprints(raw).blueprints.get('review').revision;
  let relayInternal = 'http://127.0.0.1:1';
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    if (/^\/v1\/tasks\/[0-9a-f]{32}\/executions(?:\/v2)?$/.test(req.url)) {
      let body = ''; for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      // The plain route carries the legacy shape only: no protocol, no finish requirement, no pinned fields.
      assert.equal(parsed.task.finishRequired, undefined);
      assert.equal(parsed.task.protocol, undefined);
      assert.match(req.url, /\/executions$/);
      const taskId = /^\/v1\/tasks\/([0-9a-f]{32})\/executions(?:\/v2)?$/.exec(req.url)[1];
      await fetch(`${relayInternal}/v1/tasks/${taskId}/settle`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'settle-legacy' },
        body: JSON.stringify({ executionId: parsed.executionId, outcome: 'done', summary: 'legacy done' }),
      });
      return json({ status: 'running' });
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relay = await launchTaskRelay(t, {
    root, dataDir: join(root, 'relay'), stubUrl: addr(server.address().port), token, password,
    extraEnv: { MANOLO_TASK_FINISH: 'legacy' },
  });
  relayInternal = relay.internal;
  const auth = basic('owner', password);
  assert.equal((await request(relay.web, '/api/turns', auth, 'POST', { id: 'legacy-origin', text: 'Start' }, mutation)).status, 200);
  const created = await request(relay.internal, '/v1/tasks', { authorization: `Bearer ${token}` }, 'POST', {
    turnId: key('web', 'owner', 'canary', 'legacy-origin'), title: 'Legacy task', task: 'fixture:bare',
    blueprint: { id: 'review', revision },
  }, { 'idempotency-key': 'create-legacy' });
  assert.equal(created.status, 200, await created.clone().text());
  const task = await created.json();
  const settled = await until(async () => (await taskList(relay.web, auth)).find(row => row.id === task.id && row.status === 'done'), 'legacy Task settles');
  assert.equal(settled.status, 'done');
});

test('an unavailable pinned profile blocks and later resumes the same assignment without substitution', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  let available = false;
  const dispatch = [];
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    if (/^\/v1\/tasks\/[0-9a-f]{32}\/executions(?:\/v2)?$/.test(req.url)) {
      let body = ''; for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      dispatch.push(parsed);
      if (!available) return json({ error: 'task request rejected', reason: 'profile_unavailable' }, 409);
      return json({ status: 'running' });
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relayData = join(root, 'relay');
  const relay = await launchTaskRelay(t, { root, dataDir: relayData, stubUrl: addr(server.address().port), token, password });
  const auth = basic('owner', password);
  assert.equal((await request(relay.web, '/api/turns', auth, 'POST', { id: 'profile-origin', text: 'Start' }, mutation)).status, 200);
  const profile = { id: 'deep', description: 'Deep profile', provider: 'model-proxy', model: 'deep-model', thinkingLevel: 'high' };
  const created = await request(relay.internal, '/v1/tasks', { authorization: `Bearer ${token}` }, 'POST', {
    turnId: key('web', 'owner', 'canary', 'profile-origin'), title: 'Profile task', task: 'Do it.', profile,
  }, { 'idempotency-key': 'create-profile' });
  assert.equal(created.status, 200, await created.clone().text());
  const task = await created.json();
  const blocked = await until(async () => (await taskList(relay.web, auth)).find(row => row.id === task.id && row.blocked), 'profile blocked');
  assert.match(blocked.blocked, /profile/i);
  assert.equal(dispatch[0].task.profile.model, 'deep-model');
  available = true;
  const resumed = await until(async () => {
    const db = new DatabaseSync(join(relayData, 'relay.sqlite'));
    db.prepare('UPDATE tasks SET next_at=0 WHERE id=?').run(task.id);
    db.close();
    const row = (await taskList(relay.web, auth)).find(entry => entry.id === task.id);
    return dispatch.length >= 2 && row && !row.blocked && row;
  }, 'profile assignment resumes after restore');
  assert.equal(resumed.executionId, blocked.executionId);
  assert.equal(dispatch.at(-1).task.profile.model, 'deep-model');
  assert.equal(dispatch.at(-1).task.profile.thinkingLevel, 'high');
});

test('a new-style Task is blocked before an old worker is asked to run a substituted assignment, then resumes', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-protocol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  let protocol = 0;
  const dispatch = [];
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/task-protocol') return protocol === 2 ? json({ version: 2 }) : json({}, 404);
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    if (/^\/v1\/tasks\/[0-9a-f]{32}\/executions(?:\/v2)?$/.test(req.url)) {
      let body = ''; for await (const chunk of req) body += chunk;
      dispatch.push(JSON.parse(body));
      return json({ status: 'running' });
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relayData = join(root, 'relay');
  const relay = await launchTaskRelay(t, { root, dataDir: relayData, stubUrl: addr(server.address().port), token, password });
  const auth = basic('owner', password);
  await createTaskForTest(relay.web, relay.internal, token, auth, { title: 'Protocol task' });
  const blocked = await until(async () => (await taskList(relay.web, auth)).find(row => row.blocked), 'task blocked on worker protocol');
  assert.match(blocked.blocked, /protocol|Upgrade/i);
  assert.equal(dispatch.length, 0, 'an old worker is never sent the new assignment');
  protocol = 2;
  const resumed = await until(async () => {
    const db = new DatabaseSync(join(relayData, 'relay.sqlite'));
    db.prepare('UPDATE tasks SET next_at=0 WHERE id=?').run(blocked.id);
    db.close();
    const row = (await taskList(relay.web, auth)).find(entry => entry.id === blocked.id);
    return dispatch.length > 0 && row && !row.blocked && row;
  }, 'same Task dispatches after worker upgrade');
  assert.equal(resumed.id, blocked.id);
  assert.equal(dispatch[0].task.protocol, 2);
  assert.equal(dispatch[0].executionId, blocked.executionId, 'the same execution identity resumes');
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
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions(?:\/v2)?$/.exec(req.url);
    if (dispatch) {
      const body = await read();
      calls.dispatch.push({ taskId: dispatch[1], ...body });
      if (calls.dispatch.length === 1) {
        // The child finishes immediately, then the relay's read of the acknowledgement fails.
        const [status, settled] = await finishAndSettle(relayCall, dispatch[1],
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
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions(?:\/v2)?$/.exec(req.url);
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
        const [status] = await finishAndSettle(relayCall, dispatch1TaskId(),
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
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions(?:\/v2)?$/.exec(req.url);
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
        const [status] = await finishAndSettle(relayCall, resume[1],
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
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions(?:\/v2)?$/.exec(req.url);
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
      const [status] = await finishAndSettle(relayCall, resume[1],
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
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions(?:\/v2)?$/.exec(req.url);
    if (dispatch) {
      const body = await read();
      calls.dispatch.push({ taskId: dispatch[1], ...body });
      if (calls.dispatch.length === 1) {
        // Hold the request open: the relay is killed with the dispatch in flight, before any acknowledgement.
        res.on('close', () => {});
        return;
      }
      await ready;
      const [status] = await finishAndSettle(relayCall, dispatch[1],
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
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions(?:\/v2)?$/.exec(req.url);
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
    store.acceptFinish({ taskId: task.id, executionId, summary: 'Multi done', key: 'finish-multi' });
    store.settle({ taskId: task.id, executionId, outcome: 'done', summary: 'Multi done', key: 'settle-multi' });

    // Terminal traffic: 30 finished Tasks, one active Task, and a filtered History.
    for (let index = 0; index < 30; index++) {
      const done = store.create({
        ...base, title: `Done ${index}`, input: 'Finished work.', key: `create-done-${index}`,
        blueprint: index % 2 === 0 ? { id: 'review', revision: 'a'.repeat(64) } : undefined,
      });
      const claim = store.claim(clock + 10_000 + index);
      assert.equal(claim.id, done.id);
      store.acceptFinish({ taskId: done.id, executionId: claim.execution_id, summary: `Outcome ${index}`, key: `finish-${index}` });
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

test('a legacy finish rollout still requires finish and pull-request evidence for a structured new Task', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-legacy-structured-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const commit = 'a'.repeat(40);
  const calls = { settle: [], finish: [], dispatch: [] };
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
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions\/v2$/.exec(req.url);
    if (dispatch) {
      const taskId = dispatch[1];
      const executionId = parsed.executionId;
      calls.dispatch.push(taskId);
      // In a legacy rollout a structured Task is still a new contract: a bare success is refused, and so is finish
      // without canonical pull-request evidence bound to the accepted commit and the configured destination.
      calls.settle.push((await relayCall(`/v1/tasks/${taskId}/settle`,
        { executionId, outcome: 'done', summary: 'skipped finish' }, 'settle-skip'))[0]);
      calls.finish.push((await relayCall(`/v1/tasks/${taskId}/finish`, { executionId, summary: 'no evidence' }, 'finish-none'))[0]);
      calls.finish.push((await relayCall(`/v1/tasks/${taskId}/finish`, {
        executionId, summary: 'malformed url',
        evidence: { commit, pullRequest: { url: 'https://github.com/./../pull/1', commit } },
      }, 'finish-malformed'))[0]);
      calls.finish.push((await relayCall(`/v1/tasks/${taskId}/finish`, {
        executionId, summary: 'wrong destination',
        evidence: { commit, pullRequest: { url: 'https://github.com/someone-else/fork/pull/1', commit } },
      }, 'finish-wrong-repo'))[0]);
      calls.finish.push((await relayCall(`/v1/tasks/${taskId}/finish`, {
        executionId, summary: 'with evidence',
        evidence: { commit, pullRequest: { url: 'https://github.com/lanquarden/manolo/pull/12', commit } },
      }, 'finish-good'))[0]);
      calls.settle.push((await relayCall(`/v1/tasks/${taskId}/settle`,
        { executionId, outcome: 'done', summary: 'with evidence' }, 'settle-done'))[0]);
      return json({ status: 'running' });
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relay = await launchTaskRelay(t, {
    root, dataDir: join(root, 'relay'), stubUrl: addr(server.address().port), token, password,
    extraEnv: { MANOLO_TASK_FINISH: 'legacy' },
  });
  relayInternal.url = relay.internal;
  const auth = basic('owner', password);
  assert.equal((await request(relay.web, '/api/turns', auth, 'POST', { id: 'legacy-structured', text: 'Start' }, mutation)).status, 200);
  const snapshot = sealBlueprintSnapshot({
    id: 'repo', role: 'task', description: 'Repository Task', instructions: 'Work in the repository.',
    tools: ['report_progress', 'post_inbox', 'finish'], files: [],
    repository: { name: 'sample', remote: 'https://github.com/lanquarden/manolo.git', base: 'main' },
  });
  const created = await request(relay.internal, '/v1/tasks', { authorization: `Bearer ${token}` }, 'POST', {
    turnId: key('web', 'owner', 'canary', 'legacy-structured'), title: 'Legacy PR Task', task: 'Do it.',
    blueprint: { id: 'repo', revision: snapshot.revision, snapshot }, requiresPullRequest: true,
  }, { 'idempotency-key': 'create-legacy-structured' });
  assert.equal(created.status, 200, await created.clone().text());
  const task = await created.json();
  const done = await until(async () => (await taskList(relay.web, auth)).find(row => row.id === task.id && row.status === 'done'), 'structured Task finishes');
  assert.equal(done.outcome, 'with evidence');
  assert.equal(done.handoff.commit, commit);
  assert.equal(done.handoff.pullRequest.url, 'https://github.com/lanquarden/manolo/pull/12');
  assert.deepEqual(calls.dispatch.length, 1);
  assert.deepEqual(calls.settle, [409, 200], 'a bare success is refused even in legacy mode');
  assert.deepEqual(calls.finish, [409, 409, 409, 200], 'pull-request evidence is structural and destination-bound');
  const db = new DatabaseSync(join(root, 'relay', 'relay.sqlite'));
  assert.equal(db.prepare('SELECT finish_required FROM tasks WHERE id=?').get(task.id).finish_required, 1, 'the ledger records the new contract per Task');
  db.close();
});

test('a worker downgraded between the protocol probe and dispatch is blocked, never fed the assignment on the old path', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-downgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  let upgraded = false;
  const calls = { v2: [], plain: [] };
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
    // The probe still reports a modern worker: the replacement happens after it, before the assignment arrives.
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    const v2 = /^\/v1\/tasks\/([0-9a-f]{32})\/executions\/v2$/.exec(req.url);
    if (v2) {
      if (!upgraded) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}'); return; }
      calls.v2.push({ taskId: v2[1], body: parsed });
      const [status] = await finishAndSettle(relayCall, v2[1], { executionId: parsed.executionId, outcome: 'done', summary: 'Ran on v2.' }, 'settle-v2');
      return json({ status: status === 200 ? 'running' : 'failed' });
    }
    if (/^\/v1\/tasks\/[0-9a-f]{32}\/executions$/.test(req.url)) {
      calls.plain.push({ url: req.url, body: parsed });
      return json({ status: 'running' });
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relay = await launchTaskRelay(t, { root, dataDir: join(root, 'relay'), stubUrl: addr(server.address().port), token, password });
  relayInternal.url = relay.internal;
  const auth = basic('owner', password);
  assert.equal((await request(relay.web, '/api/turns', auth, 'POST', { id: 'downgrade', text: 'Start' }, mutation)).status, 200);
  const created = await request(relay.internal, '/v1/tasks', { authorization: `Bearer ${token}` }, 'POST', {
    turnId: key('web', 'owner', 'canary', 'downgrade'), title: 'Pinned on rollout', task: 'Do the work.',
    profile: { id: 'deep', description: 'Deep profile', provider: 'manolo-fixture', model: 'fixture-deep', thinkingLevel: 'high' },
  }, { 'idempotency-key': 'create-downgrade' });
  assert.equal(created.status, 200, await created.clone().text());
  const task = await created.json();
  const blocked = await until(async () => (await taskList(relay.web, auth)).find(row => row.id === task.id && row.blocked), 'downgraded worker is held');
  assert.match(blocked.blocked, /protocol/i);
  assert.equal(blocked.status, 'running');
  assert.deepEqual(calls.plain, [], 'a new-style assignment is never sent to the old path');
  // The worker comes back modern: the same Task, execution, and assignment resume on the versioned path only.
  upgraded = true;
  const db = new DatabaseSync(join(root, 'relay', 'relay.sqlite'));
  db.prepare('UPDATE tasks SET next_at=0 WHERE id=?').run(task.id);
  db.close();
  const done = await until(async () => (await taskList(relay.web, auth)).find(row => row.id === task.id && row.status === 'done'), 'same Task resumes');
  assert.equal(done.outcome, 'Ran on v2.');
  assert.equal(done.blocked, undefined, 'the healthy admission acknowledgement clears the block');
  assert.equal(calls.v2.length, 1);
  assert.equal(calls.v2[0].body.task.profile.model, 'fixture-deep', 'the pinned profile arrived unchanged');
  assert.deepEqual(calls.plain, []);
});

test('an accepted finish survives a lost resume acknowledgement and a lost execution', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-finish-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  let taskId;
  let executionId;
  let itemId;
  let resumes = 0;
  const dispatchCalls = [];
  const relayInternal = { url: 'http://127.0.0.1:1' };
  const post = async (path, body, idem) => {
    const response = await fetch(`${relayInternal.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idem && { 'idempotency-key': idem }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return [response.status, await response.json().catch(() => ({}))];
  };
  const server = createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions\/v2$/.exec(req.url);
    if (dispatch) {
      taskId = dispatch[1];
      executionId = parsed.executionId;
      dispatchCalls.push(parsed);
      const [status, parked] = await post(`/v1/tasks/${taskId}/inbox`,
        { executionId, kind: 'question', prompt: 'Continue?' }, 'park-finish-resume');
      assert.equal(status, 200);
      itemId = parked.itemId;
      return json({ status: 'parked' });
    }
    const resume = /^\/v1\/tasks\/([0-9a-f]{32})\/resume$/.exec(req.url);
    if (resume) {
      if (++resumes > 1) {
        // The execution is gone by the second attempt; the accepted finish is the only authoritative fact left.
        return json({ delivered: false, reason: 'unknown_execution' });
      }
      const [accepted] = await post(`/v1/tasks/${resume[1]}/finish`,
        { executionId: parsed.executionId, summary: 'Completed with your answer.' }, 'finish-during-resume');
      assert.equal(accepted, 200);
      res.writeHead(502).end();
      return;
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relay = await launchTaskRelay(t, { root, dataDir: join(root, 'relay'), stubUrl: addr(server.address().port), token, password });
  relayInternal.url = relay.internal;
  const auth = basic('owner', password);
  await createTaskForTest(relay.web, relay.internal, token, auth, { title: 'Resume then finish' });
  await until(() => itemId, 'stub parks');
  assert.equal((await request(relay.web, `/api/tasks/${taskId}/inbox/${itemId}/respond`, auth, 'POST', { answer: 'yes' }, mutation)).status, 200);
  const done = await until(async () => (await taskList(relay.web, auth)).find(row => row.id === taskId && ['done', 'failed'].includes(row.status)), 'Task settles from the accepted finish');
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(done.outcome, 'Completed with your answer.');
  assert.equal(done.blocked, undefined);
  assert.equal(dispatchCalls.length, 1, 'no replacement child is started');
  assert.equal(done.executionId, undefined, 'the terminal row no longer advertises a live execution');
});

test('a delayed dispatch acknowledgement never clears a block the worker reported while it was in flight', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-stale-ack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = secret();
  const password = secret();
  const calls = { dispatch: [], block: [] };
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
    if (req.url === '/v1/task-protocol') return json({ version: 2 });
    if (req.url.startsWith('/v1/turns/')) { for await (const chunk of req) void chunk; return json({ status: 'done', text: 'ok' }); }
    const read = async () => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
    const dispatch = /^\/v1\/tasks\/([0-9a-f]{32})\/executions(?:\/v2)?$/.exec(req.url);
    if (dispatch) {
      const body = await read();
      calls.dispatch.push({ taskId: dispatch[1], ...body });
      if (calls.dispatch.length === 1) {
        // The execution is admitted, then its own workspace check reports a recoverable block while this dispatch response
        // is still in flight. The acknowledgement below therefore lands after the newer obligation exists.
        const [status] = await relayCall(`/v1/tasks/${dispatch[1]}/block`, {
          executionId: body.executionId,
          reason: 'The Task worktree is missing or was replaced. Restore it; the Task will resume.',
        }, 'block-in-flight');
        assert.equal(status, 200);
        calls.block.push(body.executionId);
      }
      return json({ status: 'running' });
    }
    const cancel = /^\/v1\/tasks\/([0-9a-f]{32})\/cancel$/.exec(req.url);
    if (cancel) { await read(); return json({ ok: true }); }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relayData = join(root, 'relay');
  const relay = await launchTaskRelay(t, { root, dataDir: relayData, stubUrl: addr(server.address().port), token, password });
  relayInternal.url = relay.internal;
  const auth = basic('owner', password);
  await createTaskForTest(relay.web, relay.internal, token, auth, { title: 'Delayed ack' });
  const ledger = () => {
    const db = new DatabaseSync(join(relayData, 'relay.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT status, execution_id, blocked_reason, dispatch_pending, next_at FROM tasks').get();
    } finally {
      db.close();
    }
  };
  const blocked = await until(async () => (await taskList(relay.web, auth)).find(row => row.blocked), 'the block survives the delayed acknowledgement');
  assert.equal(blocked.status, 'running');
  assert.match(blocked.blocked, /worktree/i);
  assert.equal(calls.dispatch.length, 1);
  // The newer recovery obligation is intact: a stranded Task would have no pending dispatch and no retry scheduled.
  assert.equal(ledger().dispatch_pending, 1, 'the delayed acknowledgement did not clear the newer obligation');
  assert.ok(ledger().next_at > 0, 'the newer recovery is still scheduled');

  // Restoring the workspace resumes the same execution through the newer obligation.
  const resumed = await until(async () => {
    const db = new DatabaseSync(join(relayData, 'relay.sqlite'));
    db.prepare('UPDATE tasks SET next_at=0').run();
    db.close();
    const row = (await taskList(relay.web, auth)).find(entry => entry.id === blocked.id);
    return calls.dispatch.length >= 2 && row && !row.blocked && row;
  }, 'the restored workspace resumes the same execution');
  assert.equal(resumed.id, blocked.id);
  assert.equal(resumed.executionId, blocked.executionId);
  assert.equal(calls.dispatch.at(-1).executionId, calls.dispatch[0].executionId, 'the same execution identity is retried');
  assert.equal(ledger().dispatch_pending, 0, 'the matching acknowledgement clears the obligation');
});

test('a migrated row cannot bare-settle around a required pull request, whatever its finish flag says', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-migrated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, 'relay.sqlite');
  // A real relay database from before the finish protocol: the ledger the upgrade in `openTaskStore` migrates in place.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL,
      owner TEXT NOT NULL,
      agent TEXT NOT NULL,
      origin_turn_id TEXT NOT NULL,
      title TEXT NOT NULL,
      input TEXT NOT NULL,
      blueprint_id TEXT,
      blueprint_revision TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','done','failed','cancelled')),
      not_before INTEGER NOT NULL DEFAULT 0,
      execution_id TEXT,
      execution_kind TEXT NOT NULL DEFAULT 'start' CHECK(execution_kind IN ('start','resume')),
      resume_item_id TEXT,
      context TEXT,
      claim_at INTEGER,
      heartbeat_at INTEGER,
      dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0,
      stop_pending INTEGER NOT NULL DEFAULT 0,
      stop_attempts INTEGER NOT NULL DEFAULT 0,
      stop_next_at INTEGER NOT NULL DEFAULT 0,
      stop_confirmed_at TEXT,
      outcome TEXT,
      failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const taskId = 'a'.repeat(32);
  const now = new Date().toISOString();
  legacy.prepare(`INSERT INTO tasks(id,scope,owner,agent,origin_turn_id,title,input,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(taskId, 'scope', 'owner', 'canary', 'turn', 'Migrated task', 'Do the work.', 'queued', now, now);
  legacy.close();

  const store = openTaskStore(new DatabaseSync(dbPath));
  try {
    const migrated = store.db.prepare('SELECT finish_required, requires_pr, blueprint_snapshot FROM tasks WHERE id=?').get(taskId);
    assert.equal(migrated.finish_required, 0, 'the upgrade marks a pre-protocol row as legacy');
    assert.equal(migrated.requires_pr, 0);
    assert.equal(migrated.blueprint_snapshot, null);
    // This upgraded row's owner required a pull request and finish was never enforced on it.
    store.db.prepare('UPDATE tasks SET requires_pr=1 WHERE id=?').run(taskId);
    const claimed = store.claim(Date.now());
    assert.equal(claimed.id, taskId);
    assert.throws(() => store.settle({ taskId, executionId: claimed.execution_id, outcome: 'done', summary: 'bare final', key: 'settle-bare' }),
      { statusCode: 409 });
    assert.throws(() => store.acceptFinish({ taskId, executionId: claimed.execution_id, summary: 'no evidence', key: 'finish-none' }),
      { statusCode: 409 });
    assert.throws(() => store.acceptFinish({
      taskId, executionId: claimed.execution_id, summary: 'wrong commit', key: 'finish-mismatch',
      evidence: { commit: 'b'.repeat(40), pullRequest: { url: 'https://github.com/lanquarden/manolo/pull/3', commit: 'c'.repeat(40) } },
    }), { statusCode: 409 });
    assert.throws(() => store.settle({ taskId, executionId: claimed.execution_id, outcome: 'done', summary: 'still bare', key: 'settle-bare-2' }),
      { statusCode: 409 });
    assert.equal(store.acceptFinish({
      taskId, executionId: claimed.execution_id, summary: 'with evidence', key: 'finish-good',
      evidence: { commit: 'b'.repeat(40), pullRequest: { url: 'https://github.com/lanquarden/manolo/pull/3', commit: 'b'.repeat(40) } },
    }).accepted, true);
    assert.equal(store.settle({ taskId, executionId: claimed.execution_id, outcome: 'done', summary: 'with evidence', key: 'settle-done' }).status, 'done');
    const settled = store.get('scope', taskId);
    assert.equal(settled.status, 'done');
    assert.equal(settled.outcome, 'with evidence');
    assert.equal(settled.requiresPullRequest, true);
  } finally {
    store.db.close();
  }
});
