import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadWorkBlueprints } from '../src/work-blueprints.mjs';
import { selectableWorkBlueprints } from '../src/work-sessions.mjs';
import { openTaskStore } from '../src/task-store.mjs';
import { installTasks } from '../src/task-tools.mjs';

const { createRegistry } = await import(pathToFileURL(join(import.meta.dirname, '../node_modules/@earendil-works/pi-durable/dist/index.js')));

function docs() {
  const data = new Map();
  const get = (def, id) => {
    const key = `${def.definition.kind}:${id}`;
    if (!data.has(key)) data.set(key, {});
    return data.get(key);
  };
  const commit = async run => run({ doc: async (...args) => get(...args) });
  return { data, get, commit };
}

function taskFixture(store, scope = 'scope') {
  const task = store.create({ owner: 'owner', agent: 'agent', scope, originTurnId: 'turn', title: 'demo', input: 'demo', key: `create-${Math.random()}` });
  const { execution_id: executionId } = store.claim(Date.now());
  return { taskId: task.id, executionId };
}

test('a lost finish acknowledgement reconciles authoritative state without resampling Git', async () => {
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const { taskId, executionId } = taskFixture(store);
  const { data, get, commit } = docs();
  data.set('manolo.task-run:conv', { taskId, executionId });
  data.set(`manolo.task-execution:${taskId}`, { executionId, state: 'running', workspace: { path: '/tmp/does-not-matter' } });
  let gitChecks = 0;
  let lost = true;
  const tasks = installTasks(createRegistry(), {
    cfg: { relay: 'http://in-process.invalid', token: 'fixture' }, redact: text => text,
    taskGit: { checkFinish: async () => { gitChecks++; return { ok: true, commit: 'a'.repeat(40), base: 'b'.repeat(40) }; } },
  });
  tasks.attach({ snapshot: async (...args) => get(...args) });
  const finish = tasks.worker.tools.find(tool => tool.name === 'finish');
  const api = { conversationId: 'conv', commit };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/finish')) {
      const receipt = store.acceptFinish({ taskId, ...JSON.parse(options.body), key: options.headers['idempotency-key'] });
      if (lost) { lost = false; throw new Error('injected lost acknowledgement after commit'); }
      return Response.json(receipt);
    }
    if (path.endsWith('/state')) {
      const meta = store.meta(taskId);
      return Response.json({ status: meta.status, executionId: meta.executionId, finishAccepted: meta.finishAccepted,
        finishSummary: meta.finishSummary, evidence: meta.handoff });
    }
    throw new Error(`unexpected ${path}`);
  };
  await assert.rejects(finish.execute({ summary: 'verified' }, api, {}), /injected lost/);
  assert.equal(gitChecks, 1);
  // The workspace is now dirty; the accepted finish is still recovered from authoritative state.
  const replay = await finish.execute({ summary: 'verified' }, api, {});
  assert.equal(replay.isError, false, JSON.stringify(replay));
  assert.equal(gitChecks, 1, 'a replay of an accepted finish never resamples Git');
  assert.equal(data.get(`manolo.task-execution:${taskId}`).finishAccepted, true);
  // The one-way boundary refuses new work and any failure downgrade.
  assert.throws(() => store.park({ taskId, executionId, kind: 'question', prompt: 'more?', key: 'after' }), { statusCode: 409 });
  assert.throws(() => store.progress({ taskId, executionId, note: 'after', key: 'progress-after' }), { statusCode: 409 });
  assert.throws(() => store.settle({ taskId, executionId, outcome: 'failed', summary: 'late failure', key: 'failed-after' }), { statusCode: 409 });
});

test('cancellation after an accepted finish is the explicit terminal decision and blocks a later success settle', () => {
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const { taskId, executionId } = taskFixture(store);
  store.acceptFinish({ taskId, executionId, summary: 'done', key: 'finish-cancel' });
  const cancelled = store.cancel('scope', taskId);
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(cancelled.task.finish.acceptedAt !== undefined, true);
  assert.throws(() => store.settle({ taskId, executionId, outcome: 'done', summary: 'late', key: 'settle-after-cancel' }), { statusCode: 409 });
});

