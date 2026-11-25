import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { readBrowserUrls } from '../src/browser-proxy.mjs';

const cwd = new URL('../', import.meta.url);
const secret = () => randomBytes(24).toString('hex');
const basic = (user, pw) => ({ authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}` });

async function until(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}`);
}

function launch(t, env) {
  const child = spawn(process.execPath, ['src/relay.mjs'], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, exited, log: () => log, async port() {
    return until(() => {
      assert.equal(child.exitCode, null, log);
      return Number(/web listening on 127\.0\.0\.1:(\d+)/.exec(log)?.[1]) || null;
    }, 'relay web listener');
  } };
}

test('browser URLs must be plain agent-keyed http origins', () => {
  assert.equal(readBrowserUrls(undefined).size, 0);
  assert.equal(readBrowserUrls('').size, 0);
  assert.deepEqual([...readBrowserUrls('{"primary":"http://manolo-primary:5800"}').keys()], ['primary']);
  assert.equal(readBrowserUrls('{"primary":"http://manolo-primary:5800"}').get('primary').port, '5800');
  for (const bad of [
    'not json', '[]', '{"Primary":"http://a:1"}', '{"primary":1}', '{"primary":"ftp://a:1"}',
    '{"primary":"http://user:pw@a:5800"}', '{"primary":"http://a:5800/vnc.html"}', '{"primary":"http://a:5800?x=1"}',
    '{"primary":"http://a:5800#x"}',
  ]) {
    assert.throws(() => readBrowserUrls(bad), undefined, bad);
  }
});

test('the relay proxies only the signed-in owner’s desktop and never leaks credentials to it', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-desktop-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // A stand-in for the worker's Chromium web frontend. It records what reached it and sets headers the relay must
  // scrub: a workspace cookie, its own CSP and an anti-framing header.
  const seen = [];
  const upgraded = new Set();
  const desktop = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': 'desktop=1; Path=/',
      'content-security-policy': "default-src 'none'",
      'x-frame-options': 'DENY',
    });
    res.end(`<p>desktop ${req.url}</p>`);
  });
  desktop.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write('tunnel-ok\n');
  });
  desktop.listen(0, '127.0.0.1');
  await once(desktop, 'listening');
  // Upgraded sockets survive closeAllConnections(), so the test tracks and closes them itself.
  t.after(() => {
    for (const socket of upgraded) socket.destroy();
    desktop.closeAllConnections();
    return new Promise(resolve => desktop.close(resolve));
  });

  const env = { PRIMARY_TOKEN: secret(), CANARY_TOKEN: secret(), OWNER_PASSWORD: secret(), TESTER_PASSWORD: secret() };
  const configPath = join(root, 'relay.json');
  await writeFile(configPath, JSON.stringify({
    agents: { primary: { url: `http://127.0.0.1:${1}`, tokenEnv: 'PRIMARY_TOKEN' }, canary: { url: 'http://127.0.0.1:2', tokenEnv: 'CANARY_TOKEN' } },
    owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' }, tester: { agent: 'canary', passwordEnv: 'TESTER_PASSWORD' } },
    routes: [],
    inbox: [],
  }));
  const relay = launch(t, {
    MANOLO_DATA_DIR: join(root, 'data'), MANOLO_RELAY_CONFIG: configPath, PORT: '0', MANOLO_INTERNAL_PORT: '0',
    ...env,
    MANOLO_BROWSER_URLS: JSON.stringify({ primary: `http://127.0.0.1:${desktop.address().port}` }),
  });
  const origin = `http://127.0.0.1:${await relay.port()}`;
  const owner = basic('owner', env.OWNER_PASSWORD);
  const tester = basic('tester', env.TESTER_PASSWORD);
  const get = (path, headers = {}) => fetch(`${origin}${path}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });

  // The workspace learns from the same authenticated session whether this agent has a desktop at all.
  const session = await (await get('/api/session', owner)).json();
  assert.deepEqual(session, { user: 'owner', agent: 'primary', via: 'basic', browser: true });
  assert.equal((await (await get('/api/session', tester)).json()).browser, false);

  // An unauthenticated browser navigation is sent to the sign-in page; the proxy itself is never reached. A fetch
  // without an HTML accept header keeps the machine-readable 401.
  const signedOut = await get('/desktop/', { accept: 'text/html' });
  assert.equal(signedOut.status, 303);
  assert.equal(signedOut.headers.get('location'), '/login');
  await signedOut.body?.cancel();
  const signedOutFetch = await get('/desktop/');
  assert.equal(signedOutFetch.status, 401);
  await signedOutFetch.body?.cancel();

  const redirected = await get('/desktop?x=1', owner);
  assert.equal(redirected.status, 308);
  assert.equal(redirected.headers.get('location'), '/desktop/?x=1');
  await redirected.body?.cancel();

  const page = await get('/desktop/vnc.html?autoconnect=1', owner);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<p>desktop /vnc.html?autoconnect=1</p>');
  // The owner's Basic credentials, the upstream cookie and its anti-framing headers stop at the relay.
  assert.equal(page.headers.get('set-cookie'), null);
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.deepEqual(seen, [{ url: '/vnc.html?autoconnect=1', authorization: undefined }]);

  // An owner whose agent has no browser never reaches another agent's desktop.
  const denied = await get('/desktop/', tester);
  assert.equal(denied.status, 404);
  await denied.body?.cancel();

  // A websocket handshake is authorized the same way, then tunnelled byte for byte.
  const upgrade = async headers => {
    const socket = connect(Number(new URL(origin).port), '127.0.0.1');
    socket.setEncoding('utf8');
    let received = '';
    socket.on('data', chunk => { received += chunk; });
    const closed = once(socket, 'close');
    socket.write(`GET /desktop/websockify HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headers}\r\n\r\n`);
    await until(() => received.includes('\r\n\r\n'), 'upgrade response');
    return { received: () => received, close: async () => { socket.destroy(); await closed; } };
  };
  const tunnelled = await upgrade(`Authorization: ${owner.authorization}\r\n`);
  await until(() => tunnelled.received().includes('tunnel-ok'), 'tunnelled payload');
  assert.match(tunnelled.received(), /^HTTP\/1\.1 101/);
  await tunnelled.close();

  const rejected = await upgrade('');
  assert.match(rejected.received(), /^HTTP\/1\.1 401/);
  await rejected.close();

  // A desktop path for an agent that has none is refused before any connection is attempted.
  const nowhere = await upgrade(`Authorization: ${tester.authorization}\r\n`);
  assert.match(nowhere.received(), /^HTTP\/1\.1 404/);
  await nowhere.close();
});

test('a browser URL for an unknown agent stops the relay at startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-desktop-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'relay.json');
  await writeFile(configPath, JSON.stringify({
    agents: { primary: { url: 'http://127.0.0.1:1', tokenEnv: 'PRIMARY_TOKEN' } },
    owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' } },
    routes: [],
    inbox: [],
  }));
  const child = spawn(process.execPath, ['src/relay.mjs'], {
    cwd,
    env: {
      PATH: process.env.PATH, MANOLO_DATA_DIR: join(root, 'data'), MANOLO_RELAY_CONFIG: configPath, PORT: '0', MANOLO_INTERNAL_PORT: '0',
      PRIMARY_TOKEN: secret(), OWNER_PASSWORD: secret(), MANOLO_BROWSER_URLS: '{"ghost":"http://127.0.0.1:5800"}',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  await once(child, 'exit');
  assert.notEqual(child.exitCode, 0);
  assert.match(log, /MANOLO_BROWSER_URLS references an unknown agent/);
});
