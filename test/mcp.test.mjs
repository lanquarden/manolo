import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { exposureFor, parseMcpConfig } from '../src/mcp-config.mjs';

const workerPath = fileURLToPath(new URL('../src/worker.mjs', import.meta.url));
const serverPath = fileURLToPath(new URL('../fixtures/mcp-server.mjs', import.meta.url));
const token = 'fixture-private-bearer-long-enough';
const auth = { authorization: `Bearer ${token}` };
const secret = 'mcp-fixture-secret-value-0123456789';

const fixtureServer = (extra = {}) => ({ command: process.execPath, args: [serverPath], env: { MCP_TEST_SECRET: '${MCP_TEST_SECRET}' }, ...extra });

async function dataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'manolo-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function launch(t, dir, options = {}) {
  const child = spawn(process.execPath, [workerPath], {
    env: {
      MANOLO_DATA_DIR: dir, MANOLO_MODE: 'fixture', MANOLO_AGENT_ID: 'test-manolo', MANOLO_AGENT_TOKEN: token,
      PORT: '0', MCP_TEST_SECRET: secret, PATH: process.env.PATH, ...options,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  t.after(() => { child.kill('SIGKILL'); return closed; });
  return {
    logs: () => stdout + stderr,
    async start() {
      for (let attempt = 0; attempt < 400; attempt++) {
        assert.equal(child.exitCode, null, stdout + stderr);
        const port = /Manolo worker listening on (\d+)/.exec(stdout)?.[1];
        if (port) return `http://127.0.0.1:${port}`;
        await sleep(25);
      }
      assert.fail(`Worker did not listen: ${stdout}${stderr}`);
    },
  };
}

async function request(url, path, options) {
  const response = await fetch(url + path, { signal: AbortSignal.timeout(20_000), ...options });
  return { status: response.status, body: await response.json() };
}

async function until(check, label) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await check();
    if (result) return result;
    await sleep(25);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function put(url, id, sessionId, text) {
  return request(url, `/v1/turns/${id}`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, text }),
  });
}

async function toolTurn(url, id, name, args, session = 'mcp') {
  const started = await put(url, id, session, `fixture-tool:${JSON.stringify({ name, args })}`);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const body = await until(async () => {
    const poll = await request(url, `/v1/turns/${id}`, { headers: auth });
    assert.equal(poll.status, 200);
    if (poll.body.status !== 'pending') return poll.body;
  }, `terminal turn ${id}`);
  assert.equal(body.status, 'done', JSON.stringify(body));
  const tool = body.tools?.find(each => each.name === name);
  assert.ok(tool, JSON.stringify(body));
  return tool;
}

async function declaredTools(url, id) {
  const started = await put(url, id, 'setup', 'fixture:setup');
  assert.equal(started.status, 202);
  const body = await until(async () => {
    const poll = await request(url, `/v1/turns/${id}`, { headers: auth });
    if (poll.body.status !== 'pending') return poll.body;
  }, `setup turn ${id}`);
  return JSON.parse(body.text).tools;
}

test('mcp.json is validated against the shared mcpServers shape', () => {
  const env = { TOKEN: 'secret-token-value' };
  const parsed = parseMcpConfig(JSON.stringify({
    mcpServers: {
      files: { command: 'npx', args: ['-y', 'server-filesystem'], env: { TOKEN: '${TOKEN}' } },
      docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' }, timeout: 10, exposure: 'codemode' },
    },
  }), env);
  assert.deepEqual([...parsed.servers.keys()], ['files', 'docs']);
  assert.ok(parsed.secrets.has('secret-token-value'));
  assert.ok(parsed.secrets.has('Bearer secret-token-value'));
  assert.deepEqual([...parsed.referencedEnv], ['TOKEN']);
  assert.equal(parsed.servers.get('docs').kind, 'http');
  assert.equal(parsed.servers.get('docs').timeoutMs, 10_000);

  for (const bad of [
    'not json',
    '[]',
    '{}',
    '{"mcpServers":[]}',
    '{"mcpServers":{"bad name":{}}}',
    '{"mcpServers":{"a":{"command":"x","mystery":1}}}',
    '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"},"c":{"command":"z"},"d":{"command":"x"},"e":{"command":"x"},"f":{"command":"x"},"g":{"command":"x"},"h":{"command":"x"},"i":{"command":"x"}}}',
    '{"mcpServers":{"a":{"command":"x","env":{"K":"${MISSING}"}}}}',
    '{"mcpServers":{"a":{"command":"${NOPE}"}}}',
    '{"mcpServers":{"a":{"command":"x","exposure":"sometimes"}}}',
    '{"mcpServers":{"a":{"url":"https://example.com/mcp","oauth":{"callbackUrl":"http://x"}}}}',
    '{"mcpServers":{"a":{"command":"x","timeout":0}}}',
    '{"extra":true,"mcpServers":{}}',
  ]) {
    assert.throws(() => parseMcpConfig(bad, env), undefined, bad);
  }
});

