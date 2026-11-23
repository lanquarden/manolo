import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDashboard } from './dashboard.mjs';
import { createDeviceHandler } from './device-api.mjs';
import { edgeKey, ID, loadRelayConfig, routeKey, SNOWFLAKE } from './relay-config.mjs';
import { openRelayStore } from './relay-store.mjs';
import { createRuntimeRelay } from './runtime-relay.mjs';
import { createSpeechFromEnv } from './speech.mjs';
import { createTelegramTransport } from './telegram.mjs';
import { createTelegramXmppTransport } from './telegram-xmpp.mjs';

const webHost = process.env.HOST ?? '127.0.0.1';
const internalHost = process.env.MANOLO_INTERNAL_HOST ?? '127.0.0.1';
const deviceHost = process.env.MANOLO_DEVICE_HOST ?? '127.0.0.1';
const runtimeAgent = process.env.MANOLO_RUNTIME_AGENT;
const runtimeHost = process.env.MANOLO_RUNTIME_HOST ?? '127.0.0.1';
const demo = process.env.MANOLO_DEMO === '1';
const demoNetwork = process.env.MANOLO_DEMO_ALLOW_NETWORK === '1';
const isLoopback = host => host === '127.0.0.1' || host === '::1' || host === 'localhost';
const loopbackOnly = [webHost, internalHost, deviceHost].every(isLoopback);
if (demo && !loopbackOnly && !demoNetwork) throw new Error('MANOLO_DEMO requires loopback listeners or MANOLO_DEMO_ALLOW_NETWORK=1');
if (demo && !loopbackOnly) console.warn('WARNING: weak demo passwords on a non-loopback listener; use only for an isolated smoke test');
const config = loadRelayConfig(process.env.MANOLO_RELAY_CONFIG, process.env, { demo });
if (runtimeAgent && (demo || !config.agents.has(runtimeAgent) || ![...config.owners.values()].some(owner => owner.agent === runtimeAgent) ||
    [...config.routes.values()].includes(runtimeAgent))) {
  throw new Error('A runtime agent requires non-demo authentication and must be web-only');
}
const dataDir = process.env.MANOLO_DATA_DIR;
if (!dataDir) throw new Error('Set MANOLO_DATA_DIR');
const telegramToken = process.env.MANOLO_TELEGRAM_TOKEN;
const useXmpp = process.env.MANOLO_TELEGRAM_MODE === 'xmpp';
const discordToken = process.env.MANOLO_DISCORD_TOKEN;
const stop = new AbortController();
if (config.transports.has('telegram') && !useXmpp && !telegramToken) throw new Error('Set MANOLO_TELEGRAM_TOKEN for direct Telegram routes');
if (config.transports.has('telegram') && useXmpp && telegramToken) throw new Error('Remove MANOLO_TELEGRAM_TOKEN from the relay when using the XMPP bridge');
if (config.transports.has('discord') && !discordToken) throw new Error('Set MANOLO_DISCORD_TOKEN for Discord routes');
const botScope = useXmpp ? process.env.MANOLO_TELEGRAM_BOT_ID : telegramToken?.split(':')[0];
const telegram = config.transports.has('telegram') && (useXmpp
  ? createTelegramXmppTransport(process.env, stop.signal)
  : createTelegramTransport({ token: telegramToken, baseUrl: process.env.MANOLO_TELEGRAM_BASE_URL, speech: createSpeechFromEnv(process.env) }));
