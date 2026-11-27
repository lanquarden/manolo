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

function taskRaceHarness({ store, scope = 'scope', finishRequired = false, workspaceLost = false, blockRecoveryBackoffMs = [1] } = {}) {
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
    abort: async () => {},
  }]]);
  const submissionFor = id => submissions.get(id) ?? newSubmission(id);
  data.set(`manolo.task-execution:${task.id}`, {
    // The relay offers the versioned admission contract on every dispatch, so an execution that was admitted under this
    // worker has already negotiated it. A dispatch in a test negotiates the same way; the field is recorded here because
    // the fixture creates the record it would have written.
    taskId: task.id, executionId, conversationId: 'conv', submissionId: 'submission-0', state: 'running', run: 1, finishRequired,
    admission: 2,
    workspace: { kind: 'worktree', path: '/tmp/task-workspace' },
  });
  data.set('manolo.task-run:conv', { taskId: task.id, executionId, state: 'running' });
  data.set('manolo.task-index:all', { ids: [task.id] });
  const calls = { block: 0, settle: 0, state: 0, heartbeat: 0, workspace: 0, workspaceHeld: 0, cleanup: 0 };
  const controls = { lost: workspaceLost, holdBlock: undefined, refuseBlock: false, holdStateAt: undefined, holdState: undefined };
  const relay = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (path.endsWith('/block')) {
      calls.block += 1;
      if (controls.refuseBlock) return new Response(null, { status: 503 });
      store.block(task.id, executionId, body.reason, Date.now(), 60_000, { run: body.run, withdraw: body.withdrawn === true });
      if (controls.holdBlock) await controls.holdBlock.promise;
      return Response.json({ ok: true });
    }
    if (path.endsWith('/state')) {
      calls.state += 1;
      if (controls.holdStateAt === calls.state && controls.holdState) await controls.holdState.promise;
      const meta = store.meta(task.id);
      return Response.json({ status: meta.status, executionId: meta.executionId, finishAccepted: meta.finishAccepted });
    }
    if (path.endsWith('/heartbeat')) { calls.heartbeat += 1; return Response.json({ ok: true }); }
    if (path.endsWith('/settle')) {
      calls.settle += 1;
      // A settlement can be held after it was issued and before the ledger sees it: that is the window in which a recovery
      // can make a newer admission current, and the ledger must refuse the settlement that was already on the wire.
      if (controls.holdSettleAt === calls.settle && controls.settleGate) await controls.settleGate.promise;
      try {
        const receipt = store.settle({
          taskId: task.id, executionId, outcome: body.outcome, summary: body.summary,
          deliveredItems: body.deliveredItems ?? [], key: options.headers['idempotency-key'], run: body.run,
        });
        return Response.json({ status: receipt.status });
      } catch (error) {
        return Response.json({ error: 'Request rejected' }, { status: error.statusCode ?? 500 });
      }
    }
    throw new Error(`unexpected relay path ${path}`);
  };
  const tasks = installTasks(createRegistry(), {
    cfg: { relay: 'http://in-process.invalid', token: 'fixture' }, redact: text => text,
    settleRetryMs: [1], heartbeatMs: 5, blockRecoveryBackoffMs,
    taskGit: {
      assertWorkspace: async () => {
        // The workspace check is the asynchronous step a dispatch retry can be stalled in while the execution changes
        // underneath it: it is counted so a test can hold exactly one call and release it afterwards.
        calls.workspace += 1;
        if (controls.holdWorkspaceAt === calls.workspace && controls.workspaceGate) {
          calls.workspaceHeld += 1;
          await controls.workspaceGate.promise;
        }
        if (controls.lost) throw Object.assign(new Error('The Task worktree is missing.'), { code: 'worktree_missing' });
        return {};
      },
      cleanup: async () => { calls.cleanup += 1; return { removed: false }; },
    },
  });
  tasks.attach({
    snapshot: async (...args) => get(...args), commit,
    conversation: async id => conversations.get(id),
    submission: async id => submissionFor(id),
    // The Inbox wake the child's parked call is waiting on, resolved through the same durable run record the tool writes.
    signal: async (toolTaskId, _signal, itemId) => {
      const run = data.get('manolo.task-run:conv');
      if (toolTaskId !== run?.yielded || itemId !== run.itemId) throw new Error('wrong Inbox target');
      delete run.yielded;
      delete run.itemId;
      run.resumedItem = itemId;
      run.state = 'running';
      return 'delivered';
    },
  });
  return {
    relay, controls, calls, admitted, submissionFor, tasks,
    data, documentData: () => data.get('manolo.task-run:conv'),
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
  const retry = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, admission: 2, task: { title: 'race', input: 'do it' } });
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
  const continued = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, admission: 2, task: { title: 'race', input: 'do it' } });
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
  const repaired = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, admission: 2, task: { title: 'race', input: 'do it' } });
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
  const retry = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, admission: 2, task: { title: 'race', input: 'do it' } });
  assert.equal(retry.status, 'blocked', JSON.stringify(retry));
  assert.equal(document.state, 'blocked');
  store.db.prepare('UPDATE tasks SET dispatch_pending=1, next_at=0').run();
  assert.equal(store.dueDispatch(Date.now()).length, 1, 'the ledger still owes a retry');

  // The next retry continues the same execution to a terminal outcome.
  const continued = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, admission: 2, task: { title: 'race', input: 'do it' } });
  assert.equal(continued.status, 'running', JSON.stringify(continued));
  race.submissionFor('submission-1').settle({ status: 'done', answer: 'finished after restart', conversationId: 'conv' });
  await untilTrue(() => race.state().status === 'done', 'the restarted execution settles');
  assert.equal(race.calls.settle, 1);
});

