import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const chromium = process.env.CHROMIUM_BIN ?? 'chromium';
const missingChromium = spawnSync(chromium, ['--version']).error?.code === 'ENOENT';

async function openBrowser(t) {
  const profile = await mkdtemp(join(tmpdir(), 'manolo-web-test-'));
  const child = spawn(chromium, [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    `--user-data-dir=${profile}`, '--remote-debugging-pipe',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
    // A Chromium helper can still release profile files after the parent exits.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  let nextId = 0;
  let buffer = '';
  const awaiting = new Map();
  child.stdio[4].setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const { id, result, error } = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      awaiting.get(id)?.(error ? new Error(error.message) : null, result);
      awaiting.delete(id);
    }
  });
  child.once('close', () => {
    for (const reply of awaiting.values()) reply(new Error('Chromium closed during CDP command'));
  });
  function send(method, params, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      awaiting.set(id, (error, result) => error ? reject(error) : resolve(result));
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  return async function openTab(url) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const run = async (expression) => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      assert.ok(!exceptionDetails, result.description);
      return result.value;
    };
    await send('Page.navigate', { url }, sessionId);
    return { run, reload: () => send('Page.reload', {}, sessionId) };
  };
}

async function waitFor(run, expression) {
  for (let i = 0; i < 100; i++) {
    if (await run(expression)) return;
    await sleep(50);
  }
  assert.fail(`Browser did not reach: ${expression}`);
}

const logCount = `document.querySelector('#chat-log')?.childElementCount`;
const logText = `document.querySelector('#chat-log').textContent`;
const sendDisabled = `document.querySelector('#send-chat')?.disabled`;
const checkHidden = `document.querySelector('#check-turn')?.hidden`;
const refreshDisabled = `document.querySelector('#refresh-chat')?.disabled`;
const click = (id) => `document.querySelector('#${id}').click()`;
const fill = (value) => `document.querySelector('#chat-text').value = ${JSON.stringify(value)}`;