test('an ambiguous settlement is not local terminal and a restart replays it', async () => {
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const { taskId, executionId } = taskFixture(store);
  store.acceptFinish({ taskId, executionId, summary: 'done', key: 'finish' });
  const { data, get, commit } = docs();
  data.set(`manolo.task-execution:${taskId}`, {
    taskId, executionId, state: 'running', finishAccepted: true, finishSummary: 'done', conversationId: 'conv', submissionId: 'submission',
  });
  data.set('manolo.task-index:all', { ids: [taskId] });
  let attempts = 0;
  let cleanups = 0;
  globalThis.fetch = async url => {
    if (new URL(url).pathname.endsWith('/settle')) { attempts++; return new Response(null, { status: 409 }); }
    return Response.json({ status: 'running', executionId, finishAccepted: true, finishSummary: 'done' });
  };
  const tasks = installTasks(createRegistry(), {
    cfg: { relay: 'http://in-process.invalid', token: 'fixture' }, redact: text => text,
    settleRetryMs: [1], taskGit: { cleanup: async () => { cleanups++; return { removed: true }; } },
  });
  const harness = {
    snapshot: async (...args) => get(...args), commit,
    submission: async () => ({ wait: async () => ({ status: 'done' }) }),
  };
  tasks.attach(harness);
  await tasks.start();
  await sleep(50);
  assert.ok(attempts > 0);
  assert.equal(cleanups, 0, 'ambiguous settlement never cleans the workspace');
  assert.equal(data.get(`manolo.task-execution:${taskId}`).state, 'running', 'ambiguous settlement is not local terminal');
  const first = attempts;
  await tasks.start();
  await sleep(50);
  assert.ok(attempts > first, 'a restart replays the settlement with the same execution');
});

test('a restart reconciles an accepted finish whose local marker was lost', async () => {
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const { taskId, executionId } = taskFixture(store);
  store.acceptFinish({ taskId, executionId, summary: 'accepted remotely', key: 'finish-remote' });
  const { data, get, commit } = docs();
  data.set(`manolo.task-execution:${taskId}`, {
    taskId, executionId, state: 'running', conversationId: 'conv', submissionId: 'submission',
  });
  data.set('manolo.task-index:all', { ids: [taskId] });
  let cleanups = 0;
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/state')) return Response.json({ status: 'running', executionId, finishAccepted: true, finishSummary: 'accepted remotely' });
    if (path.endsWith('/settle')) return Response.json({ status: 'done' });
    return Response.json({ ok: true });
  };
  const tasks = installTasks(createRegistry(), {
    cfg: { relay: 'http://in-process.invalid', token: 'fixture' }, redact: text => text, settleRetryMs: [1],
    taskGit: { cleanup: async () => { cleanups++; return { removed: true }; } },
  });
  tasks.attach({
    snapshot: async (...args) => get(...args), commit,
    submission: async () => ({ wait: async () => ({ status: 'done' }) }),
  });
  await tasks.start();
  await sleep(30);
  assert.equal(data.get(`manolo.task-execution:${taskId}`).finishAccepted, true);
  assert.equal(data.get(`manolo.task-execution:${taskId}`).state, 'settled');
  assert.equal(cleanups, 1);
});

test('a late Inbox acknowledgement cannot clear a newer response', () => {
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const task = store.create({ owner: 'owner', agent: 'agent', scope: 'scope', originTurnId: 'turn', title: 'demo', input: 'demo', key: 'create' });
  const executionId = store.claim(Date.now()).execution_id;
  const first = store.park({ taskId: task.id, executionId, kind: 'question', prompt: 'first?', key: 'first' });
  store.respond('scope', first.itemId, 'one'); store.claim(Date.now());
  const second = store.park({ taskId: task.id, executionId, kind: 'question', prompt: 'second?', key: 'second' });
  store.respond('scope', second.itemId, 'two'); store.claim(Date.now());
  assert.equal(store.resumeDelivered({ taskId: task.id, executionId, itemId: first.itemId }), true);
  assert.equal(store.inboxItem(second.itemId).delivered_at, null);
  assert.equal(store.dueDispatch(Date.now()).some(row => row.id === task.id), true, 'the second response remains queued for resume');
});

