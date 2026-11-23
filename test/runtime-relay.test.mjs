import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const token = 'a-private-test-worker-token-1234567890';
const other = 'a-different-test-worker-token-1234567890';
const password = 'owner-test-password-over-32-characters';
const testerPassword = 'different-tester-password-over-32-characters';
const basic = name => `Basic ${Buffer.from(`${name}:${name === 'owner' ? password : testerPassword}`).toString('base64')}`;
const tool = (name, args) => `fixture-tool:${JSON.stringify({ name, args })}`;
const randomKey = () => randomBytes(32).toString('base64url');

async function until(check, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(35);
  }
  assert.fail(`Timed out: ${label}`);
}

function launch(t, file, env, args = [], input) {
  const proc = spawn(process.execPath, [file, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdin.end(input);
  let logs = '';
  proc.stdout.on('data', data => { logs += data; });
  proc.stderr.on('data', data => { logs += data; });
  const exited = once(proc, 'close');
  t.after(async () => { proc.kill('SIGKILL'); await exited; });
  return {
    proc, exited, logs: () => logs,
    async port(pattern) {
      return until(() => {
        assert.equal(proc.exitCode, null, logs);
        return pattern.exec(logs)?.[1];
      }, pattern);
    },
    async stop() { proc.kill(); assert.deepEqual(await exited, [0, null], logs); },
  };
}

const post = (url, authorization, body) => fetch(url, {
  method: 'POST', signal: AbortSignal.timeout(12_000),
  headers: { authorization, 'content-type': 'application/json', 'x-manolo-request': '1' }, body: JSON.stringify(body),
});

function relayEnvironment(dir, config) {
  return { MANOLO_RELAY_CONFIG: config, MANOLO_DATA_DIR: join(dir, 'relay'), MANOLO_RUNTIME_AGENT: 'primary',
    PRIMARY: token, CANARY: other, OWNER: password, TESTER: testerPassword, PORT: '0', MANOLO_INTERNAL_PORT: '0', MANOLO_RUNTIME_PORT: '0' };
}

const relayConfig = (url, routes = []) => ({
  agents: { primary: { url, tokenEnv: 'PRIMARY' }, canary: { url, tokenEnv: 'CANARY' } },
  owners: { owner: { agent: 'primary', passwordEnv: 'OWNER' }, tester: { agent: 'canary', passwordEnv: 'TESTER' } },
  routes, inbox: [],
});

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'manolo-runtime-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('authenticated web turn executes on a paired machine, reconnects and revokes; pod bash remains local', { timeout: 30_000 }, async t => {
  const dir = await tempDir(t);
  // Reserve the relay's internal port while starting the worker. The worker does not contact it before a remote call.
  const { createServer } = await import('node:net');
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const internalPort = reservation.address().port;
  const internal = `http://127.0.0.1:${internalPort}`;
  const worker = launch(t, 'src/worker.mjs', { MANOLO_MODE: 'fixture', MANOLO_FIXTURE_INSPECT_SETUP: '1', MANOLO_FIXTURE_TOOLS: '1',
    MANOLO_DATA_DIR: join(dir, 'worker'), MANOLO_AGENT_ID: 'primary', MANOLO_AGENT_TOKEN: token,
    MANOLO_RELAY_URL: internal, PORT: '0' });
  const workerPort = await worker.port(/Manolo worker listening on (\d+)/);
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify(relayConfig(`http://127.0.0.1:${workerPort}`)));
  await new Promise(resolve => reservation.close(resolve));
  const startRelay = async () => {
    const proc = launch(t, 'src/relay.mjs', { ...relayEnvironment(dir, config), MANOLO_INTERNAL_PORT: String(internalPort) });
    const web = `http://127.0.0.1:${await proc.port(/web listening on .*:(\d+)/)}`;
    const device = `http://127.0.0.1:${await proc.port(/device listening on .*:(\d+)/)}`;
    return { proc, web, device };
  };
  let relay = await startRelay();
  const owner = basic('owner');
  const list = async () => (await (await fetch(`${relay.web}/api/runtimes`, { headers: { authorization: owner } })).json()).runtimes;
  const run = async (id, text) => {
    assert.equal((await post(`${relay.web}/api/turns`, owner, { id, text })).status, 200);
    return until(async () => {
      const response = await fetch(`${relay.web}/api/turns/${id}`, { headers: { authorization: owner } });
      const turn = await response.json();
      return turn.status !== 'pending' && turn;
    }, id);
  };
  const runtimeUrl = path => `${relay.device}/v1/runtime/${path}`;
  assert.equal((await post(`${relay.web}/api/runtimes/enroll`, basic('tester'), {})).status, 404);
  const off = await run('off', 'fixture:setup');
  assert.ok(!JSON.parse(off.text).tools.includes('runtime_exec'));
  const { code } = await (await post(`${relay.web}/api/runtimes/enroll`, owner, {})).json();
  const key = randomKey();
  const { id } = await (await post(runtimeUrl('enroll'), '', { code, name: 'beast-test', key })).json();
  const bearer = `Bearer ${key}`;
  assert.equal((await post(runtimeUrl('enroll'), '', { code, name: 'second', key: randomKey() })).status, 401);
  assert.equal((await post(runtimeUrl('poll'), owner, {})).status, 401);
  assert.equal((await post(internal + '/v1/runtime/execute', `Bearer ${other}`, {})).status, 403);
  assert.equal((await post(internal + '/v1/runtime/execute', `Bearer ${token}`, {
    turn: '0'.repeat(64), target: 'beast-test', command: 'hostname',
  })).status, 403);

  // Use a protocol client alongside the real worker and relay to control disconnect/revocation timing.
  const poll = () => post(runtimeUrl('poll'), bearer, {});
  await relay.proc.stop();
  relay = await startRelay();
  assert.deepEqual(await list(), [{ id, name: 'beast-test', online: false }]);
  let pending = poll();
  await until(async () => (await list())[0].online, 'paired runtime online after relay restart');
  const visible = await run('on', 'fixture:setup');
  assert.ok(JSON.parse(visible.text).tools.includes('runtime_exec'));
  const remote = run('remote', tool('runtime_exec', { target: 'beast-test', command: 'hostname' }));
  const { job } = await (await pending).json();
  assert.equal(job.command, 'hostname');
  assert.equal((await post(runtimeUrl('result'), bearer, { id: job.id, exitCode: 0, output: `${hostname()}\n`, timedOut: false })).status, 200);
  const turn = await remote;
  assert.equal(turn.text, 'Fixture tool succeeded');
  assert.match(turn.tools[0].output, new RegExp(`\\[beast-test\\].*\\n${hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const local = await run('local', tool('bash', { command: 'printf local-bash' }));
  assert.match(local.tools[0].output, /local-bash/);
  pending = poll();
  await until(async () => (await list())[0].online, 'second poll');
  const unknown = run('unknown', tool('runtime_exec', { target: 'beast-test', command: 'hostname', timeoutSeconds: 1 }));
  assert.equal((await (await pending).json()).job.command, 'hostname');
  const uncertain = await unknown;
  assert.equal(uncertain.text, 'Fixture tool failed');
  assert.match(JSON.stringify(uncertain.tools), /outcome unknown/i);
  pending = poll();
  await until(async () => (await list())[0].online, 'before revoke');
  assert.equal((await post(`${relay.web}/api/runtimes/${id}/revoke`, owner, {})).status, 200);
  assert.deepEqual(await (await pending).json(), { job: null });
  assert.equal((await poll()).status, 401);
  assert.ok(!JSON.parse((await run('revoked', 'fixture:setup')).text).tools.includes('runtime_exec'));

  // Exercise the shipped client through the same HTTP path. Its display name is intentionally not the OS hostname.
  const companionEnv = { MANOLO_RUNTIME_STATE: join(dir, 'companion'), MANOLO_RUNTIME_ALLOW_LOOPBACK_HTTP: '1' };
  const secondCode = (await (await post(`${relay.web}/api/runtimes/enroll`, owner, {})).json()).code;
  const paired = launch(t, 'src/runtime-companion.mjs', companionEnv, ['pair', relay.device, 'local-companion'], `${secondCode}\n`);
  assert.deepEqual(await paired.exited, [0, null], paired.logs());
  const companion = launch(t, 'src/runtime-companion.mjs', companionEnv, ['run']);
  await until(async () => (await list())[0].online, 'real companion online');
  const real = await run('real', tool('runtime_exec', { target: 'local-companion', command: 'hostname' }));
  assert.equal(real.text, 'Fixture tool succeeded');
  assert.equal(real.tools[0].output.trim(), `[local-companion] exit status 0\n${hostname()}`);
  await companion.stop();
  await until(async () => !(await list())[0].online, 'real companion went offline');
  await worker.stop();
  await relay.proc.stop();
});

test('relay refuses unattended runtime with demo credentials or a chat-routed agent', async t => {
  const dir = await tempDir(t);
  const config = join(dir, 'unsafe.json');
  await writeFile(config, JSON.stringify(relayConfig('http://127.0.0.1:4321')));
  const env = relayEnvironment(dir, config);
  const demo = launch(t, 'src/relay.mjs', { ...env, MANOLO_DEMO: '1' });
  assert.deepEqual(await demo.exited, [1, null]);
  assert.match(demo.logs(), /non-demo authentication and must be web-only/);
  await writeFile(config, JSON.stringify(relayConfig('http://127.0.0.1:4321', [
    { transport: 'telegram', userId: '123', chatId: '123', agent: 'primary' },
  ])));
  const chat = launch(t, 'src/relay.mjs', env);
  assert.deepEqual(await chat.exited, [1, null]);
  assert.match(chat.logs(), /non-demo authentication and must be web-only/);
});
