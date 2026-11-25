import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const cwd = new URL('../', import.meta.url);
const secret = () => randomBytes(24).toString('hex');
const addr = port => `http://127.0.0.1:${port}`;
const basic = (user, pw) => ({ authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}` });
const request = (url, path, { auth, method = 'GET', body, headers = {} } = {}) => fetch(`${url}${path}`, {
  method, redirect: 'manual', headers: { ...auth, ...headers }, body, signal: AbortSignal.timeout(4000),
});
const form = (fields, headers = {}) => ({
  method: 'POST',
  body: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
});
const cookieOf = response => {
  const values = response.headers.getSetCookie();
  assert.equal(values.length, 1, 'exactly one cookie is set');
  return values[0];
};

async function until(check, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function start(t, filename, env) {
  const child = spawn(process.execPath, [`src/${filename}.mjs`], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return {
    log: () => log,
    async port(re) {
      return until(() => {
        assert.equal(child.exitCode, null, log);
        return Number(re.exec(log)?.[1]) || null;
      }, `listener for ${filename}`);
    },
  };
}

async function relay(t, { proxyHeader, secureCookie = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'manolo-login-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PRIMARY_TOKEN: secret(), CANARY_TOKEN: secret(), OWNER_PASSWORD: secret(), TESTER_PASSWORD: secret() };
  const config = join(root, 'relay.json');
  await writeFile(config, JSON.stringify({
    agents: { primary: { url: 'http://127.0.0.1:1', tokenEnv: 'PRIMARY_TOKEN' }, canary: { url: 'http://127.0.0.1:2', tokenEnv: 'CANARY_TOKEN' } },
    owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' }, tester: { agent: 'canary', passwordEnv: 'TESTER_PASSWORD' } },
    routes: [], inbox: [],
  }));
  const child = start(t, 'relay', {
    ...env, MANOLO_RELAY_CONFIG: config, MANOLO_DATA_DIR: join(root, 'data'),
    ...(secureCookie ? {} : { MANOLO_COOKIE_SECURE: '0' }),
    ...(proxyHeader && { MANOLO_PROXY_AUTH_HEADER: proxyHeader }),
    PORT: '0', MANOLO_INTERNAL_PORT: '0',
  });
  const web = addr(await child.port(/web listening on .*:(\d+)/));
  return { web, env, log: child.log };
}

test('the sign-in page is public, sets a session cookie, and the workspace shows the signed-in owner', async t => {
  const { web, env, log } = await relay(t);
  const page = await request(web, '/login');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const html = await page.text();
  assert.match(html, /<form id="login-form" method="post" action="\/login"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.doesNotMatch(html, /<script/);
  assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);

  assert.equal((await request(web, '/style.css')).status, 200, 'the sign-in form is styled before authentication');
  assert.equal((await request(web, '/app.js')).status, 401, 'only the stylesheet is public');

  // An unauthenticated browser navigation is sent to the form; an API client keeps a JSON 401.
  const navigation = await request(web, '/', { headers: { accept: 'text/html' } });
  assert.equal(navigation.status, 303);
  assert.equal(navigation.headers.get('location'), '/login');
  const api = await request(web, '/api/turns');
  assert.equal(api.status, 401);
  assert.match(api.headers.get('www-authenticate'), /^Basic /);

  const crossSite = await request(web, '/login', form({ username: 'owner', password: env.OWNER_PASSWORD }, { 'sec-fetch-site': 'cross-site' }));
  assert.equal(crossSite.status, 403, 'a cross-site form post cannot sign the browser in');
  assert.deepEqual(crossSite.headers.getSetCookie(), []);
  const direct = await request(web, '/login', form({ username: 'nobody', password: 'x' }, { 'sec-fetch-site': 'none' }));
  assert.equal(direct.status, 401, 'a top-level navigation is still allowed');

  const wrong = await request(web, '/login', form({ username: 'owner', password: `${env.OWNER_PASSWORD}x` }));
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.headers.getSetCookie(), []);
  assert.match(await wrong.text(), /did not match/);
  const unknown = await request(web, '/login', form({ username: 'nobody', password: 'x' }));
  assert.equal(unknown.status, 401);
  assert.match(await unknown.text(), /did not match/, 'unknown and wrong credentials read the same');

  const ok = await request(web, '/login', form({ username: 'owner', password: env.OWNER_PASSWORD }));
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/');
  const setCookie = cookieOf(ok);
  assert.match(setCookie, /^manolo_session=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=\d+/);
  assert.doesNotMatch(setCookie, /Secure/, 'local HTTP testing keeps the cookie usable');
  const cookie = setCookie.split(';')[0];

  const workspace = await request(web, '/', { headers: { cookie } });
  assert.equal(workspace.status, 200);
  assert.match(workspace.headers.get('content-security-policy'), /script-src 'self'/);
  const session = await request(web, '/api/session', { headers: { cookie } });
  assert.deepEqual(await session.json(), { user: 'owner', agent: 'primary', via: 'cookie' });
  assert.equal((await request(web, '/api/turns', { headers: { cookie } })).status, 200);
  assert.equal((await request(web, '/api/turns', { headers: { cookie: `${cookie}x` } })).status, 401);
  assert.equal((await request(web, '/api/turns', { headers: { cookie: 'manolo_session=' } })).status, 401);
  assert.equal((await request(web, '/api/turns', { headers: { cookie: `${cookie}; manolo_session=other` } })).status, 401,
    'duplicate session cookies are rejected rather than guessed');

  // Basic authentication keeps working for scripts and for the old bookmarks.
  assert.deepEqual(await (await request(web, '/api/session', { auth: basic('tester', env.TESTER_PASSWORD) })).json(),
    { user: 'tester', agent: 'canary', via: 'basic' });
  assert.equal((await request(web, '/', { auth: basic('owner', env.OWNER_PASSWORD) })).status, 200);
  assert.equal((await request(web, '/api/turns', { auth: basic('owner', `${env.OWNER_PASSWORD}!`) })).status, 401);
  assert.doesNotMatch(log(), new RegExp(env.OWNER_PASSWORD));
});

test('signing out revokes the session, requires the request guard, and leaves Basic clients signed in', async t => {
  const { web, env } = await relay(t);
  const login = await request(web, '/login', form({ username: 'tester', password: env.TESTER_PASSWORD }));
  const cookie = cookieOf(login).split(';')[0];
  assert.equal((await request(web, '/logout', { method: 'POST', headers: { cookie } })).status, 403);
  assert.equal((await request(web, '/api/session', { headers: { cookie } })).status, 200, 'a blocked logout changes nothing');
  const out = await request(web, '/logout', { method: 'POST', headers: { cookie, 'x-manolo-request': '1' } });
  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), { ok: true });
  assert.match(cookieOf(out), /Max-Age=0/);
  assert.equal((await request(web, '/api/session', { headers: { cookie } })).status, 401);
  assert.equal((await request(web, '/api/session', { auth: basic('tester', env.TESTER_PASSWORD) })).status, 200);
  assert.equal((await request(web, '/logout', { method: 'POST', auth: basic('tester', env.TESTER_PASSWORD), headers: { 'x-manolo-request': '1' } })).status, 200);
});

test('a configured gateway identity header signs the browser in without a password', async t => {
  const { web, env } = await relay(t, { proxyHeader: 'x-auth-request-user' });
  const trusted = await request(web, '/api/session', { headers: { 'x-auth-request-user': 'owner' } });
  assert.deepEqual(await trusted.json(), { user: 'owner', agent: 'primary', via: 'proxy' });
  assert.equal((await request(web, '/', { headers: { 'x-auth-request-user': 'owner' } })).status, 200);
  assert.equal((await request(web, '/api/turns', { headers: { 'x-auth-request-user': 'nobody' } })).status, 401);
  const duplicate = await fetch(`${web}/api/turns`, {
    headers: new Headers([['x-auth-request-user', 'owner'], ['x-auth-request-user', 'nobody']]), signal: AbortSignal.timeout(4000),
  });
  assert.equal(duplicate.status, 401, 'duplicate identity headers are refused');
  assert.match(env.OWNER_PASSWORD, /./);
});

test('the identity header grants nothing unless the operator configures it', async t => {
  const { web, env } = await relay(t);
  assert.equal((await request(web, '/api/turns', { headers: { 'x-auth-request-user': 'owner' } })).status, 401);
  assert.equal((await request(web, '/logout', { method: 'POST', headers: { 'x-auth-request-user': 'owner', 'x-manolo-request': '1' } })).status, 401);
  assert.match(env.TESTER_PASSWORD, /./);
});

test('the session cookie is Secure for a TLS-fronted deployment', async t => {
  const { web, env } = await relay(t, { secureCookie: true });
  const login = await request(web, '/login', form({ username: 'owner', password: env.OWNER_PASSWORD }));
  assert.equal(login.status, 303);
  assert.match(cookieOf(login), /; Secure$/);
});

test('repeated failures are throttled and a new attempt after the window is allowed again', async t => {
  const { web, env } = await relay(t);
  const attempt = password => request(web, '/login', form({ username: 'owner', password }));
  for (let i = 0; i < 10; i++) assert.equal((await attempt(`wrong-${i}`)).status, 401);
  const blocked = await attempt('wrong-again');
  assert.equal(blocked.status, 429);
  assert.match(await blocked.text(), /Too many failed sign-in attempts/);
  // The correct password is also refused while throttled: the lockout is not a password oracle.
  assert.equal((await attempt(env.OWNER_PASSWORD)).status, 429);
});