// --- Release audit regressions -----------------------------------------------------------------------------------
// 1. A block intent whose report never reached the relay used to need a dispatch retry or a worker restart. A live
//    worker now keeps publishing it, so the relay regains its retry obligation without either.

test('an unacknowledged block intent recovers while the worker stays alive, without a restart', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store, blockRecoveryBackoffMs: [1] });
  globalThis.fetch = race.relay;
  const request = { taskId: race.taskId, executionId: race.executionId, admission: 2, task: { title: 'race', input: 'do it' } };

  await race.tasks.start();
  // The start acknowledgement was lost and the relay retried the dispatch. Its acknowledgement clears the only retry
  // obligation the relay had, and then the workspace disappears while the submission ends.
  const first = store.dueDispatch(Date.now())[0];
  assert.equal((await race.tasks.dispatch(request)).status, 'running');
  assert.equal(store.ackDispatch(race.taskId, race.executionId, first.dispatch_epoch), true);
  assert.equal(store.dueDispatch(Date.now()).length, 0, 'the acknowledgement cleared the relay retry');
  race.controls.refuseBlock = true;
  race.controls.lost = true;
  race.submissionFor('submission-0').settle({ status: 'done', answer: 'ended', conversationId: 'conv' });
  // The inline burst is exhausted past its old limit: every report failed, the intent is durable, and the relay has no
  // block and no retry obligation for this Task.
  await untilTrue(() => race.calls.block >= 6, 'the inline report burst is exhausted');
  assert.notEqual(race.document().blockIntent, undefined, 'the intent survives the failed burst');
  assert.equal(race.document().state, 'running');
  assert.equal(store.meta(race.taskId).blocked, null, 'the relay never learned about the block');
  assert.equal(store.dueDispatch(Date.now()).length, 0, 'the relay owes no retry yet');
  assert.equal(race.calls.settle, 0, 'no outcome is invented for the ended submission');

  // Transport comes back in the same process: no dispatch, no start(), no restart.
  race.controls.refuseBlock = false;
  const attempts = race.calls.block;
  await untilTrue(() => race.document().state === 'blocked', 'the driver publishes the durable intent');
  assert.equal(store.meta(race.taskId).blocked, 'The Task worktree is missing.', 'the relay records the block');
  assert.ok(race.calls.block > attempts);
  // The acknowledged intent is dropped: one publication per intent, and no duplicate obligation afterwards.
  const published = race.calls.block;
  await sleep(30);
  assert.equal(race.calls.block, published, 'no further report once the intent is promoted');
  assert.equal(store.meta(race.taskId).blocked, 'The Task worktree is missing.');
  assert.equal(store.dueDispatch(Date.now()).length, 0, 'the block schedules its own bounded retry');

  // The relay's recorded retry continues the same execution and settles it once.
  race.controls.lost = false;
  store.db.prepare('UPDATE tasks SET next_at=0').run();
  assert.equal(store.dueDispatch(Date.now()).length, 1);
  const continued = await race.tasks.dispatch({ taskId: race.taskId, executionId: race.executionId, admission: 2, task: { title: 'race', input: 'do it' } });
  assert.equal(continued.status, 'running', JSON.stringify(continued));
  assert.equal(race.document().submissionId, 'submission-1');
  assert.equal(race.admitted.length, 1, 'the recovery did not start a second execution');
  race.submissionFor('submission-1').settle({ status: 'done', answer: 'finished after recovery', conversationId: 'conv' });
  await untilTrue(() => race.state().status === 'done', 'the recovered execution settles');
  assert.equal(race.calls.settle, 1);
  assert.equal(race.state().outcome, 'from the child');
});

