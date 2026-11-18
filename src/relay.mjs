import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDashboard } from './dashboard.mjs';
import { edgeKey, ID, loadRelayConfig, routeKey, SNOWFLAKE } from './relay-config.mjs';
import { openRelayStore } from './relay-store.mjs';
import { createTelegramTransport } from './telegram.mjs';

const config = loadRelayConfig(process.env.MANOLO_RELAY_CONFIG);
const dataDir = process.env.MANOLO_DATA_DIR;
if (!dataDir) throw new Error('Set MANOLO_DATA_DIR');
const telegramToken = process.env.MANOLO_TELEGRAM_TOKEN;
const discordToken = process.env.MANOLO_DISCORD_TOKEN;
if (config.transports.has('telegram') && !telegramToken) throw new Error('Set MANOLO_TELEGRAM_TOKEN for Telegram routes');
if (config.transports.has('discord') && !discordToken) throw new Error('Set MANOLO_DISCORD_TOKEN for Discord routes');
const telegram = config.transports.has('telegram') && createTelegramTransport({ token: telegramToken, baseUrl: process.env.MANOLO_TELEGRAM_BASE_URL });
const botScope = telegramToken?.split(':')[0];
const discordScope = config.transports.has('discord') ? Buffer.from(discordToken.split('.')[0], 'base64url').toString('ascii') : null;
if (discordScope !== null && !SNOWFLAKE.test(discordScope)) throw new Error('Invalid MANOLO_DISCORD_TOKEN format');
let discordClient;
process.umask(0o077);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const writerLock = new DatabaseSync(join(dataDir, 'writer-lock.sqlite'), { timeout: 0 });
try { writerLock.exec('BEGIN EXCLUSIVE'); } catch { throw new Error('Relay data directory already has a writer or cannot be locked'); }
const store = openRelayStore(join(dataDir, 'relay.sqlite'));
if (telegram) store.bindBot(botScope);
const dashboard = createDashboard(store.db);
const stop = new AbortController();
const WEB = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL(`./web/${file}`, import.meta.url)) }]));

const fail = (statusCode) => Object.assign(new Error('Request rejected'), { statusCode });
const digest = (s) => createHash('sha256').update(s).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));
const isText = value => typeof value === 'string' && value.length > 0 && value.length <= 4000 && value.trim().length > 0;
const ownFields = (obj, ...fields) => fields.length === Object.keys(obj).length && fields.every(field => Object.hasOwn(obj, field));

function respond(res, status, body, additional) {
  res.writeHead(status, { 'content-type': 'application/json', ...additional });
  res.end(JSON.stringify(body));
}

function limits(res, web) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (web) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
}

async function readJson(req, maxBytes = 32 * 1024) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fail(415);
  if (Number(req.headers['content-length']) > maxBytes) throw fail(413);
  let size = 0;
  const chunks = [];
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.length;
    if (size > maxBytes) throw fail(413);
    chunks.push(part);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400);
  return value;
}

function ownerAuth(req) {
  const authorization = req.headers.authorization ?? '';
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!match) return;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 1) return;
  const name = decoded.slice(0, sep);
  const entry = config.owners.get(name);
  if (equal(decoded.slice(sep + 1), entry?.password ?? '\0') && entry) return { name, ...entry };
}

function agentAuth(req) {
  const match = /^Bearer ([\x21-\x7e]{32,256})$/i.exec(req.headers.authorization ?? '');
  if (!match) return;
  let id;
  for (const [agent, entry] of config.agents) if (equal(match[1], entry.token)) id = agent;
  return id;
}

async function worker(agent, id, input) {
  const { url, token } = config.agents.get(agent);
  let result;
  try {
    result = await fetch(`${url}/v1/turns/${id}`, {
      method: input ? 'PUT' : 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...(input && { 'content-type': 'application/json' }) },
      body: input ? JSON.stringify(input) : undefined,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(8000)]),
    });
  } catch { throw fail(503); }
  if (!result.ok) {
    await result.body?.cancel();
    throw fail(result.status >= 400 && result.status < 500 ? result.status : 503);
  }
  let turn;
  try { turn = await result.json(); } catch { throw fail(503); }
  if (!['pending', 'done', 'failed'].includes(turn?.status)) throw fail(503);
  if (turn.status === 'done' && typeof turn.text === 'string') return { status: 'done', text: turn.text.slice(0, 16000) };
  if (turn.status === 'pending') return { status: 'pending' };
  return { status: 'failed', text: 'This turn could not be completed.' };
}