test('a configured Task bundle cannot be selected as an ungoverned work-session child', () => {
  const legacy = loadWorkBlueprints(JSON.stringify({ review: { description: 'Review', instructions: 'Short.' } })).blueprints.get('review');
  const configured = { id: 'general', description: 'Task', role: 'task', legacy: false, revision: 'a'.repeat(64), tools: ['finish'] };
  const selectable = selectableWorkBlueprints(new Map([['review', legacy], ['general', configured]]));
  assert.deepEqual([...selectable.keys()], ['review']);
});

test('legacy text keeps its old revision and legacy executions finish without a workspace check', async () => {
  const id = 'review';
  const description = 'Review';
  const instructions = 'Review locally.';
  const legacy = loadWorkBlueprints(JSON.stringify({ [id]: { description, instructions } })).blueprints.get(id);
  assert.equal(legacy.revision, createHash('sha256').update(JSON.stringify([id, description, instructions])).digest('hex'));
  assert.equal(legacy.legacy, true);

  const store = openTaskStore(new DatabaseSync(':memory:'));
  const task = store.create({ owner: 'owner', agent: 'agent', scope: 'scope', originTurnId: 'turn', title: 'legacy', input: 'demo', finishRequired: false, key: 'legacy-create' });
  const executionId = store.claim(Date.now()).execution_id;
  const { data, get, commit } = docs();
  data.set('manolo.task-run:conv', { taskId: task.id, executionId });
  data.set(`manolo.task-execution:${task.id}`, { executionId, state: 'running' });
  let checks = 0;
  const tasks = installTasks(createRegistry(), {
    cfg: { relay: 'http://in-process.invalid', token: 'fixture' }, redact: text => text,
    taskGit: { checkFinish: async () => { checks++; throw Object.assign(new Error('missing worktree'), { code: 'worktree_missing' }); } },
  });
  tasks.attach({ snapshot: async (...args) => get(...args) });
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/finish')) return Response.json(store.acceptFinish({ taskId: task.id, ...JSON.parse(options.body), key: options.headers['idempotency-key'] }));
    if (path.endsWith('/state')) return Response.json({ status: 'running', executionId, finishAccepted: false });
    throw new Error(`unexpected ${path}`);
  };
  const result = await tasks.worker.tools.find(tool => tool.name === 'finish').execute({ summary: 'legacy done' }, { conversationId: 'conv', commit }, {});
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(checks, 0, 'a pre-upgrade execution with no workspace does not fail on a missing workspace record');
});

// --- Task handoff races: a block report and a dispatch retry can overlap, and a repaired execution can admit a new
// continuation while the previous watcher is still alive. Both are driven through the real tool module with a fake
// durable harness and a stub relay that records into a real ledger.

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function untilTrue(check, label, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(5);
  }
  assert.fail(`Timed out: ${label}`);
}