test('browser history renders, recovers pending turns, and refreshes across tabs', {
  skip: missingChromium && 'chromium unavailable (set CHROMIUM_BIN)', timeout: 30_000,
}, async (t) => {
  const literal = '<b data-untrusted>plain text</b>';
  const turns = [
    { id: 'saved', text: literal, createdAt: 1, status: 'done', reply: literal },
    { id: 'failed', text: 'Saved failure', createdAt: 2, status: 'failed' },
    { id: 'older', text: 'Older pending', createdAt: 3, status: 'pending' },
    { id: 'latest', text: 'Latest pending', createdAt: 4, status: 'pending' },
  ];
  const checked = [];
  const posts = [];
  const authorizations = [];
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css'],
  ].map(async ([path, file, type]) => [path, { type, body: await readFile(new URL(`../src/web/${file}`, import.meta.url)) }])));
  const server = createServer(async (req, res) => {
    const { url, method } = req;
    const json = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const asset = assets.get(url);
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(asset.body);
      return;
    }
    if (url === '/api/dashboard') return json({ history: [] });
    if (url === '/api/inbox') return json({ messages: [] });
    if (url.startsWith('/api/turns')) authorizations.push(req.headers.authorization);
    if (url === '/api/turns' && method === 'GET') return json({ turns });
    if (url === '/api/turns' && method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id, text } = JSON.parse(body);
      posts.push({ id, text, headers: req.headers, body: JSON.parse(body) });
      if (text === 'Reject this') return json({}, 400);
      const uncertain = text === 'Saved but response lost';
      const status = uncertain ? 'pending' : 'done';
      const reply = uncertain ? undefined : 'Second tab reply';
      turns.push({ id, text, createdAt: turns.length + 1, status, reply });
      return uncertain ? json({}, 503) : json({ status, text: reply });
    }
    if (url.startsWith('/api/turns/')) {
      const turn = turns.find(({ id }) => url === `/api/turns/${id}`);
      if (!turn) return json({}, 404);
      checked.push(turn.id);
      if (turn.id === 'latest' && checked.length === 1) return json({ status: 'pending' });
      turn.status = turn.id === 'older' ? 'failed' : 'done';
      turn.reply = turn.id === 'older' ? 'Check failed' : 'Recovered reply';
      return json({ status: turn.status, text: turn.reply });
    }
    return json({}, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const openTab = await openBrowser(t);
  const firstTab = await openTab(url);
  const { run } = firstTab;
  await waitFor(run, `${logCount} === 4`);
  assert.deepEqual(await run(`[...document.querySelector('#chat-log').children].map(row => row.children[1].textContent)`),
    [literal, 'Saved failure', 'Older pending', 'Latest pending']);
  assert.equal(await run(`document.querySelectorAll('[data-untrusted]').length`), 0);
  assert.ok(await run(`${logText}.includes(${JSON.stringify(literal)}) && ${logText}.includes('Turn failed.')`));
  assert.equal(await run(sendDisabled), true);
  assert.equal(await run(checkHidden), false);
  await run(`${fill('New draft')}; document.querySelector('#chat-form').requestSubmit()`);
  await run(click('check-turn'));
  assert.equal(await run(refreshDisabled), true);
  await waitFor(run, `!${refreshDisabled} && ${logText}.includes('Recovered reply')`);
  assert.deepEqual(checked, ['latest', 'latest']);
  assert.equal(posts.length, 0);
  assert.equal(await run(logCount), 4);
  assert.equal(await run(sendDisabled), true);
  await run(click('check-turn'));
  await waitFor(run, `!${sendDisabled}`);
  assert.deepEqual(checked, ['latest', 'latest', 'older']);
  assert.ok(await run(`${logText}.includes('Check failed')`));
  assert.equal(await run(`document.querySelector('#chat-text').value`), 'New draft');

  const { run: second } = await openTab(url);
  await waitFor(second, `${logCount} === 4 && !${sendDisabled}`);
  await second(`${fill('Sent from another tab')}; ${click('send-chat')}`);
  await waitFor(second, `${logText}.includes('Second tab reply')`);
  assert.equal(await run(logCount), 4);
  await run(click('refresh-chat'));
  await waitFor(run, `${logCount} === 5 && !${sendDisabled}`);
  assert.ok(await run(`${logText}.includes('Sent from another tab') && ${logText}.includes('Second tab reply')`));
  const timeOrigin = await run('performance.timeOrigin');
  await firstTab.reload();
  await waitFor(run, `performance.timeOrigin !== ${timeOrigin} && ${logCount} === 5`);
  assert.equal(await run(`document.querySelector('#chat-text').value`), '');
  assert.deepEqual(await run(`[localStorage.length, sessionStorage.length]`), [0, 0]);

  await run(`${fill('Reject this')}; ${click('send-chat')}`);
  await waitFor(run, `!${sendDisabled} && document.querySelector('#chat-status').textContent.includes('(400)')`);
  assert.equal(await run(logCount), 5);
  assert.equal(await run(`document.querySelector('#chat-text').value`), 'Reject this');

  await run(`${fill('Saved but response lost')}; ${click('send-chat')}`);
  await waitFor(run, `!${refreshDisabled} && document.querySelector('#chat-status').textContent.includes('(503)')`);
  assert.equal(await run(sendDisabled), true);
  await run(click('refresh-chat'));
  await waitFor(run, `!${refreshDisabled} && ${logCount} === 6`);
  assert.equal(await run(checkHidden), false);
  await run(click('check-turn'));
  await waitFor(run, `!${sendDisabled}`);
  assert.equal(await run(logCount), 6);
  assert.equal(checked.at(-1), posts.at(-1).id);
  assert.deepEqual(posts.map(({ text }) => text), ['Sent from another tab', 'Reject this', 'Saved but response lost']);
  for (const { headers, body } of posts) {
    assert.deepEqual(Object.keys(body).sort(), ['id', 'text']);
    assert.equal(headers['x-manolo-request'], '1');
  }
  assert.ok(authorizations.every((header) => header === undefined));
});