test('a cancelled Task stops the recovery driver instead of publishing a dead intent', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store, workspaceLost: true, blockRecoveryBackoffMs: [1] });
  race.controls.refuseBlock = true;
  globalThis.fetch = race.relay;

  await race.tasks.start();
  race.submissionFor('submission-0').settle({ status: 'done', answer: 'ended', conversationId: 'conv' });
  await untilTrue(() => race.document().blockIntent !== undefined, 'the intent is durable');
  assert.equal((await race.tasks.cancel({ taskId: race.taskId, executionId: race.executionId })).ok, true);
  assert.equal(race.document().state, 'cancelled');

  // A transport that comes back afterwards must not resurrect the block for a stopped Task.
  race.controls.refuseBlock = false;
  const attempts = race.calls.block;
  await sleep(40);
  assert.equal(race.calls.block, attempts, 'no block is published after cancellation');
  assert.equal(store.meta(race.taskId).blocked, null);
  assert.equal(race.calls.settle, 0, 'a cancellation is not a settlement');
});

// 2. A lost start ACK re-drives the dispatch inside the corrective handoff window. One submission must still have exactly
// one watcher: two owners raced into a block and a terminal failure for work that was live again.

test('a lost start ACK during the corrective handoff never installs a second watcher for one submission', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store, finishRequired: true });
  globalThis.fetch = race.relay;
  const request = { taskId: race.taskId, executionId: race.executionId, admission: 2, task: { title: 'race', input: 'do it' } };
  const outcome = { status: 'done', answer: 'bare result', conversationId: 'conv' };

  await race.tasks.start();
  race.submissionFor('submission-0').settle(outcome);
  await untilTrue(() => race.document().submissionId === 'submission-1', 'the first watcher admits its corrective');
  assert.equal(race.calls.state, 1);

  // The original start ACK was lost, so the relay retries the dispatch while the corrective handoff is in progress.
  const first = store.dueDispatch(Date.now())[0];
  assert.equal(first.id, race.taskId);
  assert.equal((await race.tasks.dispatch(request)).status, 'running');
  assert.equal(store.ackDispatch(race.taskId, race.executionId, first.dispatch_epoch), true);

  // The corrective ends without a finish exactly while the workspace is lost.
  race.controls.lost = true;
  race.submissionFor('submission-1').settle(outcome);
  await untilTrue(() => race.document().state === 'blocked', 'the corrective watcher reports its block');
  await sleep(20);
  assert.equal(race.calls.block, 1, 'one watcher reported for submission-1');
  assert.equal(race.calls.state, 2, 'one reconciliation read per finished submission');
  assert.equal(race.calls.settle, 0, 'the bare corrective final is not a settlement');

  // The relay retries the blocked dispatch and admits the continuation. The old watcher must never fail it afterwards.
  race.controls.lost = false;
  const blocked = store.dueDispatch(Date.now() + 60_000)[0];
  assert.equal(blocked.id, race.taskId);
  assert.equal((await race.tasks.dispatch(request)).status, 'running');
  assert.equal(store.ackDispatch(race.taskId, race.executionId, blocked.dispatch_epoch), true);
  assert.equal(race.document().submissionId, 'submission-2');
  await sleep(30);
  assert.equal(race.calls.settle, 0, 'no stale watcher settled the live continuation');
  assert.equal(race.state().status, 'running');

  // The continuation finishes normally and is the only settlement.
  store.acceptFinish({ taskId: race.taskId, executionId: race.executionId, summary: 'finished after recovery', key: 'finish-recovery', run: race.document().run });
  race.document().finishAccepted = true;
  race.document().finishSummary = 'finished after recovery';
  race.submissionFor('submission-2').settle(outcome);
  await untilTrue(() => race.state().status === 'done', 'the continuation settles the Task');
  assert.equal(race.calls.settle, 1);
  assert.equal(race.document().state, 'settled');
});

test('a stale watcher whose relay read resolves after a newer continuation never settles the Task', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store, finishRequired: true });
  globalThis.fetch = race.relay;
  race.controls.holdStateAt = 1;
  race.controls.holdState = deferred();

  await race.tasks.start();
  race.submissionFor('submission-0').settle({ status: 'done', answer: 'bare result', conversationId: 'conv' });
  await untilTrue(() => race.calls.state === 1, 'the stale watcher is inside its relay read');

  // A newer continuation becomes current while that read is still held. The watcher's snapshot is now stale, and only a
  // check after the yield prevents a terminal report for a Task that is live again.
  race.document().submissionId = 'submission-7';
  race.document().correctives = 1;
  race.controls.holdState.resolve();
  await sleep(40);
  assert.equal(race.calls.settle, 0, 'the stale watcher never settles the newer continuation');
  assert.equal(race.state().status, 'running');
  assert.equal(race.document().state, 'running');
});

