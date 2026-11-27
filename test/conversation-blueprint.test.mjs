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

  child.kill('SIGKILL');
  await closed;
  assert.doesNotMatch(log, /Unhandled|AssertionError|startup failed/);
});
