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
  const listeners = new Map();
  child.stdio[4].setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const { id, result, error, method, params, sessionId } = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (method) listeners.get(sessionId)?.(method, params);
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
  return async function openTab(url, credentials) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    if (credentials) {
      const handledChallenges = new Set();
      listeners.set(sessionId, (method, { requestId }) => {
        if (method === 'Fetch.requestPaused') {
          void send('Fetch.continueRequest', { requestId }, sessionId);
        } else if (method === 'Fetch.authRequired') {
          const authChallengeResponse = handledChallenges.has(requestId)
            ? { response: 'CancelAuth' } : { response: 'ProvideCredentials', ...credentials };
          handledChallenges.add(requestId);
          void send('Fetch.continueWithAuth', { requestId, authChallengeResponse }, sessionId);
        }
      });
      await send('Fetch.enable', { handleAuthRequests: true }, sessionId);
    }
    const run = async (expression) => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      assert.ok(!exceptionDetails, result.description);
      return result.value;
    };
    await send('Page.navigate', { url }, sessionId);
    return {
      run,
      reload: () => send('Page.reload', {}, sessionId),
      resize: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 }, sessionId),
    };
  };
}

async function waitFor(run, expression) {
  for (let i = 0; i < 100; i++) {
    try {
      if (await run(expression)) return;
    } catch (error) {
      // A page navigation interrupts an in-flight evaluation, and a script still in flight can leave the DOM short of
      // the element the expression dereferences. Both are transient: retry on the same or the new document.
      if (process.env.DEBUG_WAIT) console.error('waitFor retry:', error.message.split('\n')[0]);
    }
    await sleep(50);
  }
  assert.fail(`Browser did not reach: ${expression}`);
}

const logCount = `document.querySelector('#chat-log')?.childElementCount`;
const logText = `document.querySelector('#chat-log').textContent`;
const pendingStates = `[...document.querySelectorAll('.chat-answer[data-state="pending"] .chat-turn-state')].map(node => node.textContent)`;
const sendDisabled = `document.querySelector('#send-chat')?.disabled`;
const checkHidden = `document.querySelector('#check-turn')?.hidden`;
const refreshDisabled = `document.querySelector('#refresh-chat')?.disabled`;
const click = (id) => `document.querySelector('#${id}').click()`;
const fill = (value) => `document.querySelector('#chat-text').value = ${JSON.stringify(value)}`;