// 3. A dispatch retry that stalls in its asynchronous workspace check used to reattach a watcher to a submission the
//    original watcher had already blocked and ended. The record is read again underneath the check, so the retry never
//    watches dead work and answers the relay truthfully about the block.

test('a dispatch retry stalled in the workspace check never reattaches to a submission a block already ended', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store });
  globalThis.fetch = race.relay;
  const request = { taskId: race.taskId, executionId: race.executionId, admission: 2, task: { title: 'race', input: 'do it' } };

  // The lost start acknowledgement makes the relay retry the dispatch while the first submission is still current.
  await race.tasks.start();
  const gate = deferred();
  race.controls.workspaceGate = gate;
  race.controls.holdWorkspaceAt = race.calls.workspace + 1;
  const retry = race.tasks.dispatch(request);
  await untilTrue(() => race.calls.workspace === race.controls.holdWorkspaceAt, 'the retry waits in the workspace check');

  // While it waits, the submission ends and the workspace disappears, so the original watcher blocks and exits.
  race.controls.lost = true;
  race.submissionFor('submission-0').settle({ status: 'unanswered', conversationId: 'conv' });
  await untilTrue(() => race.document().state === 'blocked', 'the original watcher reports its block');
  assert.equal(store.meta(race.taskId).blocked, 'The Task worktree is missing.');
  assert.equal(race.calls.workspaceHeld, 1, 'the retry is still inside its stalled check');

  // The workspace comes back before the stalled check returns. Reading that as a runnable execution would attach a
  // watcher to a submission that has already ended and report an outcome for the work it no longer owns.
  race.controls.lost = false;
  gate.resolve();
  const answer = await retry;
  assert.equal(answer.status, 'blocked', JSON.stringify(answer));
  assert.equal(race.document().submissionId, 'submission-0');
  assert.equal(race.document().run, 1, 'no admission is invented by a retry');
  // A watcher for the ended submission would report its outcome here; the retry attached none.
  await sleep(40);
  assert.equal(race.calls.settle, 0, 'no outcome is reported for the submission the block already ended');
  assert.equal(race.state().status, 'running', 'the ended submission is not allowed to end the Task');
  assert.equal(race.calls.cleanup, 0, 'no workspace is cleaned under the recovery obligation');
  assert.notEqual(store.meta(race.taskId).blocked, null, 'the relay keeps its retry obligation');

  // The relay's recorded retry admits the continuation, which is the only settlement.
  store.db.prepare('UPDATE tasks SET next_at=0').run();
  const epoch = store.db.prepare('SELECT dispatch_epoch FROM tasks WHERE id=?').get(race.taskId).dispatch_epoch;
  const continued = await race.tasks.dispatch(request);
  assert.equal(continued.status, 'running', JSON.stringify(continued));
  assert.equal(continued.run, 2);
  assert.equal(store.ackDispatch(race.taskId, race.executionId, epoch, undefined, continued.run), true);
  assert.equal(race.document().submissionId, 'submission-1');
  race.submissionFor('submission-1').settle({ status: 'done', answer: 'finished after the stalled retry', conversationId: 'conv' });
  await untilTrue(() => race.state().status === 'done', 'the recovered execution settles');
  assert.equal(race.calls.settle, 1);
  assert.equal(race.state().outcome, 'from the child');
});

// 4. The reviewer's ordering: a settlement is already on the wire when a newer recovery admission becomes current. No
//    local recheck can help (the report left the worker before the continuation existed), so the ledger itself refuses
//    it: it carries the admission it reports for, and the block and the continuation moved that fence forward.

