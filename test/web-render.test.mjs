import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';

// The same Chromium-driven helper the other web tests use: this file only needs a page, not chat recovery.
const chromium = process.env.CHROMIUM_BIN ?? 'chromium';
const { spawnSync } = await import('node:child_process');
const missingChromium = spawnSync(chromium, ['--version']).error?.code === 'ENOENT';
const { spawn } = await import('node:child_process');
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { setTimeout: sleep } = await import('node:timers/promises');

async function openBrowser(t) {
  const profile = await mkdtemp(join(tmpdir(), 'manolo-render-test-'));
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
    return { run, reload: () => send('Page.reload', {}, sessionId), resize: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId) };
  };
}

async function waitFor(run, expression) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await run(expression)) return;
    await sleep(50);
  }
  assert.fail(`Browser did not reach: ${expression}`);
}

const MARKDOWN = [
  '## Deploy notes',
  '',
  'The relay is **healthy** and the worker answered.',
  '',
  '- first item',
  '- second item',
  '',
  '| host | state |',
  '| --- | --- |',
  '| beast | ready |',
  '',
  '```js',
  "const ok = true;",
  '```',
  '',
  '```mermaid',
  'stateDiagram-v2',
  '  [*] --> Idle',
  '  Idle --> Busy: start',
  '  Busy --> Idle: done',
  '```',
  '',
  '<script>window.__pwned = true;</script>',
  '',
  '[click me](javascript:alert(1))',
  '',
  '![remote pixel](https://evil.example/pixel.png)',
  '',
  '```mermaid',
  'stateDiagram-v2',
  '  [*] --> X: </text><script>window.__pwned2 = true;</script>',
  '```',
  '',
  '```mermaid',
  'sankey-beta',
  '',
  'Solar,House,8',
  'Grid,House,5',
  'Grid,Car,3',
  '```',
].join('\n');

