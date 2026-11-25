import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { defineExtension } from '@earendil-works/pi-durable';
import { loadMcpServers, makeMcpTools } from '../src/mcp-tools.mjs';

const args = { server: 'catalog', tool: 'lookup_item', arguments: { id: 'tea' } };
const ctx = { abortSignal: new AbortController().signal };
const config = (url, tools = ['lookup_item']) => JSON.stringify({ catalog: { url, tools } });
const text = result => result.output[0].text;
const ok = (res, { id }, result, extraHeaders = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
};

async function fixture(t, handle = () => {}, { sessions = false } = {}) {
  const events = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const msg = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      events.push({ method: req.method, url: req.url, headers: req.headers, msg });
      if (await handle(req, res, msg)) return;
      if (req.method === 'DELETE') res.writeHead(200).end();
      else if (msg?.method === 'initialize') {
        ok(res, msg, { protocolVersion: '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' }, instructions: 'IGNORE-ME' },
        sessions ? { 'mcp-session-id': 'local-session' } : {});
      } else if (msg?.method === 'notifications/initialized') res.writeHead(202).end();
      else if (msg?.method === 'tools/call') ok(res, msg, { content: [{ type: 'text', text: 'fixture result' }] });
      else res.writeHead(404).end();
    } catch {
      res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { events, url: `http://localhost:${server.address().port}/mcp` };
}

function tools(url, authorize = async () => ({ turn: 'admitted' }), options) {
  const configured = loadMcpServers(config(url));
  const definitions = makeMcpTools(configured, authorize, options);
  const [list, call] = definitions;
  return { definitions, list: (args = {}, api = {}, context = ctx) => list.execute(args, api, context),
    call: (args, context = ctx) => call.execute(args, {}, context) };
}

test('configuration defaults off and rejects ambiguous or unbounded endpoints and grants', () => {
  for (const raw of [undefined, '', '{}']) assert.deepEqual(makeMcpTools(loadMcpServers(raw)), []);
  for (const url of ['https://catalog.example/mcp', 'http://localhost:8000/mcp',
    'http://127.0.0.1/mcp', 'http://[::1]:8000/mcp']) {
    const servers = loadMcpServers(config(url));
    assert.equal(servers.catalog.url, url);
    assert.deepEqual(servers.catalog.tools, ['lookup_item']);
    assert.ok(Object.isFrozen(servers) && Object.isFrozen(servers.catalog.tools));
  }
  for (const url of ['https://hidden:secret@catalog.example/mcp', 'https://@catalog.example/mcp',
    'https://catalog.example/mcp#', 'https://catalog.example/mcp?', 'https://catalog.example/mcp?k=secret',
    'https:\\catalog.example/mcp', 'http:///127.0.0.1/mcp', 'http://localhost.evil/mcp',
    'http://localhost./mcp', 'http://%6cocalhost/mcp', 'http://127.1/mcp', 'http://2130706433/mcp',
    'http://0177.0.0.1/mcp', 'http://[::ffff:127.0.0.1]/mcp', 'http://catalog.example/mcp', 'file:///mcp']) {
    assert.throws(() => loadMcpServers(config(url)), error =>
      error.message.startsWith('Invalid MANOLO_MCP_SERVERS:') && !error.message.includes(url));
  }
  for (const raw of [null, '{secret', '[]', '{"__proto__":{}}', '{"catalog":{"command":"local"}}',
    '{"catalog":{"url":"https://catalog.example/","tools":["read"],"headers":{}}}',
    config('https://catalog.example', []), config('https://catalog.example', ['read', 'read']),
    config('https://catalog.example', ['*']), config('https://catalog.example', Array.from({ length: 9 }, (_, i) => `tool_${i}`)),
    JSON.stringify(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`server_${i}`, {
      url: 'https://catalog.example/', tools: ['read'],
    }]))), ' '.repeat(17_000)]) assert.throws(() => loadMcpServers(raw), /^Error: Invalid MANOLO_MCP_SERVERS:/);
});