test('a settlement already on the wire when a newer recovery admission becomes current is refused by the ledger', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store });
  globalThis.fetch = race.relay;
  const request = { taskId: race.taskId, executionId: race.executionId, admission: 2, task: { title: 'race', input: 'do it' } };
  const epoch = () => store.db.prepare('SELECT dispatch_epoch FROM tasks WHERE id=?').get(race.taskId).dispatch_epoch;

  // The first submission ends while the workspace is lost, so its watcher blocks and exits: admission 1 is withdrawn.
  await race.tasks.start();
  race.controls.lost = true;
  race.submissionFor('submission-0').settle({ status: 'unanswered', conversationId: 'conv' });
  await untilTrue(() => race.document().state === 'blocked', 'the watcher reports its block');
  assert.equal(store.meta(race.taskId).blocked, 'The Task worktree is missing.');
  assert.equal(race.document().run, 1);

  // A settlement for admission 1 is already on the wire before any of that became durable. It cannot be un-sent, and no
  // worker-side check can retract it, so the ledger is the layer that has to refuse it.
  const gate = deferred();
  race.controls.settleGate = gate;
  race.controls.holdSettleAt = race.calls.settle + 1;
  const inFlight = race.relay(`http://in-process.invalid/v1/tasks/${race.taskId}/settle`, {
    method: 'POST',
    headers: { 'idempotency-key': 'settle-stale-admission' },
    body: JSON.stringify({ executionId: race.executionId, outcome: 'failed', summary: 'The Task execution ended without an answer.', deliveredItems: [], run: 1 }),
  });
  await untilTrue(() => race.calls.settle === 1, 'the settlement is in flight');

  // The restored workspace makes the relay's recorded retry admit a continuation: admission 2 is now the current one.
  race.controls.lost = false;
  store.db.prepare('UPDATE tasks SET next_at=0').run();
  const continued = await race.tasks.dispatch(request);
  assert.equal(continued.status, 'running', JSON.stringify(continued));
  assert.equal(continued.run, 2);
  assert.equal(store.ackDispatch(race.taskId, race.executionId, epoch(), undefined, continued.run), true);
  assert.equal(race.document().submissionId, 'submission-1');
  assert.equal(race.document().run, 2);

  // Release the settlement for admission 1. The ledger refuses it, so the live continuation is never failed and the
  // workspace is not cleaned under it.
  gate.resolve();
  const refused = await inFlight;
  assert.equal(refused.status, 409, 'the ledger refuses an outcome for a withdrawn admission');
  await sleep(20);
  assert.equal(race.state().status, 'running', 'the stale settlement never fails the live Task');
  assert.equal(race.state().failure, undefined);
  assert.equal(race.document().state, 'running');
  assert.equal(race.calls.cleanup, 0, 'a refused settlement never cleans the workspace');

  // The continuation is the authority, and its own admission settles the Task.
  race.submissionFor('submission-1').settle({ status: 'done', answer: 'finished after the refused settlement', conversationId: 'conv' });
  await untilTrue(() => race.state().status === 'done', 'the continuation settles the Task');
  assert.equal(race.calls.settle, 2);
  assert.equal(race.state().outcome, 'from the child');
  assert.equal(race.document().state, 'settled');
});

// 5. The fence is a one-way contract: an accepted finish still settles from its own admission, a retired admission is
//    refused, an observation of a still-live submission keeps its authority, and a row that never negotiated the versioned
//    contract keeps completing from unversioned reports.

