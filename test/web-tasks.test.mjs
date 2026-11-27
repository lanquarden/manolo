import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const chromium = process.env.CHROMIUM_BIN ?? 'chromium';
const missingChromium = spawnSync(chromium, ['--version']).error?.code === 'ENOENT';

async function openBrowser(t) {
  const profile = await mkdtemp(join(tmpdir(), 'manolo-tasks-web-'));
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
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    awaiting.set(id, (error, result) => error ? reject(error) : resolve(result));
    child.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
  });
  return async function openTab(url) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const run = async (expression) => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      assert.ok(!exceptionDetails, result?.description ?? 'page exception');
      return result.value;
    };
    await send('Page.navigate', { url }, sessionId);
    return { run, resize: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId) };
  };
}

async function waitFor(run, expression) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await run(expression)) return;
    await sleep(50);
  }
  assert.fail(`Browser did not reach: ${expression}`);
}

const revision = 'a'.repeat(64);
const notBefore = new Date(Date.now() + 3_600_000).toISOString();
const tasks = [
  { id: '1'.repeat(32), title: 'Quarterly review', status: 'queued', scheduled: true, notBefore,
    createdAt: '2026-01-01T08:00:00.000Z', blueprint: { id: 'review', revision }, originTurnId: 'turn-1' },
  { id: '2'.repeat(32), title: 'Kitchen inventory', status: 'queued', scheduled: false,
    createdAt: '2026-01-01T09:00:00.000Z', originTurnId: 'turn-2' },
  { id: '3'.repeat(32), title: 'Draft the lease summary', status: 'running', scheduled: false,
    createdAt: '2026-01-01T10:00:00.000Z', blueprint: { id: 'review', revision }, originTurnId: 'turn-3',
    progress: 'Read three of five pages' },
  { id: '4'.repeat(32), title: 'Pick a moving date', status: 'waiting', scheduled: false,
    createdAt: '2026-01-01T11:00:00.000Z', blueprint: { id: 'moving', revision }, originTurnId: 'turn-4',
    inboxItem: { id: 'a'.repeat(32), kind: 'question', prompt: 'Which weekday suits you?', status: 'open' } },
  { id: '5'.repeat(32), title: 'Old report', status: 'done', scheduled: false,
    createdAt: '2026-01-01T07:00:00.000Z', blueprint: { id: 'review', revision }, originTurnId: 'turn-5',
    outcome: 'Sent the summary.' },
  { id: '6'.repeat(32), title: 'Broken import', status: 'failed', scheduled: false,
    createdAt: '2026-01-01T06:00:00.000Z', originTurnId: 'turn-6', failure: 'The pinned blueprint revision is no longer available.' },
  { id: '7'.repeat(32), title: 'Abandoned draft', status: 'cancelled', scheduled: false,
    createdAt: '2026-01-01T05:00:00.000Z', originTurnId: 'turn-7' },
];
const events = [
  { taskId: '4'.repeat(32), kind: 'inbox', text: 'Task “Pick a moving date” is waiting for input: Which weekday suits you?', createdAt: '2026-01-01T11:01:00.000Z' },
  { taskId: '5'.repeat(32), kind: 'outcome', text: 'Task “Old report” finished.', createdAt: '2026-01-01T11:02:00.000Z' },
];
const responses = [];
const cancellations = [];