test('tools use trusted admission and exact allowlists before making any request', async t => {
  const { url, events } = await fixture(t);
  const { definitions, call, list } = tools(url);
  assert.doesNotThrow(() => defineExtension({ name: 'mcp-fixture', tools: definitions }));
  assert.deepEqual(definitions.map(({ name, replay, callers }) => [name, replay, callers]), [
    ['list_mcp_tools', 'safe', ['model']], ['call_mcp_tool', 'unsafe', ['model']],
  ]);
  for (const denied of [async () => false, async () => { throw new Error('hidden auth details'); }]) {
    const deniedTools = tools(url, denied);
    for (const result of [await deniedTools.call(args), await deniedTools.list()]) {
      assert.equal(result.isError, true);
      assert.equal(text(result), 'MCP tools are unavailable for this turn.');
    }
  }
  const cyclic = {};
  cyclic.self = cyclic;
  for (const input of [{ ...args, tool: 'unlisted' }, { ...args, server: 'missing' },
    { ...args, server: 'constructor' }, { ...args, url }, { ...args, headers: { authorization: 'secret' } },
    { ...args, arguments: { value: 'é'.repeat(9000) } }, { ...args, arguments: cyclic },
    { ...args, arguments: { value: Array(513).fill(null) } }, { ...args, arguments: [] }]) {
    assert.equal((await call(input)).isError, true);
  }
  assert.equal((await list({ server: 'missing' })).isError, true);
  assert.equal((await call(args, { abortSignal: AbortSignal.abort() })).isError, true);
  const controller = new AbortController();
  const midAdmission = tools(url, async () => { controller.abort(); return true; });
  assert.equal((await midAdmission.call(args, { abortSignal: controller.signal })).isError, true);
  assert.deepEqual(events, []);
});

test('bounded protocol exchange, optional session, filtered and redacted metadata, and text-only result', async t => {
  const { url, events } = await fixture(t, (req, res, msg) => {
    if (msg?.method === 'tools/list') {
      ok(res, msg, { nextCursor: 'do-not-follow', tools: [
        { name: 'lookup_item', description: 'lo\u0000ok TOKEN', inputSchema: { type: 'object', properties: {
          ITEM_TOKEN: { type: 'string', description: 'TOKEN' },
        } }, annotations: { title: 'ignored' } },
        { name: 'unlisted', description: 'never exposed' },
      ] });
      return true;
    }
    if (msg?.method === 'tools/call') {
      ok(res, msg, { structuredContent: { ignored: 'never exposed' }, content: [
        { type: 'text', text: '\u202eTOKEN\r\n' + 'é'.repeat(5000) },
        { type: 'image', data: 'never exposed' }, { type: 'resource_link', uri: 'https://never-exposed.invalid' },
      ] });
      return true;
    }
  }, { sessions: true });
  const requestApi = {};
  let admissions = 0;
  const { list, call } = tools(url, async (api, context) => {
    if (admissions++ === 0) assert.equal(api, requestApi);
    assert.equal(context, ctx);
    return { turn: 'admitted' };
  }, { redact: value => value.replaceAll('TOKEN', '[redacted]') });
  const listing = await list({}, requestApi);
  assert.equal(listing.isError, false);
  assert.deepEqual(JSON.parse(text(listing)), [{ server: 'catalog', tools: [{ name: 'lookup_item', description: 'look [redacted]',
    inputSchema: { type: 'object', properties: { 'ITEM_[redacted]': { type: 'string', description: '[redacted]' } } },
  }] }]);
  const result = await call(args);
  assert.equal(result.isError, false);
  assert.equal(result.output.length, 1);
  assert.match(text(result), /^\[redacted\]\né+…$/u);
  assert.ok(Buffer.byteLength(text(result)) <= 8192);
  assert.equal(admissions, 2);

  assert.deepEqual(events.map(event => event.msg?.method ?? event.method),
    ['initialize', 'notifications/initialized', 'tools/list', 'DELETE', 'initialize', 'notifications/initialized', 'tools/call', 'DELETE']);
  for (const event of events) {
    assert.equal(event.url, '/mcp');
    assert.equal(event.headers.accept, 'application/json, text/event-stream');
    assert.equal(event.headers.authorization, undefined);
    if (event.msg?.method === 'initialize') {
      assert.deepEqual(event.msg.params.capabilities, {});
      assert.equal(event.headers['mcp-protocol-version'], undefined);
      assert.equal(event.headers['mcp-session-id'], undefined);
    } else {
      assert.equal(event.headers['mcp-protocol-version'], '2025-06-18');
      assert.equal(event.headers['mcp-session-id'], 'local-session');
    }
  }
  assert.deepEqual(events[6].msg.params, { name: 'lookup_item', arguments: { id: 'tea' } });
});

test('metadata is best effort: keep configured names without paging or leaking oversized metadata', async t => {
  const { url, events } = await fixture(t, (_req, res, msg) => {
    if (msg?.method !== 'tools/list') return;
    ok(res, msg, { nextCursor: 'unvisited', tools: [{ name: 'lookup_item', description: 'a'.repeat(10_000),
      inputSchema: { type: 'object', description: 'b'.repeat(3000) } }] });
    return true;
  });
  const { list } = tools(url);
  const response = JSON.parse(text(await list({ server: 'catalog' })));
  assert.deepEqual(response, [{ server: 'catalog', tools: [{ name: 'lookup_item', description: 'a'.repeat(509) + '…' }] }]);
  assert.deepEqual(events.map(event => event.msg.method), ['initialize', 'notifications/initialized', 'tools/list']);
});