test('the admission fence settles an acknowledged finish, tells a withdrawal from an observation, and keeps legacy rows', () => {
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const fenceOf = taskId => store.db.prepare('SELECT run_fence, admission_contract FROM tasks WHERE id=?').get(taskId);
  const finished = taskFixture(store);
  store.acceptFinish({ taskId: finished.taskId, executionId: finished.executionId, summary: 'accepted', key: 'finish-admission', run: 1 });
  assert.equal(store.meta(finished.taskId).finishAccepted, true);
  // The acknowledged finish is the durable boundary, so its own settlement is accepted.
  assert.deepEqual(store.settle({ taskId: finished.taskId, executionId: finished.executionId, outcome: 'done', summary: 'accepted', key: 'settle-admission', run: 1 }), { status: 'done' });
  assert.equal(store.status(finished.taskId), 'done');

  // An observation reports a condition, not a retirement: the workspace is temporarily unavailable while the submission is
  // still live, so the run keeps the authority to settle once it is restored. It never lowers the fence either.
  const observed = taskFixture(store);
  assert.equal(store.block(observed.taskId, observed.executionId, 'The Task worktree is missing.', Date.now(), 60_000, { run: 1 }), true);
  assert.deepEqual([fenceOf(observed.taskId).run_fence, fenceOf(observed.taskId).admission_contract], [1, 2]);
  assert.deepEqual(store.settle({ taskId: observed.taskId, executionId: observed.executionId, outcome: 'failed', summary: 'same admission', key: 'settle-observation', run: 1 }), { status: 'failed' });

  // A retirement withdraws the admission that reported it: its settlement and its finish are refused, a runless result
  // cannot be attributed to the live one, and only a newer admission may end the Task.
  const retired = taskFixture(store);
  assert.equal(store.block(retired.taskId, retired.executionId, 'The Task worktree is missing.', Date.now(), 60_000, { run: 1, withdraw: true }), true);
  assert.equal(fenceOf(retired.taskId).run_fence, 2);
  assert.throws(() => store.settle({ taskId: retired.taskId, executionId: retired.executionId, outcome: 'failed', summary: 'stale', key: 'settle-fenced', run: 1 }), { statusCode: 409 });
  assert.equal(store.status(retired.taskId), 'running');
  assert.throws(() => store.acceptFinish({ taskId: retired.taskId, executionId: retired.executionId, summary: 'stale finish', key: 'finish-fenced', run: 1 }), { statusCode: 409 });
  assert.equal(store.meta(retired.taskId).finishAccepted, false);
  // A delayed result from before the takeover names no admission and cannot be attributed to the one that is live now.
  assert.throws(() => store.settle({ taskId: retired.taskId, executionId: retired.executionId, outcome: 'failed', summary: 'runless', key: 'settle-runless' }), { statusCode: 409 });
  assert.throws(() => store.acceptFinish({ taskId: retired.taskId, executionId: retired.executionId, summary: 'runless finish', key: 'finish-runless' }), { statusCode: 409 });
  assert.throws(() => store.park({ taskId: retired.taskId, executionId: retired.executionId, kind: 'question', prompt: 'again?', key: 'park-runless' }), { statusCode: 409 });
  assert.throws(() => store.park({ taskId: retired.taskId, executionId: retired.executionId, kind: 'question', prompt: 'again?', key: 'park-stale', run: 1 }), { statusCode: 409 });

  // A row that never negotiated the versioned contract keeps the older contract: a pre-upgrade worker's runless report
  // still settles it, so a mixed upgrade never strands a Task.
  const legacy = taskFixture(store);
  assert.deepEqual(store.settle({ taskId: legacy.taskId, executionId: legacy.executionId, outcome: 'failed', summary: 'legacy final', key: 'settle-legacy' }), { status: 'failed' });
  assert.equal(fenceOf(legacy.taskId).admission_contract, 0);
  const legacyFinish = taskFixture(store);
  assert.equal(store.acceptFinish({ taskId: legacyFinish.taskId, executionId: legacyFinish.executionId, summary: 'legacy finish', key: 'finish-legacy' }).accepted, true);
  assert.deepEqual(store.settle({ taskId: legacyFinish.taskId, executionId: legacyFinish.executionId, outcome: 'done', summary: 'legacy finish', key: 'settle-legacy-finish' }), { status: 'done' });

  // The superseded admission stays refused after the continuation is current, and the continuation settles from its own.
  const recovered = taskFixture(store);
  assert.equal(store.block(recovered.taskId, recovered.executionId, 'The Task worktree is missing.', Date.now(), 60_000, { run: 1, withdraw: true }), true);
  assert.throws(() => store.settle({ taskId: recovered.taskId, executionId: recovered.executionId, outcome: 'failed', summary: 'stale', key: 'settle-old-run', run: 1 }), { statusCode: 409 });
  assert.deepEqual(store.settle({ taskId: recovered.taskId, executionId: recovered.executionId, outcome: 'failed', summary: 'newer admission', key: 'settle-new-run', run: 2 }), { status: 'failed' });
});

// 6. The reviewer's ordering, end to end. A lost start acknowledgement makes the relay retry the dispatch while the
//    submission is still live; that retry cannot reach the workspace, and answering "blocked" used to be read as a
//    retirement. The fence then moved past the very admission that was still working, so the Inbox answer woke the same
//    run into a Task that refused its finish and its settlement: parked forever, with the relay owing no retry either.

