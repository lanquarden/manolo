import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseRemoteEnvs } from '../src/remote-env.mjs';

const workerPath = fileURLToPath(new URL('../src/worker.mjs', import.meta.url));
const token = 'remote-env-bearer-long-enough-for-tests';
const auth = { authorization: `Bearer ${token}` };

test('remote environments are validated before any connection is attempted', () => {
  const targets = parseRemoteEnvs(JSON.stringify({
    beast: { kind: 'ssh', host: 'beast', user: 'lanquarden', cwd: '/home/lanquarden', knownHostsFile: '/data/ssh/known_hosts' },
    sandbox: { kind: 'local', cwd: '/tmp/sandbox' },
  }), {});
  assert.deepEqual([...targets.keys()], ['beast', 'sandbox']);
  assert.equal(targets.get('beast').hostKeyAlias, 'manolo-beast');
  assert.equal(targets.get('beast').port, 22);
  assert.equal(targets.get('sandbox').kind, 'local');
  assert.equal(parseRemoteEnvs('', {}).size, 0);
  assert.equal(parseRemoteEnvs(undefined, {}).size, 0);

  for (const bad of [
    'not json',
    '[]',
    '{"Bad":{}}',
    '{"a":{"kind":"telnet","cwd":"/x"}}',
    '{"a":{"kind":"local","cwd":"relative"}}',
    '{"a":{"kind":"ssh","host":"h","cwd":"/x"}}',
    '{"a":{"kind":"ssh","host":"h","cwd":"/x","knownHostsFile":"relative"}}',
    '{"a":{"kind":"ssh","host":"h","cwd":"/x","knownHostsFile":"/k","port":0}}',
    '{"a":{"kind":"ssh","host":"h","cwd":"/x","knownHostsFile":"/k","user":"${MISSING}"}}',
  ]) {
    assert.throws(() => parseRemoteEnvs(bad, {}), undefined, bad);
  }
});