function taskRaceHarness({ store, scope = 'scope', finishRequired = false, workspaceLost = false } = {}) {
  const { data, get } = docs();
  // The child's final answer is read from its own assistant entry.
  const commit = async run => run({
    doc: async (...args) => get(...args),
    entry: async () => ({ conversationId: 'conv', model: [{ role: 'assistant', content: [{ type: 'text', text: 'from the child' }] }] }),
  });
  const task = store.create({
    owner: 'owner', agent: 'agent', scope, originTurnId: 'turn', title: 'race', input: 'do the work',
    finishRequired, key: `race-${Math.random()}`,
  });
  const { execution_id: executionId } = store.claim(Date.now());
  const submissions = new Map();
  const admitted = [];
  const newSubmission = id => {
    const wait = deferred();
    submissions.set(id, { wait: () => wait.promise, settle: wait.resolve });
    return submissions.get(id);
  };
  newSubmission('submission-0');
  const conversations = new Map([['conv', {
    admit: async (_tx, input) => {
      admitted.push(input.requestId);
      const id = `submission-${admitted.length}`;
      newSubmission(id);
      return id;
    },
  }]]);
  const submissionFor = id => submissions.get(id) ?? newSubmission(id);
  data.set(`manolo.task-execution:${task.id}`, {
    taskId: task.id, executionId, conversationId: 'conv', submissionId: 'submission-0', state: 'running',
    workspace: { kind: 'worktree', path: '/tmp/task-workspace' },
  });
  data.set('manolo.task-run:conv', { taskId: task.id, executionId, state: 'running' });
  data.set('manolo.task-index:all', { ids: [task.id] });
  const calls = { block: 0, settle: 0, state: 0, heartbeat: 0 };
  const controls = { lost: workspaceLost, holdBlock: undefined, refuseBlock: false };
  const relay = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (path.endsWith('/block')) {
      calls.block += 1;
      if (controls.refuseBlock) return new Response(null, { status: 503 });
      store.block(task.id, executionId, body.reason, Date.now(), 60_000);
      if (controls.holdBlock) await controls.holdBlock.promise;
      return Response.json({ ok: true });
    }
    if (path.endsWith('/state')) {
      calls.state += 1;
      const meta = store.meta(task.id);
      return Response.json({ status: meta.status, executionId: meta.executionId, finishAccepted: meta.finishAccepted });
    }
    if (path.endsWith('/heartbeat')) { calls.heartbeat += 1; return Response.json({ ok: true }); }
    if (path.endsWith('/settle')) {
      calls.settle += 1;
      const receipt = store.settle({
        taskId: task.id, executionId, outcome: body.outcome, summary: body.summary,
        deliveredItems: body.deliveredItems ?? [], key: options.headers['idempotency-key'],
      });
      return Response.json({ status: receipt.status });
    }
    throw new Error(`unexpected relay path ${path}`);
  };
  const tasks = installTasks(createRegistry(), {
    cfg: { relay: 'http://in-process.invalid', token: 'fixture' }, redact: text => text,
    settleRetryMs: [1], heartbeatMs: 5,
    taskGit: {
      assertWorkspace: async () => {
        if (controls.lost) throw Object.assign(new Error('The Task worktree is missing.'), { code: 'worktree_missing' });
        return {};
      },
    },
  });
  tasks.attach({
    snapshot: async (...args) => get(...args), commit,
    conversation: async id => conversations.get(id),
    submission: async id => submissionFor(id),
  });
  return {
    relay, controls, calls, admitted, submissionFor, tasks,
    taskId: task.id, executionId,
    document: () => data.get(`manolo.task-execution:${task.id}`),
    state: () => store.get(scope, task.id),
  };
}

test('a dispatch retry during a delayed block report is answered blocked, never running, and the Task still recovers', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store, workspaceLost: true });
  globalThis.fetch = race.relay;

  await race.tasks.start();
  // The relay persisted the block, but its reply is still in flight. The submission has already ended.
  const held = deferred();
  race.controls.holdBlock = held;
  race.submissionFor('submission-0').settle({ status: 'done', answer: 'ended', conversationId: 'conv' });
  await untilTrue(() => race.calls.block === 1, 'the block report reached the relay');
  await untilTrue(() => race.document().blockIntent !== undefined, 'the block intent is durable before the reply');
  assert.equal(race.document().state, 'running', 'the local state is not marked before the relay acknowledges');
  assert.equal(store.meta(race.taskId).blocked, 'The Task worktree is missing.');

  // A dispatch retry arrives in that window. Answering "running" would let the relay clear the retry obligation for a
  // submission that has already ended, leaving a local block behind with no relay obligation.
  const retry = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, task: { title: 'race', input: 'do it' } });
  assert.equal(retry.status, 'blocked', JSON.stringify(retry));
  assert.equal(race.document().state, 'blocked', 'the durable intent is promoted, not discarded');
  assert.equal(race.document().blockIntent, undefined);

  // The delayed acknowledgement lands after the promotion; it must not relabel anything or start work.
  held.resolve();
  await sleep(30);
  assert.equal(race.document().state, 'blocked');
  assert.equal(race.admitted.length, 0, 'no continuation ran while the workspace was still lost');

  // Restoring the workspace and driving the recorded retry continues the same execution and settles it once.
  race.controls.lost = false;
  store.db.prepare('UPDATE tasks SET next_at=0').run();
  const continued = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, task: { title: 'race', input: 'do it' } });
  assert.equal(continued.status, 'running', JSON.stringify(continued));
  assert.equal(race.admitted.length, 1);
  assert.equal(race.document().submissionId, 'submission-1');
  assert.equal(race.document().blockedReason, undefined);
  race.submissionFor('submission-1').settle({ status: 'done', answer: 'finished', conversationId: 'conv' });
  await untilTrue(() => race.state().status === 'done', 'the continued execution settles');
  assert.equal(race.calls.settle, 1);
  assert.equal(race.document().state, 'settled');
  assert.equal(race.state().outcome, 'from the child');
});