const discordScope = config.transports.has('discord') ? Buffer.from(discordToken.split('.')[0], 'base64url').toString('ascii') : null;
if (discordScope !== null && !SNOWFLAKE.test(discordScope)) throw new Error('Invalid MANOLO_DISCORD_TOKEN format');
let discordClient;
process.umask(0o077);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const writerLock = new DatabaseSync(join(dataDir, 'writer-lock.sqlite'), { timeout: 0 });
try { writerLock.exec('BEGIN EXCLUSIVE'); } catch { throw new Error('Relay data directory already has a writer or cannot be locked'); }
const store = openRelayStore(join(dataDir, 'relay.sqlite'));
// Live progress is presentation only: kept in memory, replaced on every worker poll and dropped as soon as a turn ends.
const liveTurns = new Map();
const setLive = (id, live) => {
  if (!liveTurns.has(id) && liveTurns.size >= 100) liveTurns.delete(liveTurns.keys().next().value);
  liveTurns.set(id, live);
};
if (telegram) store.bindBot(botScope);
const dashboard = createDashboard(store.db);
const devicePath = process.env.MANOLO_DEVICE_CONFIG;
const deviceConfig = devicePath ? JSON.parse(readFileSync(devicePath, 'utf8')) : null;
const deviceOwner = subject => `device:${subject}`;
const device = devicePath ? createDeviceHandler({
  ...deviceConfig,
  submit: (subject, agent, id, text) => store.webSubmit(deviceOwner(subject), agent, id, text),
  get: (subject, agent, id) => store.webTurn(deviceOwner(subject), agent, id),
}) : null;
if (device && Object.values(deviceConfig.grants).some(grant => Object.keys(grant).some(agent => !config.agents.has(agent)))) {
  throw new Error('Device grant references an unknown agent');
}
if (runtimeAgent && Object.values(deviceConfig?.grants ?? {}).some(grant => grant[runtimeAgent]?.includes('submit'))) {
  throw new Error('A runtime agent cannot accept Device API submissions');
}
const runtimes = runtimeAgent ? createRuntimeRelay(store.db, runtimeAgent, { readJson, respond, signal: stop.signal }) : null;
const runtimeOwner = name => config.owners.get(name)?.agent === runtimeAgent;
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
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
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

const TOOL_STATUS = new Set(['ok', 'error', 'pending']);
const TOOL_SEVERITY = new Set(['info', 'warn', 'error']);
const TOOL_IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const MAX_TURN_TOOLS = 24;
const MAX_TOOL_IMAGE = 4_500_000;
const MAX_TURN_IMAGE = 8_000_000;
const clipText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;

// The worker is the only source of tool transcripts, but the relay still bounds and reshapes what it stores and serves.
function relayTools(value) {
  if (!Array.isArray(value)) return [];
  let imageBudget = MAX_TURN_IMAGE;
  const tools = value.slice(0, MAX_TURN_TOOLS).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const name = clipText(item.name, 64);
    if (!name) return [];
    const tool = { name, status: TOOL_STATUS.has(item.status) ? item.status : 'pending' };
    const args = clipText(item.args, 2000);
    if (args !== undefined) tool.args = args;
    const output = clipText(item.output, 8000);
    if (output !== undefined) tool.output = output;
    const diff = clipText(item.diff, 8000);
    if (diff !== undefined) tool.diff = diff;
    if (Number.isFinite(item.durationMs)) tool.durationMs = Math.round(item.durationMs);
    if (Array.isArray(item.diagnostics)) {
      const diagnostics = item.diagnostics.slice(0, 20).flatMap(each => {
        if (!each || typeof each !== 'object') return [];
        const message = clipText(each.message, 500);
        if (!message) return [];
        return [{ severity: TOOL_SEVERITY.has(each.severity) ? each.severity : 'info', code: clipText(each.code, 64) ?? '', message }];
      });
      if (diagnostics.length) tool.diagnostics = diagnostics;
    }
    if (Array.isArray(item.images)) {
      const images = item.images.slice(0, 2).flatMap(image => {
        if (!image || typeof image !== 'object' || !TOOL_IMAGE_TYPE.test(image.mimeType ?? '')) return [];
        if (typeof image.data !== 'string' || image.data.length > MAX_TOOL_IMAGE || image.data.length > imageBudget) return [];
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return [];
        imageBudget -= image.data.length;
        return [{ mimeType: image.mimeType, data: image.data }];
      });
      if (images.length) tool.images = images;
    }
    return [tool];
  });
  return tools;
}

