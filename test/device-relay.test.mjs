import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const issuer = 'fixture-issuer';
const audience = 'manolo-device-api';
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const key = 'opaque-fixture-worker-token-0000000000';
const password = 'opaque-fixture-owner-password-0000000000';

test('device listener holds a separate durable queue and does not accept browser authentication', { timeout: 11000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'manolo-device-integration-'));
  let workerInput;
  const worker = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    workerInput = JSON.parse(Buffer.concat(chunks));
    res.end(JSON.stringify({ status: 'done', text: 'device reply' }));
  }).listen(0, '127.0.0.1');
  await once(worker, 'listening');
  t.after(() => { worker.closeAllConnections(); worker.close(); });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const relayConfig = join(dir, 'relay.json');
  const devices = join(dir, 'devices.json');
  await writeFile(relayConfig, JSON.stringify({
    agents: { pilot: { url: `http://127.0.0.1:${worker.address().port}`, tokenEnv: 'TEST_TOKEN' } },
    owners: { owner: { agent: 'pilot', passwordEnv: 'TEST_PASSWORD' } }, routes: [], inbox: [],
  }));
  await writeFile(devices, JSON.stringify({ issuer, audience, keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture' }],
    grants: { tablet: { pilot: ['submit', 'get'] }, laptop: { pilot: ['get'] } } }));
  const child = spawn(process.execPath, ['src/relay.mjs'], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, MANOLO_RELAY_CONFIG: relayConfig, MANOLO_DEVICE_CONFIG: devices, MANOLO_DATA_DIR: dir,
      PORT: '0', MANOLO_INTERNAL_PORT: '0', MANOLO_DEVICE_PORT: '0', TEST_TOKEN: key, TEST_PASSWORD: password },
  });
  const exited = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await exited; await rm(dir, { recursive: true, force: true }); });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  async function until(check) {
    for (let i = 0; i < 80; i++) {
      assert.equal(child.exitCode, null, logs);
      const result = await check();
      if (result) return result;
      await sleep(45);
    }
    assert.fail(logs);
  }
  const ports = await until(() => {
    const web = /web listening on .*:(\d+)/.exec(logs)?.[1];
    const device = /.*device.* listening on .*:(\d+)/i.exec(logs)?.[1];
    return web && device && { web, device };
  });
  const on = (role, path, authorization, body) => fetch(`http://127.0.0.1:${ports[role]}${path}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(1500),
    headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const jwt = sub => {
    const msg = `${b64({ alg: 'EdDSA', kid: 'fixture' })}.${b64({ iss: issuer, aud: audience, sub, exp: Math.floor(Date.now() / 1000) + 60 })}`;
    return `Bearer ${msg}.${sign(null, Buffer.from(msg), privateKey).toString('base64url')}`;
  };
  const basic = `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;
  const submit = '/v1/agents/pilot/turns';
  assert.equal((await on('device', '/healthz', basic)).status, 401);
  assert.equal((await on('device', submit, basic, { id: 't1', text: 'no' })).status, 401);
  assert.equal((await on('device', submit, jwt('laptop'), { id: 't1', text: 'no' })).status, 403);
  assert.equal((await on('device', submit, jwt('tablet'), { id: 't1', text: 'private question' })).status, 200);
  assert.equal((await on('device', submit + '/t1', jwt('laptop'))).status, 404);
  assert.equal((await on('web', '/api/turns', jwt('tablet'))).status, 401);
  assert.deepEqual(await (await on('web', '/api/turns', basic)).json(), { turns: [] });
  const reply = await until(async () => {
    const result = await (await on('device', submit + '/t1', jwt('tablet'))).json();
    return result.status === 'done' && result.text;
  });
  assert.equal(reply, 'device reply');
  assert.equal(workerInput.text, 'private question');
});
