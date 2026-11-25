import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installBrowserTools } from '../src/browser-tools.mjs';

const workerPath = fileURLToPath(new URL('../src/worker.mjs', import.meta.url));
const chromium = process.env.CHROMIUM_BIN ?? 'chromium';
const missingChromium = spawnSync(chromium, ['--version']).error?.code === 'ENOENT';
const token = 'fixture-private-bearer-long-enough';
const auth = { authorization: `Bearer ${token}` };

// The sidecar is a long-lived Chromium with a persistent profile. The test only needs the same DevTools endpoint the
// worker talks to, so it starts a headless Chromium with a throwaway profile instead of the container image.
async function startChromium(t) {
  const profile = await mkdtemp(join(tmpdir(), 'manolo-browser-profile-'));
  const child = spawn(chromium, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-gpu',
    '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1];
    if (port) return `http://127.0.0.1:${port}`;
    assert.equal(child.exitCode, null, stderr);
    await sleep(50);
  }
  assert.fail(`Chromium did not open a DevTools endpoint: ${stderr}`);
}

async function dataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'manolo-browser-test-'));
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
  async function start() {
    for (let attempt = 0; attempt < 200; attempt++) {
      assert.equal(child.exitCode, null, stdout + stderr);
      const port = /Manolo worker listening on (\d+)/.exec(stdout)?.[1];
      if (port) return `http://127.0.0.1:${port}`;
      await sleep(25);
    }
    assert.fail(`Worker did not listen: ${stdout}${stderr}`);
  }
  return start;
}

async function until(check, label) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const result = await check();
    if (result) return result;
    await sleep(20);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function request(url, path, options) {
  return fetch(url + path, { signal: AbortSignal.timeout(10_000), ...options });
}

async function toolTurn(url, id, name, args) {
  const response = await request(url, `/v1/turns/${id}`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'browser', text: `fixture-tool:${JSON.stringify({ name, args })}` }),
  });
  assert.equal(response.status, 202);
  const body = await until(async () => {
    const poll = await request(url, `/v1/turns/${id}`, { headers: auth });
    assert.equal(poll.status, 200);
    const turn = await poll.json();
    if (turn.status !== 'pending') return turn;
  }, `terminal turn ${id}`);
  assert.equal(body.status, 'done', JSON.stringify(body));
  assert.ok(Array.isArray(body.tools), JSON.stringify(body));
  const tool = body.tools.find(each => each.name === name);
  assert.ok(tool, JSON.stringify(body));
  return tool;
}