test('model markdown, Mermaid, the theme picker and the capabilities review render in the workspace', { skip: missingChromium && 'chromium unavailable (set CHROMIUM_BIN)', timeout: 60_000 }, async t => {
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'],
    ['/style.css', 'style.css', 'text/css'], ['/theme.js', 'theme.js', 'text/javascript'],
    ['/markdown.mjs', 'markdown.mjs', 'text/javascript'],
  ].map(async ([path, file, type]) => [path, { type, body: await readFile(new URL(`../src/web/${file}`, import.meta.url)) }])));
  const vendor = new Map([
    ['/vendor/markdown-it.min.js', await readFile(new URL('../node_modules/markdown-it/dist/markdown-it.min.js', import.meta.url))],
    ['/vendor/pele.js', await readFile(new URL('../node_modules/pele/dist/pele.js', import.meta.url))],
  ]);
  const turns = [{ id: 'saved', text: 'Write the deploy notes', createdAt: 1, status: 'done', reply: MARKDOWN }];
  const server = createServer(async (req, res) => {
    const { url, method } = req;
    const json = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const asset = assets.get(url);
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      return res.end(asset.body);
    }
    if (vendor.has(url)) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(vendor.get(url));
    }
    if (url === '/api/session') return json({ user: 'owner', agent: 'primary', via: 'cookie', browser: false });
    if (url === '/api/dashboard') return json({ history: [] });
    if (url === '/api/inbox') return json({ messages: [], questions: [] });
    if (url === '/api/sessions') return json({ sessions: [] });
    if (url === '/api/mcp') return json({ servers: [], error: null, config: '{"mcpServers":{}}' });
    if (url === '/api/capabilities') {
      return json({
        agent: { id: 'primary', instructions: 'You are Manolo, a private assistant.' },
        tools: [{ name: 'bash', description: 'Run a shell command', source: 'coding-tools' }],
        blueprints: [{ id: 'review', description: 'Review short project notes' }],
        agentsFiles: [{ path: 'AGENTS.md', bytes: 42 }],
        skills: [{ name: 'statechart', description: 'Draw a system as a Mermaid statechart', path: '.agents/skills/statechart/SKILL.md', source: '.agents' }],
      });
    }
    if (url === '/api/turns' && method === 'GET') return json({ turns });
    return json({}, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });

  const openTab = await openBrowser(t);
  const { run, reload } = await openTab(`http://127.0.0.1:${server.address().port}/`);
  await waitFor(run, `document.querySelectorAll('#chat-log > li').length === 1`);

  // Markdown: headings, emphasis, lists, tables and fenced code become real elements, not literal text.
  await waitFor(run, `!!document.querySelector('#chat-log h2')`);
  assert.equal(await run(`document.querySelector('#chat-log h2').textContent`), 'Deploy notes');
  assert.equal(await run(`document.querySelectorAll('#chat-log .markdown ul li').length`), 2);
  assert.equal(await run(`document.querySelector('#chat-log .markdown strong').textContent`), 'healthy');
  assert.equal(await run(`document.querySelectorAll('#chat-log table th').length`), 2);
  assert.equal(await run(`document.querySelector('#chat-log pre code').textContent.trim()`), 'const ok = true;');
  // Raw HTML in model text must never become markup, a javascript: link never becomes a link, and no remote image is
  // fetched: the reply is text plus safe elements.
  assert.equal(await run(`document.querySelectorAll('#chat-log script').length`), 0);
  assert.equal(await run(`window.__pwned === undefined && window.__pwned2 === undefined`), true);
  assert.equal(await run(`document.querySelectorAll('#chat-log img').length`), 0);
  assert.equal(await run(`[...document.querySelectorAll('#chat-log a')].every(a => /^https?:|^mailto:/.test(a.getAttribute('href')))`), true);
  assert.equal(await run(`document.querySelector('#chat-log').textContent.includes('window.__pwned')`), true);
  assert.equal(await run(`[...document.querySelectorAll('#chat-log a')].every(a => a.rel === 'noopener noreferrer' && a.target === '_blank')`), true);
  // Renamed ids must still resolve: a diagram whose paint attributes point at url(#…) keeps every reference local.
  await waitFor(run, `document.querySelectorAll('.md-diagram svg').length >= 3`);
  assert.equal(await run(`[...document.querySelectorAll('.md-diagram svg')].every(svg => {
    const ids = new Set([...svg.querySelectorAll('[id]')].map(node => node.getAttribute('id')));
    const refs = [...svg.querySelectorAll('*')].flatMap(node => [...node.attributes]
      .filter(attribute => attribute.value.includes('url('))
      .flatMap(attribute => [...attribute.value.matchAll(/url\\(\\s*['"]?#([^)'"]+)/g)].map(match => match[1])));
    return refs.every(id => ids.has(id));
  })`), true);

  // Mermaid: the fence is drawn as SVG by Pele, with the source available underneath.
  await waitFor(run, `!!document.querySelector('.md-diagram svg.pele')`);
  assert.ok(await run(`document.querySelector('.md-diagram svg').querySelectorAll('*').length > 3`));
  assert.equal(await run(`document.querySelector('.md-diagram svg').getAttribute('style')`), null);
  assert.equal(await run(`document.querySelector('.md-diagram details pre').textContent.includes('stateDiagram-v2')`), true);

  // Theme: Solarized Light applies through a data attribute and survives a reload.
  assert.equal(await run(`document.documentElement.dataset.theme`), 'dark');
  await run(`document.getElementById('theme-select').value = 'solarized-light'; document.getElementById('theme-select').dispatchEvent(new Event('change'))`);
  assert.equal(await run(`document.documentElement.dataset.theme`), 'solarized-light');
  assert.equal(await run(`getComputedStyle(document.body).backgroundColor`), 'rgb(253, 246, 227)');
  assert.equal(await run(`localStorage.getItem('manolo.theme')`), 'solarized-light');
  await reload();
  await waitFor(run, `document.documentElement.dataset.theme === 'solarized-light'`);
  assert.equal(await run(`document.getElementById('theme-select').value`), 'solarized-light');

  // Capabilities: instructions, tools, blueprints, skills and AGENTS.md in one review surface.
  await run(`document.getElementById('capabilities-tab').click()`);
  await waitFor(run, `document.getElementById('capability-instructions').textContent.includes('You are Manolo')`);
  assert.equal(await run(`document.getElementById('capabilities-panel').hidden`), false);
  assert.equal(await run(`document.getElementById('capability-tools').textContent.includes('bash')`), true);
  assert.equal(await run(`document.getElementById('capability-blueprints').textContent.includes('review')`), true);
  assert.equal(await run(`document.getElementById('capability-skills').textContent.includes('.agents/skills/statechart/SKILL.md')`), true);
  assert.equal(await run(`document.getElementById('capability-agents-files').textContent.includes('AGENTS.md')`), true);
});