test('a continuation admitted before the old watcher tears down owns its own watcher and is never settled by the stale one', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store });
  globalThis.fetch = race.relay;

  // The old watcher is live on the first submission when the block is marked, exactly the window where it has not torn
  // down yet. The execution is blocked, so the next dispatch repairs it and admits a continuation.
  await race.tasks.start();
  race.document().state = 'blocked';
  race.document().blockedReason = 'The Task worktree is missing.';
  const repaired = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, task: { title: 'race', input: 'do it' } });
  assert.equal(repaired.status, 'running', JSON.stringify(repaired));
  assert.equal(race.admitted.length, 1, 'the repaired execution admits one continuation');
  assert.equal(race.document().submissionId, 'submission-1');

  // The stale result arrives afterwards. It belongs to the old submission and must not settle or downgrade the new one.
  race.submissionFor('submission-0').settle({ status: 'done', answer: 'stale final', conversationId: 'conv' });
  await sleep(40);
  assert.equal(race.calls.settle, 0, 'the stale watcher never settles the newer submission');
  assert.equal(race.state().status, 'running');

  // The continuation's own watcher finishes the Task.
  race.submissionFor('submission-1').settle({ status: 'done', answer: 'real finish', conversationId: 'conv' });
  await untilTrue(() => race.state().status === 'done', 'the continuation settles the Task');
  assert.equal(race.calls.settle, 1);
  assert.equal(race.state().outcome, 'from the child');
});

test('a restart re-reports a durable block intent whose acknowledgement was lost and never strands the execution', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store });
  race.controls.refuseBlock = true;
  globalThis.fetch = race.relay;

  // A previous process wrote the intent, then died before the relay recorded it.
  const document = race.document();
  document.blockIntent = { reason: 'worktree_missing', message: 'The Task worktree is missing.' };
  await race.tasks.start();
  assert.ok(race.calls.block >= 1, 'the restart replays the unacknowledged intent');
  assert.notEqual(document.blockIntent, undefined, 'a refused report keeps the intent durable');
  assert.equal(race.calls.settle, 0, 'no result is invented for the ended submission');

  // With the workspace back, a dispatch retry must not acknowledge this execution as running: it promotes the intent and
  // keeps the relay's obligation alive instead of clearing it.
  const retry = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, task: { title: 'race', input: 'do it' } });
  assert.equal(retry.status, 'blocked', JSON.stringify(retry));
  assert.equal(document.state, 'blocked');
  store.db.prepare('UPDATE tasks SET dispatch_pending=1, next_at=0').run();
  assert.equal(store.dueDispatch(Date.now()).length, 1, 'the ledger still owes a retry');

  // The next retry continues the same execution to a terminal outcome.
  const continued = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, task: { title: 'race', input: 'do it' } });
  assert.equal(continued.status, 'running', JSON.stringify(continued));
  race.submissionFor('submission-1').settle({ status: 'done', answer: 'finished after restart', conversationId: 'conv' });
  await untilTrue(() => race.state().status === 'done', 'the restarted execution settles');
  assert.equal(race.calls.settle, 1);
});
