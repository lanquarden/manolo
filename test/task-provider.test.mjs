import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkerModels, resolveProfiles } from '../src/worker-runtime.mjs';
import { installTasks } from '../src/task-tools.mjs';
import { sealBlueprintSnapshot } from '../src/work-blueprints.mjs';
import { openTaskStore } from '../src/task-store.mjs';

const durable = name => import(pathToFileURL(join(import.meta.dirname, `../node_modules/@earendil-works/pi-durable/dist/${name}`)));
const { BACKGROUND_CONTEXT: context } = await import(pathToFileURL(join(import.meta.dirname, '../node_modules/@earendil-works/chord/dist/context/index.js')));
const { createRegistry, defineExtension, defineTool, Harness } = await durable('index.js');
const { MemoryStorage } = await durable('storage/memory.js');

test('the selected profile reaches the model request and explicitly listed deferred tools are callable', async t => {
  const cfg = { mode: 'fixture', relay: 'http://in-process.invalid', token: 'fixture' };
  const { models, model } = await createWorkerModels(cfg, {}, ['fixture-deep']);
  const deep = { id: 'deep', description: 'Fixture model', model: 'fixture-deep', thinkingLevel: 'high' };
  const profiles = resolveProfiles({ models, model, profiles: new Map([['deep', deep]]) });
  let deferredCalled = false;
  const deferred = defineExtension({
    name: 'deferred-fixture',
    tools: [defineTool({
      name: 'deferred_fixture', deferred: true, callers: ['model'], replay: 'safe', description: 'Deferred test tool',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => { deferredCalled = true; return { output: [{ type: 'text', text: 'Called' }] }; },
    })],
  });
  const registry = createRegistry();
  registry.install(deferred);
  const tasks = installTasks(registry, { cfg, model, models, profiles, redact: text => text });
  const harness = await Harness.open(new MemoryStorage(), {
    models, registry,
    settings: () => ({ extensions: [deferred], followUpMode: 'one-at-a-time', retry: { baseDelayMs: 1 } }),
  }, context);
  tasks.attach(harness);
  harness.resume();
  const store = openTaskStore(new DatabaseSync(':memory:'));
  t.after(() => harness.close(context));
  try {
    for (const [directive, expected] of [
      ['fixture:finish', 'selected:fixture-deep:high'],
      ['fixture-tool:{"name":"deferred_fixture","args":{}}', 'Fixture tool succeeded'],
    ]) {
      const assignment = store.create({ owner: 'owner', agent: 'agent', scope: 'scope', originTurnId: 'turn', title: 'probe', input: directive });
      const { execution_id: executionId } = store.claim(Date.now());
      const snapshot = sealBlueprintSnapshot({
        id: 'general', role: 'task', description: 'probe', instructions: 'probe', profile: deep,
        tools: ['deferred_fixture', 'report_progress', 'post_inbox', 'finish'], files: [],
      });
      const settled = Promise.withResolvers();
      globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname;
        const body = options.body ? JSON.parse(options.body) : {};
        if (path.endsWith('/state')) return Response.json({ status: 'running', executionId, finishAccepted: false });
        if (path.endsWith('/finish')) return Response.json(store.acceptFinish({ taskId: assignment.id, key: options.headers['idempotency-key'], ...body }));
        if (path.endsWith('/settle')) {
          const receipt = store.settle({ taskId: assignment.id, key: options.headers['idempotency-key'], ...body });
          settled.resolve(body);
          return Response.json(receipt);
        }
        if (path.endsWith('/heartbeat')) return Response.json({ ok: true });
        throw new Error(`unexpected ${path}`);
      };
      assert.deepEqual(await tasks.dispatch({
        taskId: assignment.id, executionId,
        task: { protocol: 2, finishRequired: true, title: 'probe', input: directive, blueprint: { id: 'general', revision: snapshot.revision, snapshot } },
      }), { status: 'running' });
      const result = await settled.promise;
      assert.equal(result.outcome, 'done');
      assert.equal(result.summary, expected);
    }
    assert.equal(deferredCalled, true, 'a deferred tool named by the Blueprint is actually offered through modelTools');

    // A pinned provider identity that does not match the reachable catalog is refused, not substituted.
    const bad = store.create({ owner: 'owner', agent: 'agent', scope: 'scope', originTurnId: 'turn', title: 'mismatch', input: 'fixture:finish' });
    const badExecution = store.claim(Date.now()).execution_id;
    const mismatched = sealBlueprintSnapshot({
      id: 'general', role: 'task', description: 'probe', instructions: 'probe',
      profile: { id: 'deep', description: 'Other provider', provider: 'another-provider', model: 'fixture-deep', thinkingLevel: 'high' },
      tools: ['report_progress', 'post_inbox', 'finish'], files: [],
    });
    await assert.rejects(tasks.dispatch({
      taskId: bad.id, executionId: badExecution,
      task: { protocol: 2, finishRequired: true, title: 'mismatch', input: 'fixture:finish',
        blueprint: { id: 'general', revision: mismatched.revision, snapshot: mismatched } },
    }), error => error.status === 409 && error.reason === 'profile_unavailable');
  } finally {
    await harness.close(context);
  }
});