// A page with an input, a button that answers with a title change, and a second link: enough to prove navigation,
// refs, typing, clicking and a screenshot against a real Chromium.
async function startPage(t) {
  const server = createServer((req, res) => {
    if (req.url === '/next') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<title>Second page</title><p>You reached the next page.</p>');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>First page</title>
      <h1>Browser fixture</h1>
      <label for="field">Name</label>
      <input id="field" name="field" placeholder="Your name">
      <button id="go" onclick="document.title='Clicked';document.getElementById('out').textContent='button clicked'">Do it</button>
      <p id="out">idle</p>
      <a href="/next">Next</a>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/` };
}

test('the browser tools drive a real Chromium and are absent without an endpoint', { skip: missingChromium && 'chromium unavailable (set CHROMIUM_BIN)', timeout: 120_000 }, async t => {
  const endpoint = await startChromium(t);
  const page = await startPage(t);
  const dir = await dataDir(t);
  const relay = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); return new Promise(resolve => relay.close(resolve)); });
  const start = launch(t, dir, {
    MANOLO_RELAY_URL: `http://127.0.0.1:${relay.address().port}`, MANOLO_FIXTURE_TOOLS: '1', MANOLO_BROWSER_CDP: endpoint,
    MANOLO_FIXTURE_INSPECT_SETUP: '1',
  });
  const url = await start();
  const call = (id, name, args) => toolTurn(url, id, name, args);

  const opened = await call('open', 'browser_open', { url: page.url });
  assert.equal(opened.status, 'ok', opened.output);
  assert.match(opened.output, /First page/);
  assert.match(opened.output, /\[e1\] textbox "Your name"/);
  assert.match(opened.output, /\[e2\] button "Do it"/);
  assert.match(opened.output, /\[e3\] link "Next" -> \/next/);

  // Typing goes through the real input pipeline, so the page's own value is what the next snapshot reports.
  const typed = await call('type', 'browser_type', { ref: 'e1', text: 'Ada' });
  assert.equal(typed.status, 'ok', typed.output);
  assert.match(typed.output, /value="Ada"/);

  const clicked = await call('click', 'browser_click', { ref: 'e2' });
  assert.equal(clicked.status, 'ok', clicked.output);
  assert.match(clicked.output, /Clicked/);
  assert.match(clicked.output, /button clicked/);

  const pressed = await call('key', 'browser_key', { key: 'Tab' });
  assert.equal(pressed.status, 'ok', pressed.output);

  const shot = await call('screenshot', 'browser_screenshot', {});
  assert.equal(shot.status, 'ok', shot.output);
  assert.equal(shot.images?.[0]?.mimeType, 'image/jpeg');
  assert.ok(shot.images[0].data.length > 1000);

  // Following a link and switching tabs both come back as a snapshot of the tab in focus.
  const followed = await call('follow', 'browser_open', { url: `${page.url}next` });
  assert.equal(followed.status, 'ok', followed.output);
  assert.match(followed.output, /Second page/);
  const second = await call('newtab', 'browser_open', { url: page.url, newTab: true });
  assert.equal(second.status, 'ok', second.output);
  const tabs = await call('tabs', 'browser_tabs', { action: 'list' });
  assert.equal(tabs.status, 'ok', tabs.output);
  assert.equal(tabs.output.split('\n').filter(line => /^[* ] [A-F0-9]{8,32} /.test(line)).length, 2);

  // A refused URL and a stale ref are ordinary tool errors, not a crashed worker.
  const refused = await call('refused', 'browser_open', { url: 'file:///etc/passwd' });
  assert.equal(refused.status, 'error');
  assert.match(refused.output, /http and https/);
  const stale = await call('stale', 'browser_click', { ref: 'e99' });
  assert.equal(stale.status, 'error');
  assert.match(stale.output, /not on the page/);

  // A worker without the sidecar endpoint is offered no browser tools at all.
  const plainDir = await dataDir(t);
  const plainStart = launch(t, plainDir, { MANOLO_RELAY_URL: `http://127.0.0.1:${relay.address().port}`, MANOLO_FIXTURE_TOOLS: '1', MANOLO_FIXTURE_INSPECT_SETUP: '1' });
  const plainUrl = await plainStart();
  const inspect = async (worker, id) => {
    const response = await request(worker, `/v1/turns/${id}`, {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'setup', text: 'fixture:setup' }),
    });
    assert.equal(response.status, 202);
    return until(async () => {
      const poll = await request(worker, `/v1/turns/${id}`, { headers: auth });
      const turn = await poll.json();
      if (turn.status !== 'pending') return JSON.parse(turn.text).tools;
    }, `setup inspection ${id}`);
  };
  const plainTools = await inspect(plainUrl, 'setup-plain');
  assert.equal(plainTools.some(name => name.startsWith('browser_')), false);
  const browserTools = await inspect(url, 'setup-browser');
  for (const name of ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_key', 'browser_screenshot', 'browser_tabs']) {
    assert.ok(browserTools.includes(name), `${name} should be offered when a sidecar endpoint is configured`);
  }
});

test('a browser endpoint outside the pod’s loopback stops the worker at startup', { timeout: 15_000 }, async t => {
  const dir = await dataDir(t);
  const child = spawn(process.execPath, [workerPath], {
    env: {
      MANOLO_DATA_DIR: dir, MANOLO_MODE: 'fixture', MANOLO_AGENT_ID: 'test-manolo', MANOLO_AGENT_TOKEN: token,
      PORT: '0', MANOLO_BROWSER_CDP: 'http://manolo-primary:9222',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(() => { child.kill('SIGKILL'); return closed; });
  await closed;
  assert.notEqual(child.exitCode, 0);
  assert.match(stderr, /MANOLO_BROWSER_CDP must be a loopback http origin/);
});

test('every browser tool reports activity before it talks to the sidecar', async () => {
  // A stub registry captures the extension without a model, so the touch wiring is proven without a Chromium.
  const install = touch => {
    let installed;
    installBrowserTools({ install: extension => { installed = extension; } }, { endpoint: 'http://127.0.0.1:1', touch });
    return installed.tools;
  };
  const argumentsFor = {
    browser_open: { url: 'http://127.0.0.1:1/' }, browser_snapshot: {}, browser_click: { ref: 'e1' },
    browser_type: { text: 'hello' }, browser_key: { key: 'Enter' }, browser_screenshot: {}, browser_tabs: { action: 'list' },
  };
  let touches = 0;
  const tools = install(() => { touches += 1; });
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(argumentsFor).sort());
  for (const tool of tools) {
    // Nothing listens on the endpoint, so the call fails after the activity was recorded — the point of the test.
    await assert.rejects(tool.execute(argumentsFor[tool.name], {}, {}), /browser is not running|not a snapshot ref/);
  }
  assert.equal(touches, tools.length);

  // Bookkeeping is never part of the result: a broken touch callback must not turn into a tool failure of its own.
  let broken = 0;
  const open = install(() => { broken += 1; throw new Error('idle watcher broke'); }).find(tool => tool.name === 'browser_open');
  await assert.rejects(open.execute(argumentsFor.browser_open, {}, {}), /browser is not running/);
  assert.equal(broken, 1);
});