test('a dispatch retry that only observes an unavailable workspace never retires the live run that later finishes', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store, finishRequired: true });
  const { taskId, executionId } = race;
  const request = { taskId, executionId, admission: 2, task: { title: 'race', input: 'do it' } };
  const settles = [];
  globalThis.fetch = async (...args) => {
    const result = await race.relay(...args);
    if (new URL(args[0]).pathname.endsWith('/settle')) settles.push(result.status);
    return result;
  };
  const row = () => store.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);

  await race.tasks.start();
  // The workspace is gone when the lost acknowledgement makes the relay retry the dispatch, and the submission is live.
  race.controls.lost = true;
  const refusal = await race.tasks.dispatch(request);
  assert.deepEqual([refusal.status, refusal.run, refusal.withdrawn], ['blocked', 1, false], 'observed, not retired');
  assert.equal(race.document().state, 'running', 'the execution keeps its live submission');
  assert.equal(race.document().blockIntent, undefined, 'no block intent is invented for a run that is still working');

  // The relay records the observation exactly as its scheduler does: a visible reason and a retry, no withdrawal.
  assert.equal(store.block(taskId, executionId, refusal.message, Date.now(), 60_000, {
    epoch: row().dispatch_epoch, run: refusal.run, withdraw: refusal.withdrawn === true,
  }), true);
  assert.equal(row().run_fence, 1, 'the live admission keeps its authority');
  assert.equal(row().admission_contract, 2, 'the observation recorded the negotiated contract');

  // The workspace comes back and the live run parks for one Inbox answer before the relay's next retry.
  race.controls.lost = false;
  const { itemId } = store.park({ taskId, executionId, kind: 'question', prompt: 'Proceed?', key: 'park', run: 1 });
  Object.assign(race.documentData(), { state: 'parked', yielded: 'inbox-tool', itemId });
  assert.equal(store.dueDispatch(Date.now()).length, 0, 'parking released the dispatch obligation');

  const resumed = (store.respond('scope', itemId, 'yes'), store.claim(Date.now()));
  const receipt = await race.tasks.resume({ taskId, executionId, itemId, status: 'answered', response: 'yes', admission: 2 });
  assert.equal(receipt.delivered, true, JSON.stringify(receipt));
  assert.equal(receipt.run, 1, 'the answer resumes the same admission');
  store.resumeDelivered({ taskId, executionId, itemId, epoch: resumed.dispatch_epoch, run: receipt.run });
  assert.ok(store.inboxItem(itemId).delivered_at, 'the answer reached the child');
  assert.equal(race.document().submissionId, 'submission-0');
  assert.equal(race.document().run, 1);

  // The same live run finishes: its finish and its settlement are accepted, and no continuation was ever admitted.
  assert.equal(store.acceptFinish({ taskId, executionId, run: 1, summary: 'finished after the workspace came back', key: 'actual-finish' }).accepted, true);
  Object.assign(race.document(), { finishAccepted: true, finishSummary: 'finished after the workspace came back' });
  race.submissionFor('submission-0').settle({ status: 'done', answer: 'finished', conversationId: 'conv' });
  await untilTrue(() => race.state().status === 'done', 'the same live run settles the Task');
  assert.deepEqual(settles, [200], 'the settlement of the live run was accepted, not refused');
  assert.equal(race.calls.settle, 1);
  assert.equal(race.admitted.length, 0, 'no continuation was invented for a live run');
  assert.equal(row().run_fence, 1);
  assert.equal(race.document().state, 'settled');
  assert.equal(race.state().outcome, 'finished after the workspace came back');
});

// 7. A genuinely live submission is still retired when it really ends, and a result from before that is refused. The
//    boundary between the two is the worker's own durable knowledge of whether the submission ended, not the scheduler's
//    reading of a temporary condition.

test('a retirement still fences the run it ends, while an observation leaves the same run able to settle', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store, workspaceLost: true });
  const { taskId, executionId } = race;
  globalThis.fetch = race.relay;
  const row = () => store.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);

  // The submission ends while the workspace is lost, so the execution is blocked and the published block retires run 1.
  await race.tasks.start();
  race.submissionFor('submission-0').settle({ status: 'unanswered', conversationId: 'conv' });
  await untilTrue(() => race.document().state === 'blocked', 'the watcher reports its block');
  assert.equal(row().run_fence, 2, 'a real retirement withdraws the admission that ended');

  // A result from that retired admission that was already on the wire is refused, whichever shape it has.
  assert.throws(() => store.settle({ taskId, executionId, outcome: 'failed', summary: 'stale', key: 'stale-run', run: 1 }), { statusCode: 409 });
  assert.throws(() => store.settle({ taskId, executionId, outcome: 'failed', summary: 'runless', key: 'stale-runless' }), { statusCode: 409 });
  assert.throws(() => store.acceptFinish({ taskId, executionId, summary: 'stale finish', key: 'stale-finish' }), { statusCode: 409 });
  assert.equal(store.status(taskId), 'running');

  // The dispatch retry continues the same execution from a newer admission, which settles it.
  race.controls.lost = false;
  store.db.prepare('UPDATE tasks SET next_at=0').run();
  const continued = await race.tasks.dispatch({ taskId, executionId, admission: 2, task: { title: 'race', input: 'do it' } });
  assert.equal(continued.status, 'running');
  assert.equal(continued.run, 2);
  race.submissionFor('submission-1').settle({ status: 'done', answer: 'finished', conversationId: 'conv' });
  await untilTrue(() => race.state().status === 'done', 'the continuation settles');
  assert.equal(race.state().outcome, 'from the child');
});

// 8. The versioned contract is marked on the row by the first versioned report, before it is applied. A finish that
//    arrives before the dispatch acknowledgement — because that acknowledgement was lost — still records it, so an older
//    message that names no admission can never be attributed to the admission that is live now.