test('tool exposure patterns resolve exact names before prefixes', () => {
  const server = { exposure: 'direct', toolExposure: { 'delete_*': 'hidden', search: 'deferred' } };
  assert.equal(exposureFor(server, 'search'), 'deferred');
  assert.equal(exposureFor(server, 'delete_item'), 'hidden');
  assert.equal(exposureFor(server, 'list'), 'direct');
  assert.equal(exposureFor({}, 'list'), 'direct');
});

test('MCP tools appear, run, stay redacted, and follow a live configuration change', { timeout: 90_000 }, async t => {
  const dir = await dataDir(t);
  const relay = (await import('node:http')).createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); return new Promise(resolve => relay.close(resolve)); });

  // The first start seeds the PVC file from the environment, the way Helm does on a fresh volume.
  const worker = launch(t, dir, {
    MANOLO_RELAY_URL: `http://127.0.0.1:${relay.address().port}`, MANOLO_FIXTURE_TOOLS: '1', MANOLO_FIXTURE_INSPECT_SETUP: '1',
    MANOLO_MCP_SERVERS: JSON.stringify({ mcpServers: { fixture: fixtureServer() } }),
  });
  const url = await worker.start();

  const tools = await declaredTools(url, 'setup-1');
  for (const name of ['mcp__fixture__echo', 'mcp__fixture__env', 'mcp__fixture__image', 'mcp__fixture__big']) {
    assert.ok(tools.includes(name), `${name} missing from ${JSON.stringify(tools)}`);
  }
  assert.equal(tools.includes('codemode'), false);
  assert.equal(tools.includes('tool_search'), false);

  const echoed = await toolTurn(url, 'echo', 'mcp__fixture__echo', { text: 'hello' });
  assert.equal(echoed.status, 'ok', echoed.output);
  assert.equal(echoed.output, 'echo: hello');

  // The stdio server never inherits the worker's environment, so the agent token stays out of it.
  const env = await toolTurn(url, 'env', 'mcp__fixture__env', {});
  assert.equal(env.status, 'ok', env.output);
  assert.match(env.output, /"token":"unset"/);
  assert.match(env.output, /"path":"set"/);
  // A secret the server was given through mcp.json is redacted in the transcript like the agent token.
  assert.doesNotMatch(env.output, new RegExp(secret));
  assert.match(env.output, /\[redacted\]/);

  const image = await toolTurn(url, 'image', 'mcp__fixture__image', {});
  assert.equal(image.status, 'ok', image.output);
  assert.equal(image.images?.[0]?.mimeType, 'image/png');

  // The fit hook applies to every tool result the model gets, not just `read`: a 2400x1200 MCP image is resized.
  const wide = await toolTurn(url, 'wide', 'mcp__fixture__wide', {});
  assert.equal(wide.status, 'ok', wide.output);
  const resized = Buffer.from(wide.images[0].data, 'base64');
  assert.equal(resized.subarray(1, 4).toString('ascii'), 'PNG');
  const width = resized.readUInt32BE(16);
  const height = resized.readUInt32BE(20);
  assert.ok(width <= 2000 && height <= 2000, `expected a fitted image, got ${width}x${height}`);
  assert.ok(width < 2400, `the image should have been resized, got ${width}x${height}`);

  const failed = await toolTurn(url, 'fail', 'mcp__fixture__fail', {});
  assert.equal(failed.status, 'error');
  assert.match(failed.output, /failed on purpose/);

  // Oversized text is cut for the model and saved where the agent's own read tool reaches it.
  const big = await toolTurn(url, 'big', 'mcp__fixture__big', {});
  assert.equal(big.status, 'ok');
  assert.match(big.output, /^Warning: truncated output/);
  // The transcript copy is shorter than the model-facing text, but the full result is on disk for `read`.
  const saved = await readdir(join(dir, 'workspace', 'mcp'));
  assert.equal(saved.length, 1);
  const savedText = await readFile(join(dir, 'workspace', 'mcp', saved[0]), 'utf8');
  assert.ok(savedText.startsWith('start-') && savedText.endsWith('-end'));
  assert.ok(savedText.length > 40_000);

  // A second server written into the volume while the worker runs is installed without a restart, and code mode and
  // tool search appear only when a server asks for them.
  const config = join(dir, 'mcp.json');
  await writeFile(config, JSON.stringify({
    mcpServers: {
      fixture: fixtureServer(),
      hidden: fixtureServer({ exposure: 'codemode' }),
      deferred: fixtureServer({ exposure: 'deferred' }),
    },
  }));
  const grown = await until(async () => {
    const candidate = await declaredTools(url, `setup-${Date.now()}`);
    return candidate.includes('codemode') && candidate.includes('tool_search') ? candidate : undefined;
  }, 'a reloaded configuration');
  assert.ok(grown.includes('codemode'));
  assert.ok(grown.includes('tool_search'));
  assert.equal(grown.some(name => name.startsWith('mcp__hidden__')), false);
  assert.equal(grown.some(name => name.startsWith('mcp__deferred__')), false);

  // A script reaches the code-mode server's tools even though the model never sees them declared, and the standard
  // workspace tools are scriptable too: a script can write, read and shell between other calls.
  const script = await toolTurn(url, 'codemode', 'codemode', {
    code: `
      const echoed = await tools.mcp__hidden__echo({ text: 'from a script' });
      await tools.write({ path: 'codemode-note.txt', content: 'written by a script' });
      const read = await tools.read({ path: 'codemode-note.txt' });
      const bash = await tools.bash({ command: 'printf shell-ok' });
      return JSON.stringify({ echoed, read, bash }).slice(0, 600);`,
  });
  assert.equal(script.status, 'ok', script.output.slice(0, 600));
  assert.match(script.output, /from a script/);
  assert.match(script.output, /written by a script/);
  assert.match(script.output, /shell-ok/);
  assert.equal(await readFile(join(dir, 'workspace', 'codemode-note.txt'), 'utf8'), 'written by a script');

  // tool_search loads a deferred tool for the next request, and its call is bounded like any other.
  const search = await toolTurn(url, 'search', 'tool_search', { query: 'echo' }, 'setup');
  assert.equal(search.status, 'ok', search.output.slice(0, 300));
  assert.match(search.output, /mcp__deferred__echo/);
  const loaded = await until(async () => {
    const candidate = await declaredTools(url, `setup-${Date.now()}`);
    return candidate.includes('mcp__deferred__echo') ? candidate : undefined;
  }, 'a deferred tool loaded by tool_search');

  // Removing a server withdraws its extension; the registry change lands on the next request.
  await writeFile(config, JSON.stringify({ mcpServers: { fixture: fixtureServer() } }));
  await until(async () => {
    const candidate = await declaredTools(url, `setup-${Date.now()}`);
    return !candidate.includes('codemode') && !candidate.includes('tool_search') ? candidate : undefined;
  }, 'the removed servers');

  // The owner-facing route accepts a new file, and a broken one is refused without replacing the working file.
  const written = await request(url, '/v1/mcp/config', {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ text: JSON.stringify({ mcpServers: { fixture: fixtureServer(), second: fixtureServer() } }) }),
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.servers.filter(server => server.state === 'connected').length, 2);
  const refusedHeader = await request(url, '/v1/mcp/config', {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '{}' }),
  });
  assert.equal(refusedHeader.status, 400);
  const refused = await request(url, '/v1/mcp/config', {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '{"mcpServers":{"second":{"command":"nope","bogus":1}}}' }),
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /unknown field/);
  const status = await request(url, '/v1/mcp', { headers: auth });
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.servers.map(server => server.name).sort(), ['fixture', 'second']);
});

