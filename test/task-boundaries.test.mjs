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