test('a versioned finish that lands before the dispatch acknowledgement still refuses a later runless result', () => {
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const row = id => store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);

  const task = taskFixture(store);
  assert.equal(row(task.taskId).admission_contract, 0, 'a claimed row has not negotiated anything yet');
  // No acknowledgement ever landed: the finish itself is the first versioned report.
  assert.equal(store.acceptFinish({ taskId: task.taskId, executionId: task.executionId, summary: 'done', key: 'finish-before-ack', run: 1 }).accepted, true);
  assert.equal(row(task.taskId).admission_contract, 2);
  // A delayed result from an older message names no admission, so the ledger cannot attribute it and refuses it.
  assert.throws(() => store.settle({ taskId: task.taskId, executionId: task.executionId, outcome: 'failed', summary: 'old', key: 'runless-after-finish' }), { statusCode: 409 });
  // The finish's own admission is authoritative and still settles the Task.
  assert.deepEqual(store.settle({ taskId: task.taskId, executionId: task.executionId, outcome: 'done', summary: 'done', key: 'own-admission', run: 1 }), { status: 'done' });

  // A worker that never negotiates keeps writing the older shape and still completes a pre-upgrade execution.
  const legacy = taskFixture(store);
  assert.equal(store.acceptFinish({ taskId: legacy.taskId, executionId: legacy.executionId, summary: 'legacy finish', key: 'legacy-finish' }).accepted, true);
  assert.deepEqual(store.settle({ taskId: legacy.taskId, executionId: legacy.executionId, outcome: 'done', summary: 'legacy finish', key: 'legacy-settle' }), { status: 'done' });
  assert.equal(row(legacy.taskId).admission_contract, 0);

  // A fresh execution starts unnegotiated, so a relay that is rolled back before the worker still completes it, and the
  // first versioned acknowledgement records the contract without lowering a fence the row never had.
  const fresh = store.create({ owner: 'owner', agent: 'agent', scope: 'scope', originTurnId: 'turn', title: 'again', input: 'demo', key: 'again' });
  const claim = store.claim(Date.now());
  assert.deepEqual([claim.admission_contract, claim.run_fence], [0, 0]);
  assert.equal(store.ackDispatch(fresh.id, claim.execution_id, claim.dispatch_epoch, Date.now(), 1), true);
  assert.deepEqual([row(fresh.id).run_fence, row(fresh.id).admission_contract], [1, 2]);
  // A late acknowledgement that repeats an older admission never lowers a fence a takeover already moved.
  assert.equal(store.block(fresh.id, claim.execution_id, 'The Task worktree is missing.', Date.now(), 60_000, { run: 1, withdraw: true }), true);
  store.db.prepare('UPDATE tasks SET dispatch_pending=1, dispatch_epoch=dispatch_epoch+1 WHERE id=?').run(fresh.id);
  assert.equal(store.ackDispatch(fresh.id, claim.execution_id, row(fresh.id).dispatch_epoch, Date.now(), 1), true);
  assert.equal(row(fresh.id).run_fence, 2, 'the withdrawn admission is not reopened by a late acknowledgement');
});

// 9. A fenced mutation is never silently retried in a weaker legacy form. The relay refuses a settlement that names a
//    withdrawn admission, and the worker repeats exactly that report; it must not fall back to a runless shape that an
//    older relay would accept and that could end the live work the fence protects.

test('a refused versioned settlement is never retried without its admission', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = openTaskStore(new DatabaseSync(':memory:'));
  const race = taskRaceHarness({ store });
  const { taskId, executionId } = race;
  const bodies = [];
  globalThis.fetch = async (...args) => {
    const result = await race.relay(...args);
    if (new URL(args[0]).pathname.endsWith('/settle')) bodies.push(JSON.parse(args[1].body));
    return result;
  };
  const row = () => store.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);

  // Run 1 is retired before its watcher reports, so every settlement it sends names a withdrawn admission.
  assert.equal(store.block(taskId, executionId, 'The Task worktree is missing.', Date.now(), 60_000, { run: 1, withdraw: true }), true);
  assert.equal(row().run_fence, 2);
  await race.tasks.start();
  race.submissionFor('submission-0').settle({ status: 'unanswered', conversationId: 'conv' });
  await untilTrue(() => race.calls.settle === 2, 'the settlement retry budget is exhausted');
  assert.equal(bodies.length, 2);
  // Every attempt carries the admission it reports for, and no attempt drops it to slip past the fence.
  assert.deepEqual(bodies.map(body => body.run), [1, 1]);
  assert.equal(row().status, 'running', 'the Task is not failed by a fenced settlement');
  assert.equal(race.calls.cleanup, 0, 'a refused settlement never cleans the workspace');
  assert.equal(race.document().state, 'running', 'the execution stays live for a restart to reattach');
});