async function dataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'manolo-remote-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function launch(t, dir, options = {}) {
  const child = spawn(process.execPath, [workerPath], {
    env: {
      MANOLO_DATA_DIR: dir, MANOLO_MODE: 'fixture', MANOLO_AGENT_ID: 'test-manolo', MANOLO_AGENT_TOKEN: token,
      PORT: '0', ...options,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  t.after(() => { child.kill('SIGKILL'); return closed; });
  return {
    logs: () => stdout + stderr,
    async start() {
      for (let attempt = 0; attempt < 400; attempt++) {
        assert.equal(child.exitCode, null, stdout + stderr);
        const port = /Manolo worker listening on (\d+)/.exec(stdout)?.[1];
        if (port) return `http://127.0.0.1:${port}`;
        await sleep(25);
      }
      assert.fail(`Worker did not listen: ${stdout}${stderr}`);
    },
  };
}

async function request(url, path, options) {
  const response = await fetch(url + path, { signal: AbortSignal.timeout(30_000), ...options });
  return { status: response.status, body: await response.json() };
}

async function until(check, label) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await check();
    if (result) return result;
    await sleep(25);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function toolTurn(url, id, session, name, args) {
  const started = await request(url, `/v1/turns/${id}`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session, text: `fixture-tool:${JSON.stringify({ name, args })}` }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const body = await until(async () => {
    const poll = await request(url, `/v1/turns/${id}`, { headers: auth });
    assert.equal(poll.status, 200);
    if (poll.body.status !== 'pending') return poll.body;
  }, `terminal turn ${id}`);
  assert.equal(body.status, 'done', JSON.stringify(body));
  const tool = body.tools?.find(each => each.name === name);
  assert.ok(tool, JSON.stringify(body));
  return tool;
}

test('a conversation can move its file and shell tools onto another machine and back', { timeout: 120_000 }, async t => {
  const dir = await dataDir(t);
  const remote = await mkdtemp(join(tmpdir(), 'manolo-remote-machine-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  const relay = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); return new Promise(resolve => relay.close(resolve)); });

  // A `local` target reaches a daemon over a pipe instead of SSH: the same RemoteExecutionEnv code path, no network.
  const worker = launch(t, dir, {
    MANOLO_RELAY_URL: `http://127.0.0.1:${relay.address().port}`, MANOLO_FIXTURE_TOOLS: '1',
    MANOLO_REMOTE_ENVS: JSON.stringify({ sandbox: { kind: 'local', cwd: remote } }),
  });
  const url = await worker.start();

  const listed = await toolTurn(url, 'list', 'remote', 'workspace_targets', {});
  assert.equal(listed.status, 'ok', listed.output);
  assert.match(listed.output, /^pod \*$/m);
  assert.match(listed.output, new RegExp(`  sandbox \\(local\\) ${remote}`));

  // Before the switch, the pod is the environment: a write lands in the worker's workspace.
  await toolTurn(url, 'pod-write', 'remote', 'write', { path: 'pod-only.txt', content: 'in the pod' });
  assert.equal(await readFile(join(dir, 'workspace', 'pod-only.txt'), 'utf8'), 'in the pod');

  const moved = await toolTurn(url, 'use', 'remote', 'workspace_target', { name: 'sandbox' });
  assert.equal(moved.status, 'ok', moved.output);
  assert.match(moved.output, /sandbox/);

  // The same tools now run through the daemon: pwd is the target's cwd and the write lands there, not in the pod.
  const pwd = await toolTurn(url, 'pwd', 'remote', 'bash', { command: 'pwd' });
  assert.equal(pwd.status, 'ok', pwd.output);
  assert.match(pwd.output, new RegExp(`^${remote}$`, 'm'));
  const written = await toolTurn(url, 'remote-write', 'remote', 'write', { path: 'on-the-machine.txt', content: 'over there' });
  assert.equal(written.status, 'ok', written.output);
  assert.equal(await readFile(join(remote, 'on-the-machine.txt'), 'utf8'), 'over there');
  const readBack = await toolTurn(url, 'remote-read', 'remote', 'read', { path: 'on-the-machine.txt' });
  assert.equal(readBack.status, 'ok', readBack.output);
  assert.match(readBack.output, /over there/);
  await assert.rejects(readFile(join(dir, 'workspace', 'on-the-machine.txt'), 'utf8'));

  // The choice is durable and per conversation: a second session still starts in the pod.
  const other = await toolTurn(url, 'other', 'other-session', 'workspace_targets', {});
  assert.match(other.output, /^pod \*$/m);

  const back = await toolTurn(url, 'back', 'remote', 'workspace_target', { name: 'pod' });
  assert.equal(back.status, 'ok', back.output);
  const podPwd = await toolTurn(url, 'pod-pwd', 'remote', 'bash', { command: 'pwd' });
  assert.match(podPwd.output, /workspace$/m);

  assert.equal(await readFile(join(dir, 'workspace', 'on-the-machine.txt'), 'utf8').then(() => 'present', () => 'absent'), 'absent');
});

test('an unknown target is refused by the tool and by startup configuration', { timeout: 30_000 }, async t => {
  const dir = await dataDir(t);
  const relay = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); return new Promise(resolve => relay.close(resolve)); });
  const worker = launch(t, dir, {
    MANOLO_RELAY_URL: `http://127.0.0.1:${relay.address().port}`, MANOLO_FIXTURE_TOOLS: '1',
    MANOLO_REMOTE_ENVS: JSON.stringify({ sandbox: { kind: 'local', cwd: dir } }),
  });
  const url = await worker.start();
  const refused = await toolTurn(url, 'nope', 's', 'workspace_target', { name: 'elsewhere' });
  assert.equal(refused.status, 'error');
  assert.match(refused.output, /Unknown workspace target/);

  const broken = launch(t, await dataDir(t), { MANOLO_REMOTE_ENVS: '{"sandbox":{"kind":"local","cwd":"relative"}}' });
  await assert.rejects(broken.start(), /must be an absolute path/);
});