test('code mode can be kept available without any MCP server', { timeout: 30_000 }, async t => {
  const dir = await dataDir(t);
  const relay = (await import('node:http')).createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); return new Promise(resolve => relay.close(resolve)); });
  const worker = launch(t, dir, {
    MANOLO_RELAY_URL: `http://127.0.0.1:${relay.address().port}`, MANOLO_FIXTURE_TOOLS: '1',
    MANOLO_FIXTURE_INSPECT_SETUP: '1', MANOLO_CODEMODE: '1', MANOLO_MCP_SERVERS: '',
  });
  const url = await worker.start();
  const tools = await declaredTools(url, 'setup-codemode');
  assert.ok(tools.includes('codemode'), JSON.stringify(tools));
  assert.equal(tools.includes('tool_search'), false);
  const script = await toolTurn(url, 'script', 'codemode', {
    code: 'const b = await tools.bash({ command: "printf no-mcp" }); return JSON.stringify(b).slice(0, 200);',
  });
  assert.equal(script.status, 'ok', script.output.slice(0, 300));
  assert.match(script.output, /no-mcp/);
});

test('an MCP secret cannot also be handed to the agent shell', { timeout: 30_000 }, async t => {
  const dir = await dataDir(t);
  const worker = launch(t, dir, {
    MANOLO_MCP_SERVERS: JSON.stringify({ mcpServers: { fixture: fixtureServer() } }),
    MANOLO_BASH_ENV: 'MCP_TEST_SECRET',
  });
  await assert.rejects(worker.start(), /cannot pass MCP_TEST_SECRET/);
});