test('the Tasks view groups active work, filters history, answers a Task item, and shows durable notices', {
  skip: missingChromium && 'chromium unavailable (set CHROMIUM_BIN)', timeout: 40_000,
}, async (t) => {
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css'],
    ['/theme.js', 'theme.js', 'text/javascript'],
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
    if (url === '/api/session') return json({ user: 'owner', agent: 'browser', via: 'cookie', browser: false });
    if (url === '/api/dashboard') return json({ history: [] });
    if (url === '/api/turns') return json({ turns: [] });
    if (url === '/api/inbox') {
      return json({
        messages: [],
        taskItems: [{ id: 'a'.repeat(32), taskId: '4'.repeat(32), taskTitle: 'Pick a moving date', kind: 'question',
          prompt: 'Which weekday suits you?', createdAt: '2026-01-01T11:01:00.000Z' }],
      });
    }
    if (url === '/api/tasks/events') return json({ events });
    if (url === '/api/tasks' && method === 'GET') return json({ tasks });
    if (url === '/api/tasks' && method === 'POST') return json({}, 405);
    const respond = /^\/api\/tasks\/([0-9a-f]{32})\/inbox\/([0-9a-f]{32})\/respond$/.exec(url);
    if (respond && method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      responses.push({ taskId: respond[1], itemId: respond[2], body: JSON.parse(body), headers: req.headers });
      return json({ itemId: respond[2], taskId: respond[1], status: 'answered', taskStatus: 'queued' });
    }
    const cancel = /^\/api\/tasks\/([0-9a-f]{32})\/cancel$/.exec(url);
    if (cancel && method === 'POST') {
      cancellations.push({ taskId: cancel[1], headers: req.headers });
      const task = tasks.find(row => row.id === cancel[1]);
      task.status = 'cancelled';
      delete task.progress;
      return json(task);
    }
    const detail = /^\/api\/tasks\/([0-9a-f]{32})$/.exec(url);
    if (detail && method === 'GET') {
      const task = tasks.find(row => row.id === detail[1]);
      if (!task) return json({}, 404);
      return json({
        task: { ...task, input: 'Do the work.', items: task.inboxItem
          ? [{ ...task.inboxItem, createdAt: '2026-01-01T11:01:00.000Z' }] : [],
        progress: task.progress ? [{ note: task.progress, at: '2026-01-01T10:05:00.000Z' }] : [] },
        transcript: [{ role: 'user', text: 'Do the work.' }],
      });
    }
    if (url.startsWith('/api/runtimes') || url.startsWith('/api/mcp') || url.startsWith('/api/capabilities')) return json({}, 404);
    return json({}, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const openTab = await openBrowser(t);
  const { run } = await openTab(url);
  await waitFor(run, `document.querySelector('#session-user')?.dataset.state === 'signed-in'`);
  await waitFor(run, `document.querySelector('#task-notices')?.childElementCount === 2`);

  // 1. The chat carries durable Task notices with a way into the Task, not a synthetic user turn.
  assert.equal(await run(`document.querySelector('#chat-log').childElementCount`), 0);
  assert.deepEqual(await run(`[...document.querySelectorAll('#task-notices .task-notice .plain-text')].map(node => node.textContent)`), [
    'Task “Pick a moving date” is waiting for input: Which weekday suits you?',
    'Task “Old report” finished.',
  ]);

  // 2. The Tasks tab: active groups, then blueprint groups, then titles.
  await run(`document.getElementById('tasks-tab').click()`);
  await waitFor(run, `document.querySelectorAll('#task-tree .task-group').length === 4`);
  assert.deepEqual(await run(`[...document.querySelectorAll('#task-tree .task-group > h2 > span:first-child')].map(node => node.textContent)`),
    ['Scheduled', 'Queued', 'Running', 'Waiting for input']);
  assert.deepEqual(await run(`[...document.querySelectorAll('#task-tree .task-group')].map(group => [group.dataset.group,
    [...group.querySelectorAll('.task-blueprint > h3')].map(node => node.textContent),
    [...group.querySelectorAll('.task-link')].map(node => node.textContent)])`), [
    ['scheduled', ['review'], ['Quarterly review']],
    ['queued', ['No blueprint'], ['Kitchen inventory']],
    ['running', ['review'], ['Draft the lease summary']],
    ['waiting', ['moving'], ['Pick a moving date']],
  ]);
  assert.ok(await run(`document.querySelector('.task-group[data-group="running"] .task-link').closest('li').textContent.includes('Read three of five pages')`));
  assert.ok(await run(`document.querySelector('.task-group[data-group="waiting"] .task-link').closest('li').textContent.includes('Waiting for your answer')`));

  // 3. History starts with terminal Tasks and obeys the status, blueprint and text filters.
  assert.deepEqual(await run(`[...document.querySelectorAll('#task-history .task-link')].map(node => node.textContent)`),
    ['Old report', 'Broken import', 'Abandoned draft']);
  await run(`document.querySelector('#task-filter-status').value = 'all'; document.querySelector('#task-filter-status').dispatchEvent(new Event('change'))`);
  assert.equal(await run(`document.querySelectorAll('#task-history .task-link').length`), 7);
  await run(`document.querySelector('#task-filter-blueprint').value = 'review'; document.querySelector('#task-filter-blueprint').dispatchEvent(new Event('change'))`);
  assert.deepEqual(await run(`[...document.querySelectorAll('#task-history .task-link')].map(node => node.textContent)`),
    ['Quarterly review', 'Draft the lease summary', 'Old report']);
  await run(`document.querySelector('#task-filter-blueprint').value = ''; document.querySelector('#task-filter-blueprint').dispatchEvent(new Event('change'))`);
  await run(`document.querySelector('#task-filter-text').value = 'import'; document.querySelector('#task-filter-text').dispatchEvent(new Event('input'))`);
  assert.deepEqual(await run(`[...document.querySelectorAll('#task-history .task-link')].map(node => node.textContent)`), ['Broken import']);
  await run(`document.querySelector('#task-filter-text').value = ''; document.querySelector('#task-filter-text').dispatchEvent(new Event('input'))`);

  // 4. A waiting Task's detail answers its Inbox item, which queues the same Task.
  await run(`document.querySelector('#task-filter-status').value = 'history'; document.querySelector('#task-filter-status').dispatchEvent(new Event('change'))`);
  await run(`document.querySelector('.task-group[data-group="waiting"] .task-link').click()`);
  await waitFor(run, `document.getElementById('task-detail').hidden === false && document.getElementById('task-detail-inbox-body').textContent.includes('Which weekday suits you?')`);
  assert.equal(await run(`document.getElementById('task-detail-title').textContent`), 'Pick a moving date');
  assert.ok(await run(`document.getElementById('task-detail-meta').textContent.includes('Blueprint: moving')`));
  await run(`document.querySelector('#task-detail-inbox-form textarea').value = 'Tuesday'`);
  await run(`document.querySelector('#task-detail-inbox-form form').requestSubmit()`);
  await waitFor(run, `document.getElementById('task-detail-status').textContent.includes('Answer sent')`);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].taskId, '4'.repeat(32));
  assert.equal(responses[0].itemId, 'a'.repeat(32));
  assert.deepEqual(responses[0].body, { answer: 'Tuesday' });
  assert.equal(responses[0].headers['x-manolo-request'], '1');

  // 5. Cancelling from the detail stops a running Task without a dialog.
  await run(`document.getElementById('back-to-tasks').click()`);
  await waitFor(run, `document.getElementById('tasks-list-view').hidden === false`);
  await run(`document.querySelector('.task-group[data-group="running"] .task-link').click()`);
  await waitFor(run, `document.getElementById('cancel-task').hidden === false`);
  await run(`document.getElementById('cancel-task').click()`);
  await waitFor(run, `document.getElementById('task-detail-status').textContent.includes('cancelled')`);
  assert.deepEqual(cancellations.map(entry => entry.taskId), ['3'.repeat(32)]);
  assert.equal(cancellations[0].headers['x-manolo-request'], '1');

  // 6. The Inbox tab lists the same Task item and answers it from there.
  await run(`document.getElementById('inbox-tab').click()`);
  await waitFor(run, `document.querySelectorAll('#inbox-tasks .inbox-question').length === 1`);
  assert.ok(await run(`document.getElementById('inbox-tasks').textContent.includes('Pick a moving date')`));
  assert.ok(await run(`document.getElementById('inbox-tasks').textContent.includes('Which weekday suits you?')`));
  await run(`document.querySelector('#inbox-tasks textarea').value = 'Wednesday'`);
  await run(`document.querySelector('#inbox-tasks form').requestSubmit()`);
  await waitFor(run, `document.querySelectorAll('#inbox-tasks .inbox-question').length === 1 && document.querySelector('#inbox-tasks .question-state[role="status"]')?.textContent.includes('Answer sent')`);
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[1].body, { answer: 'Wednesday' });

  // 7. A notice opens its Task.
  await run(`document.getElementById('chat-tab').click()`);
  await run(`[...document.querySelectorAll('#task-notices .task-notice button')].at(-1).click()`);
  await waitFor(run, `document.getElementById('tasks-panel').hidden === false && document.getElementById('task-detail-title').textContent === 'Old report'`);
  await waitFor(run, `document.getElementById('task-detail-meta').textContent.includes('Outcome: Sent the summary.')`);
  assert.equal(await run(`document.getElementById('cancel-task').hidden`), true);
});