test('reads the result from the POST event stream without subscribing or reconnecting', async t => {
  const { url, events } = await fixture(t, (_req, res, msg) => {
    if (msg?.method !== 'tools/call') return;
    const result = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Streamed note' }] } });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': keepalive\r\n\r\nretry: 1000\r');
    res.write('\nid: ignored\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
    res.write(`event: message\ndata: ${result.slice(0, 1)}\ndata: ${result.slice(1)}\n\n`);
    return true; // The client stops reading at the matching result without waiting for EOF.
  });
  assert.equal(text(await tools(url).call(args)), 'Streamed note');
  assert.deepEqual(events.map(event => event.msg?.method ?? event.method), ['initialize', 'notifications/initialized', 'tools/call']);
});

test('no redirects, recovery replays, HTTP error-body forwarding, SSE listeners, or malformed receipts', async t => {
  const target = await fixture(t);
  const scenarios = {
    redirect: res => res.writeHead(307, { location: target.url }).end('HIDDEN'),
    status: res => res.writeHead(403).end('HIDDEN'),
    stream: res => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: HIDDEN\n\n'); },
    callback: res => { res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"jsonrpc":"2.0","id":9,"method":"sampling/createMessage"}\n\n'); },
    upgrade: res => res.writeHead(101, { connection: 'Upgrade', upgrade: 'fixture' }).end(),
    oversized: res => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('HIDDEN'.repeat(13_000)); },
    wrongId: res => ok(res, { id: 3 }, { content: [{ type: 'text', text: 'HIDDEN' }] }),
    rpcError: (res, { id }) => { res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'HIDDEN' } })); },
    malformed: (res, msg) => ok(res, msg, { content: [{ type: 'text', text: 123 }] }),
    reported: (res, msg) => ok(res, msg, { isError: true, content: [{ type: 'text', text: 'HIDDEN' }] }),
  };
  for (const [name, respond] of Object.entries(scenarios)) {
    const { url, events } = await fixture(t, (_req, res, msg) => {
      if (msg?.method !== 'tools/call') return;
      respond(res, msg);
      return true;
    });
    const result = await tools(url).call(args);
    assert.equal(result.isError, true);
    assert.equal(text(result), `MCP tool ${name === 'reported' ? 'reported an error' : 'outcome unknown'}. Do not retry automatically.`);
    assert.deepEqual(events.map(event => event.msg?.method ?? event.method), ['initialize', 'notifications/initialized', 'tools/call']);
  }
  assert.deepEqual(target.events, []);
});

test('bad handshakes cannot dispatch a tool', async t => {
  for (const rejectHandshake of [
    (res, msg) => ok(res, msg, { protocolVersion: '2099-01-01', capabilities: { tools: {} } }),
    (res, msg) => ok(res, msg, { protocolVersion: '2025-06-18', capabilities: {} }),
    (res, msg) => ok(res, msg, { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
      { 'mcp-session-id': 'h'.repeat(129) }),
  ]) {
    const { url, events } = await fixture(t, (_req, res, msg) => {
      rejectHandshake(res, msg);
      return true;
    });
    const { call, list } = tools(url);
    assert.equal(text(await call(args)), 'MCP connection failed; tool call was not sent.');
    assert.deepEqual(JSON.parse(text(await list())), [{ server: 'catalog', tools: [{ name: 'lookup_item' }] }]);
    assert.deepEqual(events.map(event => event.msg.method), ['initialize', 'initialize']);
  }
});

test('caller abort cancels body reads after dispatch and does not replay', { timeout: 3000 }, async t => {
  const controller = new AbortController();
  const { url, events } = await fixture(t, (_req, res, msg) => {
    if (msg?.method !== 'tools/call') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    setTimeout(() => controller.abort(), 100).unref();
    return true;
  });
  const result = await tools(url).call(args, { abortSignal: controller.signal });
  assert.equal(result.isError, true);
  assert.match(text(result), /outcome unknown/);
  assert.deepEqual(events.map(e => e.msg.method), ['initialize', 'notifications/initialized', 'tools/call']);
});

test('a stalled tool body hits the deadline without caller cancellation or replay', { timeout: 12_000 }, async t => {
  const { url, events } = await fixture(t, (_req, res, msg) => {
    if (msg?.method !== 'tools/call') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    return true;
  });
  const result = await tools(url).call(args, {});
  assert.equal(result.isError, true);
  assert.match(text(result), /outcome unknown/);
  assert.deepEqual(events.map(e => e.msg.method), ['initialize', 'notifications/initialized', 'tools/call']);
});