async function web(req, res, path) {
  const owner = ownerAuth(req);
  if (!owner) return respond(res, 401, { error: 'Sign in as an owner' }, { 'www-authenticate': 'Basic realm="Manolo", charset="UTF-8"' });
  if (req.method === 'GET' && WEB.has(path)) {
    const { type, body } = WEB.get(path);
    res.writeHead(200, { 'content-type': type });
    return res.end(body);
  }
  if (req.method === 'GET' && path === '/api/dashboard') return respond(res, 200, dashboard.state(owner.agent));
  if (req.method === 'GET' && path === '/api/inbox') return respond(res, 200, { messages: store.messages(owner.agent) });
  if (req.method === 'GET' && path === '/api/turns') return respond(res, 200, { turns: store.webHistory(owner.name, owner.agent) });
  const turn = /^\/api\/turns\/([A-Za-z0-9_-]{1,128})$/.exec(path);
  if (req.method === 'GET' && turn) {
    const result = store.webTurn(owner.name, owner.agent, turn[1]);
    if (!result) throw fail(404);
    return respond(res, 200, result);
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    if (req.headers['x-manolo-request'] !== '1') throw fail(403);
    if (req.method === 'PUT' && path === '/api/dashboard/draft') return respond(res, 200, dashboard.draft(owner.agent, await readJson(req, 256 * 1024)));
    if (req.method === 'POST' && ['/api/dashboard/publish', '/api/dashboard/rollback'].includes(path)) {
      const body = await readJson(req);
      if (!ownFields(body, 'revision') || !Number.isSafeInteger(body.revision) || body.revision < 1) throw fail(400);
      const operation = path.split('/').at(-1);
      return respond(res, 200, dashboard[operation](owner.agent, body.revision));
    }
    if (req.method === 'POST' && path === '/api/turns') {
      const body = await readJson(req);
      if (!ownFields(body, 'id', 'text') || typeof body.id !== 'string' || !ID.test(body.id) || !isText(body.text)) throw fail(400);
      return respond(res, 200, store.webSubmit(owner.name, owner.agent, body.id, body.text));
    }
  }
  throw fail(404);
}

async function internal(req, res, path) {
  const agent = agentAuth(req);
  if (!agent) throw fail(401);
  if (req.method === 'PUT' && path === '/v1/dashboard/draft') {
    const { draft } = dashboard.draft(agent, await readJson(req, 256 * 1024));
    return respond(res, 200, { revision: draft.revision });
  }
  if (req.method === 'POST' && path === '/v1/inbox') {
    const body = await readJson(req);
    if (!ownFields(body, 'to', 'text') || typeof body.to !== 'string' || !ID.test(body.to) || !isText(body.text)) throw fail(400);
    if (!config.inbox.has(edgeKey(agent, body.to))) throw fail(403);
    const idem = req.headers['idempotency-key'] ?? randomUUID();
    if (!ID.test(idem)) throw fail(400);
    return respond(res, 200, store.inbox(agent, body.to, body.text, idem));
  }
  throw fail(404);
}

function serve(handler, port, host) {
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    limits(res, handler === web);
    try {
      const url = new URL(req.url, 'http://local.invalid');
      if (url.pathname === '/healthz' && req.method === 'GET') return respond(res, 200, { ok: true });
      await handler(req, res, url.pathname);
    } catch (error) {
      if (res.headersSent || res.destroyed) return res.destroy();
      const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
      if (status === 500) console.error('Relay request failed unexpectedly');
      respond(res, status, { error: status >= 500 ? 'Service unavailable' : 'Request rejected' }, !req.readableEnded ? { connection: 'close' } : undefined);
    }
  });
  server.listen(port, host, () => console.log(`${handler.name} listening on ${server.address().address}:${server.address().port}`));
  return server;
}

async function pollTelegram() {
  let wait = 1000;
  while (!stop.signal.aborted) {
    try {
      const updates = await telegram.poll(store.cursor(), stop.signal);
      store.ingest(updates, config.routes, botScope);
      wait = 1000;
      if (updates.length === 0) await sleep(250, undefined, { signal: stop.signal });
    } catch {
      if (stop.signal.aborted) break;
      console.error('Telegram polling failed; retrying');
      await sleep(wait, undefined, { signal: stop.signal });
      wait = Math.min(wait * 2, 60_000);
    }
  }
}

