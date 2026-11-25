import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cwd = new URL('../', import.meta.url);
const workerPath = fileURLToPath(new URL('../src/worker.mjs', import.meta.url));
const token = 'oauth-agent-bearer-long-enough-for-tests';
const ownerPassword = 'oauth-owner-password-long-enough-000000';
const basic = { authorization: `Basic ${Buffer.from(`owner:${ownerPassword}`).toString('base64')}` };

const tools = [{
  name: 'echo',
  description: 'Echo text back',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: { readOnlyHint: true },
}];

// A Streamable HTTP MCP server that demands OAuth, plus the authorization server it points at: protected resource
// metadata, dynamic client registration, and a token endpoint that checks the PKCE verifier from the authorization URL.
async function startServers(t) {
  const state = { clients: new Map(), authorizationUrl: undefined, verifier: undefined, tokens: new Set(), registered: 0 };
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/oauth-protected-resource' || req.url === '/.well-known/oauth-protected-resource/mcp') {
      return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (req.url === '/.well-known/oauth-authorization-server' || req.url === '/as.json') {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp'],
      });
    }
    if (req.url === '/register') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const metadata = JSON.parse(body);
      state.registered += 1;
      state.clients.set('test-client', metadata.redirect_uris ?? []);
      return json(201, {
        client_id: 'test-client', client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: metadata.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
      });
    }
    if (req.url === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      if (form.get('grant_type') !== 'authorization_code' || form.get('code') !== 'test-code') {
        return json(400, { error: 'invalid_grant' });
      }
      const expected = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (!state.verifier || expected !== state.verifier) return json(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
      const access = `access-${randomBytes(8).toString('hex')}`;
      state.tokens.add(access);
      return json(200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: `refresh-${randomBytes(4).toString('hex')}`, scope: 'mcp' });
    }
    if (req.url === '/mcp' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    if (req.url === '/mcp') {
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!bearer || !state.tokens.has(bearer)) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="mcp"`,
        });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202, { 'mcp-session-id': 'session-1' }); return res.end(); }
      const respond = result => json(200, { jsonrpc: '2.0', id: message.id, result }, { 'mcp-session-id': 'session-1' });
      if (message.method === 'initialize') {
        return respond({ protocolVersion: message.params?.protocolVersion ?? '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1' } });
      }
      if (message.method === 'tools/list') return respond({ tools });
      if (message.method === 'tools/call') {
        return respond({ content: [{ type: 'text', text: `echo: ${String(message.params?.arguments?.text ?? '')}` }] });
      }
      return json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
    json(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, state };
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function start(t, command, args, env) {
  const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk; });
  const closed = once(child, 'close');
  t.after(() => { child.kill('SIGKILL'); return closed; });
  return { child, log: () => log, async untilLog(pattern) {
    for (let attempt = 0; attempt < 400; attempt++) {
      assert.equal(child.exitCode, null, log);
      const match = pattern.exec(log);
      if (match) return match;
      await sleep(25);
    }
    assert.fail(`Timed out waiting for ${pattern}: ${log}`);
  } };
}

async function until(check, label) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await check();
    if (result) return result;
    await sleep(50);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test('an OAuth-protected MCP server signs in through the relay callback and then serves tools', { timeout: 120_000 }, async t => {
  const as = await startServers(t);
  const relayPort = await freePort();
  const workerPort = await freePort();
  const publicUrl = `http://127.0.0.1:${relayPort}`;
  const root = await mkdtemp(join(tmpdir(), 'manolo-mcp-oauth-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const worker = start(t, process.execPath, [workerPath], {
    MANOLO_DATA_DIR: join(root, 'data'), MANOLO_MODE: 'fixture', MANOLO_AGENT_ID: 'primary', MANOLO_AGENT_TOKEN: token,
    PORT: String(workerPort), MANOLO_FIXTURE_TOOLS: '1', MANOLO_FIXTURE_INSPECT_SETUP: '1',
    MANOLO_RELAY_URL: 'http://127.0.0.1:1', MANOLO_PUBLIC_URL: publicUrl,
    MANOLO_MCP_SERVERS: JSON.stringify({ mcpServers: { remote: { url: `${as.origin}/mcp` } } }),
  });
  await worker.untilLog(/Manolo worker listening/);

  const configPath = join(root, 'relay.json');
  await writeFile(configPath, JSON.stringify({
    agents: { primary: { url: `http://127.0.0.1:${workerPort}`, tokenEnv: 'PRIMARY_TOKEN' } },
    owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' } },
    routes: [], inbox: [],
  }));
  start(t, process.execPath, ['src/relay.mjs'], {
    MANOLO_DATA_DIR: join(root, 'relay-data'), MANOLO_RELAY_CONFIG: configPath, PORT: String(relayPort),
    PRIMARY_TOKEN: token, OWNER_PASSWORD: ownerPassword,
  });
  await until(async () => {
    try { return (await fetch(`${publicUrl}/healthz`)).ok; } catch { return false; }
  }, 'the relay listener');

  const mcp = () => fetch(`${publicUrl}/api/mcp`, { headers: basic, signal: AbortSignal.timeout(10_000) }).then(response => response.json());

  // The worker discovers the 401 on its own and offers a sign-in URL; the relay adopts the state it carries.
  const pending = await until(async () => {
    const state = await mcp();
    return state.servers?.[0]?.authUrl ? state : undefined;
  }, 'the pending sign-in');
  assert.equal(pending.servers[0].name, 'remote');
  assert.equal(pending.servers[0].state, 'sign-in');
  const authorization = new URL(pending.servers[0].authUrl);
  assert.equal(authorization.searchParams.get('redirect_uri'), `${publicUrl}/mcp/oauth/callback`);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(as.state.registered, 1, 'dynamic client registration should have run once');
  as.state.verifier = authorization.searchParams.get('code_challenge');

  // The browser lands on the relay's callback route with the code; the relay forwards it to the worker, which
  // exchanges it for a token and reconnects.
  const state = authorization.searchParams.get('state');
  const callback = await fetch(`${publicUrl}/mcp/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`, { headers: basic, signal: AbortSignal.timeout(10_000) });
  assert.equal(callback.status, 200, await callback.text());

  const connected = await until(async () => {
    const current = await mcp();
    return current.servers?.[0]?.state === 'connected' ? current : undefined;
  }, 'the authorized server');
  assert.equal(connected.servers[0].tools, 1);
  assert.equal(connected.error, null);

  // The token is on the volume, and the tool it unlocked runs through the relay's normal turn API.
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'data', 'mcp-auth.json'), 'utf8'));
  assert.ok(saved[`${as.origin}/mcp`].tokens.access_token.startsWith('access-'));

  const turn = await fetch(`http://127.0.0.1:${workerPort}/v1/turns/call`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'oauth', text: `fixture-tool:${JSON.stringify({ name: 'mcp__remote__echo', args: { text: 'signed in' } })}` }),
  });
  assert.equal(turn.status, 202);
  const settled = await until(async () => {
    const body = await (await fetch(`http://127.0.0.1:${workerPort}/v1/turns/call`, { headers: { authorization: `Bearer ${token}` } })).json();
    return body.status === 'pending' ? undefined : body;
  }, 'the MCP tool call');
  assert.equal(settled.status, 'done', JSON.stringify(settled));
  assert.equal(settled.tools[0].status, 'ok');
  assert.equal(settled.tools[0].output, 'echo: signed in');

  // A callback for a state the relay never issued is refused rather than exchanged.
  // The relay's mutation routes require the workspace request header, as every other mutating route does.
  const noHeader = await fetch(`${publicUrl}/api/mcp/config`, {
    method: 'PUT', headers: { ...basic, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '{"mcpServers":{}}' }), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(noHeader.status, 403);
  const status = await (await fetch(`${publicUrl}/api/mcp`, { headers: basic })).json();
  assert.equal(status.servers[0].authState, undefined);

  // A callback for a state the relay never issued is refused rather than exchanged.
  const forged = await fetch(`${publicUrl}/mcp/oauth/callback?code=test-code&state=not-a-real-state`, { headers: basic, signal: AbortSignal.timeout(10_000) });
  assert.equal(forged.status, 400);
});