test('browser history renders, recovers pending turns, and refreshes across tabs', {
  skip: missingChromium && 'chromium unavailable (set CHROMIUM_BIN)', timeout: 30_000,
}, async (t) => {
  const literal = '<b data-untrusted>plain text</b>';
  const ownerName = '<b data-untrusted>Owner Name</b>';
  const tools = [
    { name: 'bash', status: 'ok', args: '{"command":"echo hi"}', output: 'hi\n', durationMs: 12,
      diagnostics: [{ severity: 'info', code: 'full_output', message: 'Full output: /tmp/manolo/tool-output' }] },
    { name: 'edit', status: 'error', args: '{"path":"notes.txt"}', diff: '- old\n+ new', output: 'Could not edit the file.' },
    { name: 'read', status: 'ok', images: [{ mimeType: 'image/png', index: 0 }] },
  ];
  const turns = [
    { id: 'saved', text: literal, createdAt: 1, status: 'done', reply: literal, tools },
    { id: 'failed', text: 'Saved failure', createdAt: 2, status: 'failed' },
    { id: 'older', text: 'Older pending', createdAt: 3, status: 'pending', activity: 'queued' },
    { id: 'latest', text: 'Latest pending', createdAt: 4, status: 'pending', activity: 'running', live: {
      text: 'streamed partial', thinking: 'streamed reasoning',
      tools: [{ name: 'bash', status: 'running', output: 'live output line' }],
    } },
  ];
  const checked = [];
  const mcpSaves = [];
  const posts = [];
  const authorizations = [];
  let sessionRequests = 0;
  const finishLatest = Promise.withResolvers();
  const finishOlder = Promise.withResolvers();
  const acceptSubmit = Promise.withResolvers();
  const finishSubmit = Promise.withResolvers();
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
    if (url === '/api/session') return json({ user: ownerName, agent: 'browser', via: 'cookie', browser: true });
    if (url === '/api/mcp' && method === 'GET') {
      return json({ servers: [{ name: 'fixture', kind: 'stdio', enabled: true, state: 'connected', tools: 3 }], error: null, config: '{"mcpServers":{}}' });
    }
    if (url === '/api/mcp/config' && method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { text } = JSON.parse(body);
      mcpSaves.push({ text, headers: req.headers });
      return json({ servers: [], error: null, config: text });
    }
    if (url === '/api/sessions') {
      sessionRequests++;
      return json({}, 404); // Older relay.
    }
    if (url.startsWith('/api/turns')) authorizations.push(req.headers.authorization);
    if (url === '/api/turns' && method === 'GET') return json({ turns });
    if (url === '/api/turns' && method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id, text } = JSON.parse(body);
      posts.push({ id, text, headers: req.headers, body: JSON.parse(body) });
      if (text === 'Reject this') return json({}, 400);
      const uncertain = text === 'Saved but response lost';
      if (!uncertain) await acceptSubmit.promise;
      turns.push({ id, text, createdAt: turns.length + 1, status: 'pending', activity: 'running' });
      return uncertain ? json({}, 503) : json({ status: 'pending', activity: 'running' });
    }
    if (url.startsWith('/api/turns/')) {
      const turn = turns.find(({ id }) => url === `/api/turns/${id}`);
      if (!turn) return json({}, 404);
      checked.push(turn.id);
      const checks = checked.filter((id) => id === turn.id).length;
      const fromSecondTab = turn.text === 'Sent from another tab';
      if (turn.id === 'latest') {
        if (checks === 1) return json({ status: 'pending' }); // An older relay omits activity.
        await finishLatest.promise;
      } else if (turn.id === 'older') {
        if (checks < 3) return json({ status: 'pending', activity: checks === 1 ? 'queued' : 'running' });
        await finishOlder.promise;
      } else if (fromSecondTab) {
        await finishSubmit.promise;
      }
      turn.status = turn.id === 'older' ? 'failed' : 'done';
      turn.reply = turn.id === 'older' ? 'Check failed' : fromSecondTab ? 'Second tab reply' : 'Recovered reply';
      delete turn.activity;
      delete turn.live;
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
  await firstTab.resize(1200, 800);
  const { run } = firstTab;
  await waitFor(run, `${logCount} === 4 && document.getElementById('workspace-tabs').getAttribute('aria-orientation') === 'vertical'`);
  await waitFor(run, `document.querySelector('#session-user').textContent === ${JSON.stringify(ownerName)}`);
  assert.equal(await run(`document.querySelector('#session-user').children.length`), 0);
  assert.equal(await run(`document.querySelector('#session-user').dataset.state`), 'signed-in');
  assert.equal(await run(`document.querySelector('#sign-out').disabled`), false);
  assert.deepEqual(await run(`[...document.querySelector('#chat-log').children].map(row => row.children[1].textContent)`),
    [literal, 'Saved failure', 'Older pending', 'Latest pending']);
  assert.equal(await run(`document.querySelectorAll('[data-untrusted]').length`), 0);
  const saved = `document.querySelector('#chat-log > li:first-child')`;
  assert.equal(await run(`${saved}.querySelectorAll('.chat-tool').length`), 3);
  assert.deepEqual(await run(`[...${saved}.querySelectorAll('.chat-tool .tool-name')].map(node => node.textContent)`), ['bash', 'edit', 'read']);
  assert.deepEqual(await run(`[...${saved}.querySelectorAll('.chat-tool .tool-status')].map(node => node.textContent)`), ['ok', 'failed', 'ok']);
  assert.ok(await run(`${saved}.querySelector('.chat-tool').textContent.includes('echo hi')`));
  assert.ok(await run(`${saved}.querySelector('.chat-tool').textContent.includes('Full output: /tmp/manolo/tool-output')`));
  assert.ok(await run(`${saved}.querySelector('.chat-tool .tool-diff').textContent.includes('- old')`));
  assert.equal(await run(`${saved}.querySelector('.chat-tool[data-status="error"] .tool-status').textContent`), 'failed');
  assert.equal(await run(`${saved}.querySelector('.tool-image img').getAttribute('src')`), '/api/turn-image/saved/0');
  assert.equal(await run(`${saved}.querySelector('.chat-tool:has(.tool-image)').open`), true);
  assert.deepEqual(await run(pendingStates), ['Queued.', 'Running.']);
  assert.equal(await run(`document.querySelector('.chat-stream').textContent`), 'streamed partial');
  assert.equal(await run(`document.querySelector('.chat-thinking-text').textContent`), 'streamed reasoning');
  assert.equal(await run(`document.querySelector('.chat-tool[data-status="running"] .tool-status').textContent`), 'running');
  assert.ok(await run(`document.querySelector('.chat-tool[data-status="running"] .tool-output').textContent.includes('live output line')`));
  assert.ok(await run(`${logText}.includes(${JSON.stringify(literal)}) && ${logText}.includes('Turn failed.')`));
  assert.equal(await run(sendDisabled), true);
  assert.equal(await run(checkHidden), false);

  const visible = (id) => `!document.getElementById('${id}-panel').hidden`;
  const press = (id, key) => `document.getElementById('${id}-tab').dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`;
  // The browser tab appears only for an agent with a desktop, and loads the proxied frame on first use.
  await waitFor(run, `!document.getElementById('browser-tab').hidden`);
  await run(click('browser-tab'));
  assert.ok(await run(`${visible('browser')} && document.getElementById('browser-frame').getAttribute('src') === '/desktop/'`));
  await run(click('chat-tab'));
  // The MCP card lists the agent's servers and saves the edited file back with the request header the relay wants.
  await waitFor(run, `document.getElementById('mcp-list').textContent.includes('fixture · 3 tool')`);
  await run(`document.getElementById('mcp-config').value = '{"mcpServers":{"x":{"command":"y"}}}'; document.getElementById('mcp-form').requestSubmit()`);
  await waitFor(run, `document.getElementById('mcp-status').textContent === 'Applied.'`);
  assert.equal(mcpSaves.length, 1);
  assert.equal(mcpSaves[0].headers['x-manolo-request'], '1');
  assert.match(mcpSaves[0].text, /"x"/);
  assert.ok(await run(`${visible('chat')} && !(${visible('dashboard')}) && !(${visible('inbox')})`));
  await run(press('chat', 'ArrowDown'));
  assert.ok(await run(`${visible('sessions')} && document.activeElement.id === 'sessions-tab'`));
  await waitFor(run, `document.querySelector('#sessions-status').textContent.includes('not available on this relay')`);
  await run(press('sessions', 'ArrowDown'));
  assert.ok(await run(`${visible('dashboard')} && document.activeElement.id === 'dashboard-tab'`));
  await run(click('inbox-tab'));
  assert.ok(await run(visible('inbox')));
  await waitFor(run, `!document.querySelector('#inbox-messages-empty').hidden`);
  assert.equal(await run(`document.querySelector('#inbox-questions-section').hidden`), true);
  await run(press('inbox', 'Home'));
  assert.ok(await run(visible('chat')));
  await firstTab.resize(390, 760);
  await waitFor(run, `document.getElementById('workspace-tabs').getAttribute('aria-orientation') === 'horizontal'`);
  await run(press('chat', 'ArrowRight'));
  assert.ok(await run(`${visible('sessions')} && document.documentElement.scrollWidth === innerWidth`));
  await run(click('chat-tab'));
  assert.ok(await run(`${visible('chat')} && document.querySelector('#send-chat').getBoundingClientRect().bottom <= innerHeight`));
  await run(`${fill('New draft')}; document.querySelector('#chat-form').requestSubmit()`);
  await run(click('check-turn'));
  assert.equal(await run(refreshDisabled), true);
  await waitFor(run, `${pendingStates}.at(-1) === 'Reply pending.'`);
  assert.ok(await run(`document.querySelector('.chat-tool[data-status="running"] .tool-output').textContent.includes('live output line')`));
  finishLatest.resolve();
  await waitFor(run, `!${refreshDisabled} && ${logText}.includes('Recovered reply')`);
  assert.deepEqual(await run(pendingStates), ['Queued.']);
  assert.equal(await run(`document.querySelector('#chat-log > li:last-child .chat-turn-state')`), null);
  assert.equal(await run(`document.querySelector('.chat-stream')`), null);
  assert.deepEqual(checked, ['latest', 'latest']);
  assert.equal(posts.length, 0);
  assert.equal(await run(logCount), 4);
  assert.equal(await run(sendDisabled), true);
  await run(click('check-turn'));
  await waitFor(run, `${pendingStates}.at(-1) === 'Running.'`);
  finishOlder.resolve();
  await waitFor(run, `!${sendDisabled}`);
  assert.deepEqual(checked, ['latest', 'latest', 'older', 'older', 'older']);
  assert.ok(sessionRequests > 0 && sessionRequests <= 3, `Unexpected sessions probes: ${sessionRequests}`);
  assert.deepEqual(await run(pendingStates), []);
  assert.equal(await run(`document.querySelector('#chat-log > li:nth-last-child(2) .chat-turn-state').textContent`), 'Turn failed.');
  assert.ok(await run(`${logText}.includes('Check failed')`));
  assert.equal(await run(`document.querySelector('#chat-text').value`), 'New draft');

  const { run: second } = await openTab(url);
  await waitFor(second, `${logCount} === 4 && !${sendDisabled}`);
  await second(`${fill('Sent from another tab')}; document.getElementById('chat-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
  assert.deepEqual(await second(pendingStates), ['Queued.']);
  acceptSubmit.resolve();
  await waitFor(second, `${pendingStates}.at(-1) === 'Running.'`);
  finishSubmit.resolve();
  await waitFor(second, `${logText}.includes('Second tab reply')`);
  assert.deepEqual(await second(pendingStates), []);
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
  assert.deepEqual(await run(pendingStates), ['Running.']);
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

test('browser Sessions links work to turns and reads transcripts with owner authentication', {
  skip: missingChromium && 'chromium unavailable (set CHROMIUM_BIN)', timeout: 30_000,
}, async (t) => {
  const literal = '<a href="https://example.test" data-untrusted>text only</a>';
  const target = 'Target: pod';
  const active = { id: 'active task', parentTurnId: 'pending', title: 'Active work', status: 'queued', target: null };
  const ended = { id: 'ended', parentTurnId: 'done', title: `Previous work ${literal}`, status: 'done', target: literal, blueprint: { id: 'review' } };
  const failed = { id: 'failed', parentTurnId: null, title: 'Other work', status: 'failed', target: null };
  const sessions = [active, ended, failed];
  const turns = [
    { id: 'done', status: 'done', text: 'Previous message', reply: 'Previous reply' },
    { id: 'pending', status: 'pending', activity: 'running', text: 'Current message' },
  ];
  const finishTurn = Promise.withResolvers();
  const requests = [];
  let listStatus = 200;
  let detailStatus = 200;
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css'],
  ].map(async ([path, file, type]) => [path, { type, body: await readFile(new URL(`../src/web/${file}`, import.meta.url)) }])));
  const auth = `Basic ${Buffer.from('owner:browser-test').toString('base64')}`;
  const server = createServer(async (req, res) => {
    const { url, method, headers } = req;
    const json = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (headers.authorization !== auth) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Manolo browser test"' });
      res.end();
      return;
    }
    const asset = assets.get(url);
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(asset.body);
      return;
    }
    if (url === '/api/dashboard') return json({ history: [] });
    if (url === '/api/inbox') return json({ messages: [] });
    if (url === '/api/session') return json({ user: 'owner', agent: 'browser', via: 'basic' });
    if (url === '/api/turns') return json({ turns });
    if (url === '/api/turns/pending') {
      await finishTurn.promise;
      return json({ status: 'done', text: 'Current reply' });
    }
    if (url.startsWith('/api/sessions')) requests.push({ url, method, authorization: headers.authorization });
    if (url === '/api/sessions') return listStatus === 200 ? json({ sessions }) : json({}, listStatus);
    if (url.startsWith('/api/sessions/')) {
      const session = sessions.find(({ id }) => url === `/api/sessions/${encodeURIComponent(id)}`);
      if (!session || detailStatus !== 200) return json({}, session ? detailStatus : 404);
      const transcript = session === ended ? [{ role: 'user', text: 'Check this' }, { role: 'assistant', text: literal }] : [];
      return json({ session: { ...session, transcript } });
    }
    return json({}, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { finishTurn.resolve(); server.close(); server.closeAllConnections(); });
  const openTab = await openBrowser(t);
  const { run } = await openTab(`http://127.0.0.1:${server.address().port}/`, { username: 'owner', password: 'browser-test' });
  const list = `document.querySelector('#session-list')`;
  const status = `document.querySelector('#sessions-status').textContent`;
  const title = `document.querySelector('#session-title').textContent`;
  const detail = `document.querySelector('#session-detail')`;
  const sessionTranscript = `document.querySelector('#session-transcript')`;
  const chatLinks = (turn) => `document.querySelector('#chat-log > li:${turn}-child .chat-session-links')`;
  const includes = (value) => `.textContent.includes(${JSON.stringify(value)})`;

  await waitFor(run, `${chatLinks('first')}?${includes('Previous work')}`);
  assert.equal(await run(`document.querySelector('#session-user').textContent`), 'owner');
  assert.equal(await run(`document.querySelector('#session-user').dataset.state`), 'signed-in');
  assert.equal(await run(`document.querySelector('#sign-out').disabled`), false);
  assert.equal(await run(`document.querySelector('#session-status').textContent`), '');
  assert.equal(await run(`${chatLinks('last')}.textContent`), 'Active work');
  await run(click('sessions-tab'));
  assert.equal(await run(`document.querySelector('#include-ended').checked`), false);
  assert.equal(await run(`${list}.childElementCount`), 1);
  assert.ok(await run(`${list}${includes('Queued')}`));
  await run(click('include-ended'));
  assert.equal(await run(`${list}.childElementCount`), 3);
  assert.ok(await run(`${list}${includes('Failed')}`));
  await run(click('include-ended'));

  // Sessions refresh even while an in-flight turn status request has not returned.
  await run(`${click('chat-tab')}; ${click('check-turn')}`);
  assert.equal(await run(refreshDisabled), true);
  const beforePoll = requests.length;
  active.status = 'running';
  active.target = 'pod';
  await waitFor(run, `${list}${includes(target)}`);
  assert.ok(requests.length > beforePoll);
  assert.equal(await run(refreshDisabled), true);

  await run(`${chatLinks('last')}.querySelector('button').click()`);
  await waitFor(run, `${title} === 'Active work' && ${detail}${includes('No transcript yet.')}`);
  assert.equal(await run(`document.activeElement.id`), 'session-title');
  assert.ok(await run(`${detail}${includes('Running')} && ${detail}${includes(target)}`));
  active.status = 'waiting';
  await run(click('refresh-sessions'));
  await waitFor(run, `${detail}${includes('Waiting')}`);
  await run(click('back-to-sessions'));
  assert.ok(await run(`!document.querySelector('#sessions-list-view').hidden`));

  await run(`${click('chat-tab')}; ${fill('Draft survives')}; ${chatLinks('first')}.querySelector('button').click()`);
  await waitFor(run, `${title} === ${JSON.stringify(ended.title)} && ${sessionTranscript}${includes(literal)}`);
  assert.deepEqual(await run(`[...${sessionTranscript}.querySelectorAll('strong')].map(node => node.textContent)`), ['user', 'assistant']);
  assert.ok(await run(`${detail}${includes('Done')} && ${detail}${includes(`Target: ${literal}`)} && ${detail}${includes('Blueprint: review')}`));
  assert.equal(await run(`document.querySelector('[data-untrusted]')`), null);

  detailStatus = 404;
  await run(click('refresh-sessions'));
  await waitFor(run, `${detail}${includes('This session is no longer available.')}`);
  assert.equal(await run(`${sessionTranscript}.childElementCount`), 0);
  detailStatus = 403;
  await run(click('refresh-sessions'));
  await waitFor(run, `${detail}${includes('Sign in as an owner')}`);
  await run(click('back-to-sessions'));

  await run(click('chat-tab'));
  await run(`${chatLinks('last')}.querySelector('button').focus()`);
  active.status = 'done';
  finishTurn.resolve();
  await waitFor(run, `${status}.includes('No active sessions.') && ${logText}.includes('Current reply')`);
  assert.equal(await run(`document.querySelector('#chat-text').value`), 'Draft survives');
  assert.ok(await run(`${chatLinks('last')}${includes('Active work')}`));
  assert.ok(await run(`document.activeElement === ${chatLinks('last')}.querySelector('button')`));
  await run(click('sessions-tab'));
  listStatus = 503;
  await run(click('refresh-sessions'));
  await waitFor(run, `${status}.includes('(503)')`);
  listStatus = 200;
  await run(click('refresh-sessions'));
  await waitFor(run, `${status}.includes('No active sessions.')`);

  assert.ok(requests.some(({ url }) => url === '/api/sessions/active%20task'));
  assert.ok(requests.some(({ url }) => url === '/api/sessions/ended'));
  assert.ok(requests.every(({ method, authorization }) => method === 'GET' && authorization === auth));
  assert.deepEqual(await run(`[localStorage.length, sessionStorage.length]`), [0, 0]);
});

test('browser Inbox answers and declines questions without sending Chat drafts', {
  skip: missingChromium && 'chromium unavailable (set CHROMIUM_BIN)', timeout: 30_000,
}, async (t) => {
  const literal = '<img data-untrusted src=x onerror=alert(1)>';
  const messages = [{ from: 'Agent note', text: literal, createdAt: 0 }];
  const questions = [
    { id: 'question ?/#', parentTurnId: 'parent', prompt: `Which date? ${literal}${'"'.repeat(1200)}`, status: 'open' },
    { id: 'decline', parentTurnId: 'parent', prompt: 'Send another update?', status: 'open' },
    { id: 'decline-receipt', parentTurnId: 'parent', prompt: 'Send a reminder?', status: 'open' },
  ];
  const turns = [{ id: 'parent', status: 'done', text: 'Original request', reply: 'See Inbox' }];
  const continuation = { id: 'follow-up', status: 'pending', activity: 'queued', text: 'Continue with Tuesday' };
  const responses = [];
  let inboxStatus = 200;
  let historyStatus = 200;
  let historyReads = 0;
  let chatPosts = 0;
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css'],
  ].map(async ([path, file, type]) => [path, { type, body: await readFile(new URL(`../src/web/${file}`, import.meta.url)) }])));
  const server = createServer(async (req, res) => {
    const { url, method, headers } = req;
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
    if (url === '/api/sessions') return json({ sessions: [] });
    if (url === '/api/session') return json({ user: 'owner', agent: 'browser', via: 'cookie' });
    if (url === '/api/inbox' && method === 'GET') return json({ messages, questions }, inboxStatus);
    if (url === '/api/turns' && method === 'GET') {
      historyReads++;
      return json({ turns }, historyStatus);
    }
    if (url === '/api/turns' && method === 'POST') chatPosts++;
    if (url.startsWith('/api/inbox/questions/') && method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      responses.push({ url, body, csrf: headers['x-manolo-request'], type: headers['content-type'] });
      const question = questions.find(({ id }) => url === `/api/inbox/questions/${encodeURIComponent(id)}/respond`);
      if (!question) return json({}, 404);
      if (headers['x-manolo-request'] !== '1') return json({}, 403);
      if (responses.length === 1) return json({}, 503); // Nothing persisted; owner can retry after a read.
      if (body.decline) {
        question.status = 'declined';
        if (question.id === 'decline') return json({}, 503); // A fresh read sees the persisted decline.
        return json({ id: question.id, status: question.status });
      }
      question.status = 'answered';
      question.continuationTurnId = continuation.id;
      return json({ id: question.id, status: question.status, continuationTurnId: question.continuationTurnId });
    }
    return json({}, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const openTab = await openBrowser(t);
  const { run, resize } = await openTab(`http://127.0.0.1:${server.address().port}/`);
  await resize(390, 760);
  const question = (index) => `document.querySelector('#inbox-questions > li:nth-child(${index})')`;
  const first = question(1);
  const second = question(2);
  const answer = `${first}.querySelector('textarea')`;
  const answerButton = `${first}.querySelector('button[type="submit"]')`;
  const answerLimit = 1433; // 4000 minus the continuation framing, quoted prompt and two answer quotes.
  const answerText = 'Use Tuesday.'.padEnd(answerLimit, '!');
  const decline = `${second}.querySelector('button[type="button"]')`;
  const view = `${first}.querySelector('button')`;
  const status = `document.querySelector('#inbox-status').textContent`;
  const inboxIdle = `!document.querySelector('#refresh-inbox').disabled`;
  const inboxVisible = `!document.querySelector('#inbox-panel').hidden`;
  await waitFor(run, `!${sendDisabled} && ${first}`);
  assert.equal(await run(`document.querySelector('#session-user').textContent`), 'owner');
  assert.equal(await run(`document.querySelector('#sign-out').disabled`), false);
  assert.equal(await run(`document.querySelector('#sign-out').getBoundingClientRect().width > 0`), true);
  await run(`${fill('Keep this Chat draft')}; ${click('inbox-tab')}`);
  await waitFor(run, inboxIdle);
  assert.ok(await run(`${first}.textContent.includes(${JSON.stringify(questions[0].prompt)})`));
  assert.ok(await run(`document.querySelector('#inbox').textContent.includes(${JSON.stringify(literal)})`));
  assert.equal(await run(`document.querySelector('[data-untrusted]')`), null);
  assert.equal(await run(`document.documentElement.scrollWidth`), 390);
  await run(`${answer}.value = '   '; ${answerButton}.click()`);
  assert.ok(await run(`${status}.includes('Enter an answer')`));
  assert.equal(await run(`${answer}.maxLength`), answerLimit);
  await run(`${answer}.value = '"'.repeat(${answerLimit}); ${answerButton}.click()`);
  assert.ok(await run(`${status}.includes('too long')`));
  assert.equal(responses.length, 0);

  await run(`${answer}.value = ${JSON.stringify(answerText)}; ${answerButton}.click(); ${answerButton}.click(); ${decline}.click()`);
  await waitFor(run, `${inboxIdle} && ${status}.includes('(503)')`);
  assert.equal(await run(`${answer}.value`), answerText);
  assert.ok(await run(`${answerButton}.matches(':disabled') && ${status}.includes('Refresh inbox')`));
  assert.equal(responses.length, 1);
  inboxStatus = 503;
  await run(click('refresh-inbox'));
  await waitFor(run, `${inboxIdle} && ${status}.includes('(503)')`);
  assert.ok(await run(`${answerButton}.matches(':disabled')`));
  inboxStatus = 200;
  await run(click('refresh-inbox'));
  await waitFor(run, `${inboxIdle} && !${answerButton}.matches(':disabled')`);
  assert.equal(await run(`${answer}.value`), answerText);

  const beforeResponse = historyReads;
  await run(`${answerButton}.click()`);
  await waitFor(run, `${first}.textContent.includes('Answered')`);
  assert.equal(await run(`${view}.textContent`), 'Refresh and view in Chat');
  assert.equal(await run(inboxVisible), true);
  assert.equal(historyReads, beforeResponse);
  historyStatus = 503;
  await run(`${view}.click()`);
  await waitFor(run, `${first}.textContent.includes('Could not refresh Chat')`);
  historyStatus = 200;
  await run(`${view}.click()`);
  await waitFor(run, `${first}.textContent.includes('not in recent Chat history')`);
  assert.equal(await run(inboxVisible), true);
  turns.push(continuation, { id: 'unrelated', status: 'done', text: 'Different turn' });
  await run(`${view}.click()`);
  await waitFor(run, `!(${inboxVisible}) && ${logText}.includes('Continue with Tuesday')`);
  assert.equal(await run(`document.activeElement.querySelector('.chat-prompt').textContent`), continuation.text);
  assert.equal(await run(`document.querySelector('#chat-text').value`), 'Keep this Chat draft');
  assert.deepEqual(await run(pendingStates), ['Queued.']);
  assert.equal(await run(sendDisabled), true);
  assert.equal(chatPosts, 0);

  await run(click('inbox-tab'));
  await waitFor(run, inboxIdle);
  assert.equal(await run(`${view}.textContent`), 'Refresh and view in Chat');
  await run(`${decline}.click(); ${decline}.click()`);
  await waitFor(run, `${inboxIdle} && ${status}.includes('Refresh inbox')`);
  await run(click('refresh-inbox'));
  await waitFor(run, `${second}.textContent.includes('Declined')`);
  assert.equal(await run(`${second}.querySelector('form')`), null);
  await run(`${question(3)}.querySelector('button[type="button"]').click()`);
  await waitFor(run, `${question(3)}.textContent.includes('Declined')`);
  assert.equal(await run(status), 'Question declined.');
  assert.equal(await run(`${question(3)}.querySelector('button')`), null);
  assert.deepEqual(responses.map(({ url, body }) => [url, body]), [
    ['/api/inbox/questions/question%20%3F%2F%23/respond', { answer: answerText }],
    ['/api/inbox/questions/question%20%3F%2F%23/respond', { answer: answerText }],
    ['/api/inbox/questions/decline/respond', { decline: true }],
    ['/api/inbox/questions/decline-receipt/respond', { decline: true }],
  ]);
  assert.ok(responses.every(({ csrf, type }) => csrf === '1' && type === 'application/json'));
  assert.equal(chatPosts, 0);
});

test('workspace shows the signed-in user and signs out of the browser session', {
  skip: missingChromium && 'chromium unavailable (set CHROMIUM_BIN)', timeout: 30_000,
}, async (t) => {
  const ownerName = '<b data-untrusted>Ana</b>';
  const sessionRequests = [];
  const logoutRequests = [];
  let logoutStatus = 503;
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css'],
    ['/login', 'login.html', 'text/html'], ['/theme.js', 'theme.js', 'text/javascript'],
  ].map(async ([path, file, type]) => [path, { type, body: await readFile(new URL(`../src/web/${file}`, import.meta.url)) }])));
  const server = createServer((req, res) => {
    const { url, method, headers } = req;
    const json = (body, status = 200, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
      res.end(JSON.stringify(body));
    };
    const asset = assets.get(url);
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(asset.body);
      return;
    }
    if (url === '/api/session') {
      sessionRequests.push(method);
      return json({ user: ownerName, agent: 'browser', via: 'cookie' });
    }
    if (url === '/logout') {
      logoutRequests.push({ method, request: headers['x-manolo-request'] });
      if (method !== 'POST' || headers['x-manolo-request'] !== '1') return json({ error: 'Forbidden' }, 403);
      if (logoutStatus !== 200) return json({}, logoutStatus);
      return json({ ok: true }, 200, { 'set-cookie': 'manolo_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    }
    if (url === '/api/dashboard') return json({ history: [] });
    if (url === '/api/inbox') return json({ messages: [] });
    if (url === '/api/turns') return json({ turns: [] });
    if (url === '/api/sessions') return json({ sessions: [] });
    return json({}, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const openTab = await openBrowser(t);
  const { run } = await openTab(`http://127.0.0.1:${server.address().port}/`);
  const user = `document.querySelector('#session-user')`;
  const signOut = `document.querySelector('#sign-out')`;
  const status = `document.querySelector('#session-status').textContent`;

  await waitFor(run, `${user}.textContent === ${JSON.stringify(ownerName)}`);
  assert.equal(await run(`${user}.dataset.state`), 'signed-in');
  assert.equal(await run(`${user}.children.length`), 0);
  assert.equal(await run(`document.querySelectorAll('#session-user [data-untrusted]').length`), 0);
  assert.equal(await run(`document.querySelector('.session-caption').textContent`), 'Signed in as');
  assert.equal(await run(`${signOut}.textContent`), 'Sign out');
  assert.equal(await run(`${signOut}.disabled`), false);
  assert.equal(await run(status), '');
  assert.deepEqual(sessionRequests, ['GET']);
  const historyBefore = await run('history.length');

  // A failed sign-out keeps the owner signed in and explains why.
  await run(`${signOut}.click()`);
  await waitFor(run, `${status}.includes('still signed in')`);
  assert.ok(await run(`${status}.includes('(503)')`));
  assert.equal(await run('location.pathname'), '/');
  assert.equal(await run(`${user}.textContent`), ownerName);
  assert.equal(await run(`${signOut}.disabled`), false);
  assert.equal(logoutRequests.length, 1);
  assert.deepEqual(logoutRequests[0], { method: 'POST', request: '1' });

  logoutStatus = 200;
  await run(`${signOut}.click()`);
  await waitFor(run, `document.querySelector('#login-form') !== null`);
  assert.equal(await run('location.pathname'), '/login');
  assert.equal(await run(`document.querySelector('#session-user')`), null);
  assert.equal(await run(`document.querySelector('#workspace-tabs')`), null);
  assert.equal(await run('history.length'), historyBefore); // location.replace added no entry
  assert.deepEqual(logoutRequests, [
    { method: 'POST', request: '1' },
    { method: 'POST', request: '1' },
  ]);
});

test('workspace whose session probe returns 401 goes to the sign-in page', {
  skip: missingChromium && 'chromium unavailable (set CHROMIUM_BIN)', timeout: 30_000,
}, async (t) => {
  let sessionProbes = 0;
  let loginPages = 0;
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css'],
    ['/login', 'login.html', 'text/html'], ['/theme.js', 'theme.js', 'text/javascript'],
  ].map(async ([path, file, type]) => [path, { type, body: await readFile(new URL(`../src/web/${file}`, import.meta.url)) }])));
  const server = createServer((req, res) => {
    const { url } = req;
    const json = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url === '/login') loginPages++;
    const asset = assets.get(url);
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(asset.body);
      return;
    }
    if (url === '/api/session') sessionProbes++;
    return json({ error: 'Sign in as an owner' }, 401);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const openTab = await openBrowser(t);
  await openTab(`http://127.0.0.1:${server.address().port}/`);

  // location.replace discards the workspace document, so its CDP execution context cannot be
  // queried afterwards. Prove the redirect from the server side instead: one session probe and
  // exactly one sign-in page request, from one workspace load.
  for (let i = 0; i < 100 && !(sessionProbes === 1 && loginPages === 1); i++) await sleep(50);
  assert.equal(sessionProbes, 1);
  assert.equal(loginPages, 1);

  // The sign-in page is a real page: login chrome present, workspace chrome absent.
  const login = await openTab(`http://127.0.0.1:${server.address().port}/login`);
  await waitFor(login.run, `document.querySelector('#login-form') !== null`);
  assert.equal(await login.run('location.pathname'), '/login');
  assert.equal(await login.run(`document.querySelector('#session-user')`), null);
  assert.equal(await login.run(`document.querySelector('#sign-out')`), null);
  assert.equal(await login.run(`document.querySelector('#session-status')`), null);
  assert.equal(await login.run(`document.querySelector('#workspace-tabs')`), null);
  assert.equal(await login.run(`document.querySelector('#chat-panel')`), null);
  assert.equal(loginPages, 2); // The workspace redirect plus this explicit visit.
  assert.equal(sessionProbes, 1);
});