const isFinal = err => err.permanent || (err.statusCode >= 400 && err.statusCode < 500 && ![408, 429].includes(err.statusCode));
const retryAt = attempts => Date.now() + Math.min(2 ** Math.min(attempts, 9) * 1000, 300_000);

async function runMessage(transport, adapter, job) {
  const { agent, user_id: userId, chat_id: chatId, turn_id: id, session_id: sessionId } = job;
  const advance = (...args) => store.advance(transport, job, ...args);
  if (config.routes.get(routeKey({ transport, userId, chatId })) !== agent) return advance('dead');
  try {
    if (job.state === 'send') {
      await adapter.send({ chatId, userId, eventId: job.event_id, text: job.output }, stop.signal);
      return advance('sent');
    }
    const turn = await worker(agent, id, job.state === 'submit' ? { sessionId, text: job.input } : undefined);
    if (turn.status === 'pending') return advance('wait', null, Date.now() + 1000);
    return advance('send', turn.text || 'The agent returned no text.');
  } catch (err) {
    if (stop.signal.aborted) return;
    if (isFinal(err)) {
      if (job.state !== 'send') return advance('send', 'This turn could not be completed.');
      console.error(`${transport} rejected a delivery`);
      return advance('dead');
    }
    advance(job.state, job.output, retryAt(job.attempts + 1), job.attempts + 1);
  }
}

async function runWebTurn(job) {
  const advance = (...args) => store.webAdvance(job, ...args);
  if (config.owners.get(job.owner)?.agent !== job.agent) return advance('failed');
  try {
    const turn = await worker(job.agent, job.turn_id, job.state === 'submit' ? { sessionId: job.session_id, text: job.input } : undefined);
    if (turn.status === 'pending') return advance('wait', null, Date.now() + 500);
    advance(turn.status, turn.status === 'done' ? turn.text : null);
  } catch (err) {
    if (stop.signal.aborted) return;
    if (isFinal(err)) return advance('failed');
    advance(job.state, null, retryAt(job.attempts + 1), job.attempts + 1);
  }
}

async function drain(read, run) {
  while (!stop.signal.aborted) {
    await Promise.all(read(Date.now()).map(run));
    await sleep(350, undefined, { signal: stop.signal });
  }
}

async function runDiscord() {
  const { createDiscordTransport } = await import('./discord.mjs');
  while (!stop.signal.aborted) {
    const adapter = createDiscordTransport({ token: discordToken });
    try {
      await adapter.start(envelope => {
        if (stop.signal.aborted) return;
        try { store.ingestDiscord(envelope, config.routes, discordScope); }
        catch { console.error('Discord message could not be persisted'); process.exit(1); }
      }, stop.signal);
      if (stop.signal.aborted) break;
      discordClient = adapter;
      await adapter.closed;
    } catch {
      if (!stop.signal.aborted) console.error('Discord connection failed; retrying');
    } finally {
      discordClient = undefined;
      await adapter.stop();
    }
    if (!stop.signal.aborted) await sleep(30_000, undefined, { signal: stop.signal });
  }
}

const listeners = [
  serve(web, Number(process.env.PORT ?? 8080), process.env.HOST ?? '127.0.0.1'),
  serve(internal, Number(process.env.MANOLO_INTERNAL_PORT ?? 8082), process.env.MANOLO_INTERNAL_HOST ?? '127.0.0.1'),
];
const loops = [drain(store.webReady, runWebTurn)];
if (telegram) loops.push(pollTelegram(), drain(store.due, job => runMessage('telegram', telegram, job)));
if (discordScope) loops.push(runDiscord(), drain(now => discordClient ? store.discordReady(now, discordScope) : [], job => runMessage('discord', discordClient, job)));
for (const loop of loops) loop.catch(() => { if (!stop.signal.aborted) { console.error('Relay loop stopped unexpectedly'); process.exit(1); } });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  if (stop.signal.aborted) return;
  stop.abort();
  const forced = setTimeout(() => process.exit(1), 10000).unref();
  await Promise.allSettled([...loops, ...listeners.map(server => new Promise(resolve => server.close(resolve)))]);
  store.db.close();
  writerLock.close();
  clearTimeout(forced);
});