const LIVE_STATUS = new Set(['pending', 'running', 'done']);

// What the browser may show while a turn runs: bounded streamed text, reasoning and running tool output.
function relayLive(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const live = {};
  const text = clipText(value.text, 16_000);
  if (text) live.text = text;
  const thinking = clipText(value.thinking, 16_000);
  if (thinking) live.thinking = thinking;
  const retry = clipText(value.retry, 500);
  if (retry) live.retry = retry;
  if (Number.isSafeInteger(value.turns) && value.turns >= 0) live.turns = value.turns;
  if (Number.isSafeInteger(value.attempt) && value.attempt >= 0) live.attempt = value.attempt;
  if (Array.isArray(value.tools)) {
    const tools = value.tools.slice(0, MAX_TURN_TOOLS).flatMap(slot => {
      if (!slot || typeof slot !== 'object' || typeof slot.name !== 'string') return [];
      const tool = { name: clipText(slot.name, 64), status: LIVE_STATUS.has(slot.status) ? slot.status : 'pending' };
      const output = clipText(slot.output, 4000);
      if (output) tool.output = output;
      if (Number.isSafeInteger(slot.droppedLines) && slot.droppedLines > 0) tool.droppedLines = slot.droppedLines;
      if (Number.isSafeInteger(slot.droppedBytes) && slot.droppedBytes > 0) tool.droppedBytes = slot.droppedBytes;
      if (Array.isArray(slot.diagnostics)) {
        const diagnostics = slot.diagnostics.slice(0, 20).flatMap(each => {
          if (!each || typeof each !== 'object') return [];
          const message = clipText(each.message, 500);
          if (!message) return [];
          return [{ severity: TOOL_SEVERITY.has(each.severity) ? each.severity : 'info', code: clipText(each.code, 64) ?? '', message }];
        });
        if (diagnostics.length) tool.diagnostics = diagnostics;
      }
      return [tool];
    });
    if (tools.length) live.tools = tools;
  }
  return Object.keys(live).length > 0 ? live : undefined;
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
  if (turn.status === 'done' && typeof turn.text === 'string') {
    const tools = relayTools(turn.tools);
    return { status: 'done', text: turn.text.slice(0, 16000), ...(tools.length > 0 && { tools }) };
  }
  if (turn.status === 'pending') {
    const live = relayLive(turn.live);
    return live === undefined ? { status: 'pending' } : { status: 'pending', live };
  }
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
  if (runtimes && owner.agent === runtimeAgent && /^\/api\/runtimes(?:\/|$)/.test(path)) {
    if (req.method !== 'GET' && req.headers['x-manolo-request'] !== '1') throw fail(403);
    return runtimes.owner(req, res, path);
  }
  if (req.method === 'GET' && path === '/api/dashboard') return respond(res, 200, dashboard.state(owner.agent));
  if (req.method === 'GET' && path === '/api/inbox') return respond(res, 200, { messages: store.messages(owner.agent) });
  if (req.method === 'GET' && path === '/api/turns') {
    const turns = store.webHistory(owner.name, owner.agent).map(turn =>
      turn.status === 'pending' && liveTurns.has(turn.id) ? { ...turn, live: liveTurns.get(turn.id) } : turn);
    return respond(res, 200, { turns });
  }
  const image = /^\/api\/turn-image\/([A-Za-z0-9_-]{1,128})\/(\d{1,3})$/.exec(path);
  if (req.method === 'GET' && image) {
    const blob = store.webImage(owner.name, owner.agent, image[1], Number(image[2]));
    if (!blob) throw fail(404);
    res.writeHead(200, {
      'content-type': blob.mimeType, 'content-length': blob.data.length, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(blob.data);
  }
  const turn = /^\/api\/turns\/([A-Za-z0-9_-]{1,128})$/.exec(path);
  if (req.method === 'GET' && turn) {
    const result = store.webTurn(owner.name, owner.agent, turn[1]);
    if (!result) throw fail(404);
    if (result.status === 'pending' && liveTurns.has(turn[1])) result.live = liveTurns.get(turn[1]);
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
  if (runtimes && req.method === 'POST' && path === '/v1/runtime/execute') {
    return runtimes.execute(req, res, agent, runtimeOwner);
  }
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
      if (handler !== device && url.pathname === '/healthz' && req.method === 'GET') return respond(res, 200, { ok: true });
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
    if (job.voice_file_id) {
      const text = await adapter.transcribeVoice(job.voice_file_id, stop.signal);
      return store.transcribed(job, text);
    }
    if (job.state === 'send') {
      const delivery = { chatId, userId, eventId: job.event_id, text: job.output,
        ...(job.reply_message_id != null && { messageId: job.reply_message_id }),
      };
      if (job.voice_reply) await adapter.sendVoice(delivery, stop.signal);
      else await adapter.send(delivery, stop.signal);
      return advance('sent');
    }
    const turn = await worker(agent, id, job.state === 'submit' ? { sessionId, text: job.input } : undefined);
    if (turn.status === 'pending') return advance('wait', null, Date.now() + 1000);
    return advance('send', turn.text || 'The agent returned no text.');
  } catch (err) {
    if (stop.signal.aborted) return;
    if (isFinal(err)) {
      if (job.voice_file_id) return store.voiceFallback(job, 'I could not transcribe this voice note. Please try sending text.');
      if (job.state === 'send' && job.voice_reply) return store.voiceFallback(job, job.output);
      if (job.state !== 'send') return advance('send', 'This turn could not be completed.');
      console.error(`${transport} rejected a delivery`);
      return advance('dead');
    }
    advance(job.state, job.output, retryAt(job.attempts + 1), job.attempts + 1);
  }
}

async function runWebTurn(job) {
  const advance = (...args) => store.webAdvance(job, ...args);
  const allowed = job.owner.startsWith('device:')
    ? Object.hasOwn(deviceConfig?.grants ?? {}, job.owner.slice(7)) &&
      deviceConfig.grants[job.owner.slice(7)][job.agent]?.includes('submit')
    : config.owners.get(job.owner)?.agent === job.agent;
  if (!allowed) {
    liveTurns.delete(job.id);
    return advance('failed');
  }
  try {
    const turn = await worker(job.agent, job.turn_id, job.state === 'submit' ? {
      sessionId: job.session_id, text: job.input,
      ...(runtimes && job.agent === runtimeAgent && runtimeOwner(job.owner) && { runtimes: runtimes.targets() }),
    } : undefined);
    if (turn.status === 'pending') {
      if (turn.live) setLive(job.id, turn.live);
      else liveTurns.delete(job.id);
      return advance('wait', { next: Date.now() + 500 });
    }
    liveTurns.delete(job.id);
    advance(turn.status, { output: turn.status === 'done' ? turn.text : null, tools: turn.tools ?? null });
  } catch (err) {
    if (stop.signal.aborted) return;
    if (isFinal(err)) {
      liveTurns.delete(job.id);
      return advance('failed');
    }
    advance(job.state, { next: retryAt(job.attempts + 1), attempts: job.attempts + 1 });
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
  serve(web, Number(process.env.PORT ?? 8080), webHost),
  serve(internal, Number(process.env.MANOLO_INTERNAL_PORT ?? 8082), internalHost),
];
if (device) listeners.push(serve(device, Number(process.env.MANOLO_DEVICE_PORT ?? 8083), deviceHost));
if (runtimes) listeners.push(serve(runtimes.device, Number(process.env.MANOLO_RUNTIME_PORT ?? 8084), runtimeHost));
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
