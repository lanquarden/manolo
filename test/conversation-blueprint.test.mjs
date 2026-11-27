import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const cwd = new URL('../', import.meta.url);
const token = randomBytes(24).toString('hex');

async function until(check, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`Timed out: ${label}`);
}

test('the conversation Blueprint is reapplied each turn, retries keep the old selection, and exact tools are real', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-conversation-blueprint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundles = join(root, 'bundles');
  await mkdir(bundles, { recursive: true });
  await writeFile(join(bundles, 'CONVERSATION.md'), 'CONVERSATION-MARKER-ONE\n');
  const manifest = {
    version: 1,
    profiles: { conv: { description: 'Conversation profile', model: 'fixture-conv', thinkingLevel: 'high' } },
    blueprints: {
      main: { description: 'Main conversation', role: 'conversation', profile: 'conv', files: ['CONVERSATION.md'], tools: ['read'] },
    },
  };
  await writeFile(join(bundles, 'manifest.json'), JSON.stringify(manifest));
  const child = spawn(process.execPath, ['src/worker.mjs'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, MANOLO_AGENT_ID: 'canary', MANOLO_AGENT_TOKEN: token,
      MANOLO_DATA_DIR: join(root, 'data'), MANOLO_MODE: 'fixture', MANOLO_FIXTURE_INSPECT_SETUP: '1',
      MANOLO_BLUEPRINTS_DIR: bundles, PORT: '0',
    },
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const closed = once(child, 'exit');
  const port = await until(() => {
    assert.equal(child.exitCode, null, log);
    return Number(/worker listening on (\d+)/.exec(log)?.[1]) || null;
  }, 'worker listener');
  const url = `http://127.0.0.1:${port}`;
  const put = async (id, text) => {
    const response = await fetch(`${url}/v1/turns/${id}`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session', text }), signal: AbortSignal.timeout(5000),
    });
    assert.ok([200, 202].includes(response.status), await response.clone().text());
  };
  const get = id => until(async () => {
    const response = await fetch(`${url}/v1/turns/${id}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json();
    return body.status === 'done' && body;
  }, `turn ${id}`);

  await put('first', 'fixture:model');
  const first = await get('first');
  assert.deepEqual(JSON.parse(first.text), { model: 'fixture-conv', reasoning: 'high' });

  await put('tools', 'fixture:setup');
  const tools = JSON.parse((await get('tools')).text);
  assert.deepEqual(tools.tools, ['read'], 'only the explicit conversation tools are offered');

  await writeFile(join(bundles, 'CONVERSATION.md'), 'CONVERSATION-MARKER-TWO\n');
  await put('instructions', 'fixture:instructions');
  assert.match((await get('instructions')).text, /CONVERSATION-MARKER-TWO/);
  // A retry of an admitted turn keeps the settings and answer it was admitted with, even after the manifest edit.
  await put('first', 'fixture:model');
  assert.deepEqual(JSON.parse((await get('first')).text), { model: 'fixture-conv', reasoning: 'high' });

  manifest.profiles.conv.thinkingLevel = 'low';
  await writeFile(join(bundles, 'manifest.json'), JSON.stringify(manifest));
  await put('second', 'fixture:model');
  assert.deepEqual(JSON.parse((await get('second')).text), { model: 'fixture-conv', reasoning: 'low' });

  // Removing the optional tool list resets the conversation to the worker's default selection instead of keeping the
  // previous explicit list, and an explicit empty list remains a valid exact selection.
  delete manifest.blueprints.main.tools;
  await writeFile(join(bundles, 'manifest.json'), JSON.stringify(manifest));
  await put('reset-tools', 'fixture:setup');
  const defaults = JSON.parse((await get('reset-tools')).text);
  assert.notDeepEqual(defaults.tools, ['read'], 'an omitted list clears the previous exact tools');
  assert.ok(defaults.tools.includes('read') && defaults.tools.includes('bash'), 'the worker default tool set applies');
  assert.ok(!defaults.tools.includes('create_task'), 'orchestration stays opt-in per turn');
  manifest.blueprints.main.tools = [];
  await writeFile(join(bundles, 'manifest.json'), JSON.stringify(manifest));
  await put('empty-tools', 'fixture:setup');
  assert.deepEqual(JSON.parse((await get('empty-tools')).text).tools, [], 'an explicit empty list offers no tools');

  // Removing the profile clears the reasoning level instead of leaving the previous one in place.
  delete manifest.blueprints.main.profile;
  await writeFile(join(bundles, 'manifest.json'), JSON.stringify(manifest));
  await put('reset-model', 'fixture:model');
  assert.deepEqual(JSON.parse((await get('reset-model')).text), { model: 'fixture', reasoning: null });
  // The retry of an already admitted turn still keeps what it was admitted with.
  await put('second', 'fixture:model');
  assert.deepEqual(JSON.parse((await get('second')).text), { model: 'fixture-conv', reasoning: 'low' });

  child.kill('SIGKILL');
  await closed;
  assert.doesNotMatch(log, /Unhandled|AssertionError|startup failed/);
});

test('removing the whole conversation Blueprint restores the worker default model and reasoning level', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-conversation-removal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundles = join(root, 'bundles');
  await mkdir(bundles, { recursive: true });
  await writeFile(join(bundles, 'CONVERSATION.md'), 'CONVERSATION-MARKER\n');
  const manifest = {
    version: 1,
    profiles: { conv: { description: 'Conversation profile', model: 'fixture-conv', thinkingLevel: 'low' } },
    blueprints: {
      main: { description: 'Main conversation', role: 'conversation', profile: 'conv', files: ['CONVERSATION.md'] },
      general: { description: 'Generic Task', role: 'task', files: ['CONVERSATION.md'], tools: ['report_progress', 'post_inbox', 'finish'] },
    },
  };
  await writeFile(join(bundles, 'manifest.json'), JSON.stringify(manifest));
  const child = spawn(process.execPath, ['src/worker.mjs'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, MANOLO_AGENT_ID: 'canary', MANOLO_AGENT_TOKEN: token,
      MANOLO_DATA_DIR: join(root, 'data'), MANOLO_MODE: 'fixture', MANOLO_THINKING_LEVEL: 'high',
      MANOLO_BLUEPRINTS_DIR: bundles, PORT: '0',
    },
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const closed = once(child, 'exit');
  const port = await until(() => {
    assert.equal(child.exitCode, null, log);
    return Number(/worker listening on (\d+)/.exec(log)?.[1]) || null;
  }, 'worker listener');
  const url = `http://127.0.0.1:${port}`;
  const put = async (sessionId, id, text) => {
    const response = await fetch(`${url}/v1/turns/${id}`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text }), signal: AbortSignal.timeout(5000),
    });
    assert.ok([200, 202].includes(response.status), await response.clone().text());
  };
  const model = async id => {
    const body = await until(async () => {
      const response = await fetch(`${url}/v1/turns/${id}`, { headers: { authorization: `Bearer ${token}` } });
      const value = await response.json();
      return value.status === 'done' && value;
    }, `turn ${id}`);
    return JSON.parse(body.text);
  };

  await put('session', 'blueprint', 'fixture:model');
  assert.deepEqual(await model('blueprint'), { model: 'fixture-conv', reasoning: 'low' });

  // The whole conversation Blueprint is removed while its manifest stays valid. The admitted selection does not linger:
  // the conversation returns to this worker's own defaults, not to "no reasoning level".
  delete manifest.blueprints.main;
  await writeFile(join(bundles, 'manifest.json'), JSON.stringify(manifest));
  await put('session', 'removed', 'fixture:model');
  assert.deepEqual(await model('removed'), { model: 'fixture', reasoning: 'high' });
  // A fresh chat in the same state sees the same worker defaults.
  await put('fresh', 'fresh', 'fixture:model');
  assert.deepEqual(await model('fresh'), { model: 'fixture', reasoning: 'high' });
  // A retry of the already admitted turn keeps the selection it was admitted with.
  await put('session', 'blueprint', 'fixture:model');
  assert.deepEqual(await model('blueprint'), { model: 'fixture-conv', reasoning: 'low' });

  child.kill('SIGKILL');
  await closed;
  assert.doesNotMatch(log, /Unhandled|AssertionError|startup failed/);
});
