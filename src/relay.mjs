import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDashboard } from './dashboard.mjs';
import { DESKTOP_PATH, isDesktopPath, proxyDesktop, readBrowserUrls, upgradeDesktop } from './browser-proxy.mjs';
import { createDeviceHandler } from './device-api.mjs';
import { edgeKey, ID, key, loadRelayConfig, routeKey, SNOWFLAKE } from './relay-config.mjs';
import { openRelayStore } from './relay-store.mjs';
import { createRuntimeRelay } from './runtime-relay.mjs';
import { createSpeechFromEnv, readBounded } from './speech.mjs';
import { createTelegramTransport } from './telegram.mjs';
import { admittedRoom, roomBotUsername } from './telegram-room.mjs';
import { createTelegramXmppTransport } from './telegram-xmpp.mjs';
import { createTypingActivity } from './typing-activity.mjs';
import { createWebSessions } from './web-session.mjs';
import { BLUEPRINT_ID, TASK_CATALOG_LIMIT, TASK_PROFILE_LIMIT, verifyBlueprintSnapshot, verifyProfileSnapshot } from './work-blueprints.mjs';

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
const browserUrls = readBrowserUrls(process.env.MANOLO_BROWSER_URLS);
for (const agent of browserUrls.keys()) {
  if (!config.agents.has(agent)) throw new Error(`MANOLO_BROWSER_URLS references an unknown agent: ${agent}`);
}
// One or more agents may host web work sessions, in a comma-separated list.
const workSessionAgents = new Set((process.env.MANOLO_WORK_SESSION_AGENT ?? '')
  .split(',').map(name => name.trim()).filter(Boolean));
if (workSessionAgents.size && demo && !loopbackOnly) throw new Error('Work sessions cannot use network-exposed demo credentials');
for (const name of workSessionAgents) {
  if (!config.agents.has(name) || ![...config.owners.values()].some(owner => owner.agent === name)) {
    throw new Error('Work sessions require a configured agent with a browser owner');
  }
  if (name === runtimeAgent) throw new Error('A runtime agent cannot host work sessions');
}
const workSessionsEnabled = agentName => workSessionAgents.has(agentName);
// Required by default. `legacy` exists only for a mixed-version rollout: an old worker that never calls finish can
// still settle new Tasks while the worker is upgraded. New workers keep their own corrective/finish behavior either way.
const taskFinishMode = process.env.MANOLO_TASK_FINISH ?? 'required';
if (taskFinishMode !== 'required' && taskFinishMode !== 'legacy') throw new Error('MANOLO_TASK_FINISH must be required or legacy');
const taskFinishRequired = taskFinishMode === 'required';
const rooms = [...config.rooms.values()];
const telegramMode = process.env.MANOLO_TELEGRAM_MODE;
const useXmpp = telegramMode === 'xmpp';
if (rooms.length && telegramMode !== undefined && telegramMode !== 'direct') {
  throw new Error('Telegram rooms require direct Bot API mode; XMPP is not supported');
}
const botUsername = rooms.length
  ? roomBotUsername(process.env.MANOLO_TELEGRAM_BOT_USERNAME, rooms.some(room => room.wake === 'mentions'))
  : undefined;
if (runtimeAgent && (demo || !config.agents.has(runtimeAgent) || ![...config.owners.values()].some(owner => owner.agent === runtimeAgent) ||
    [...config.routes.values()].includes(runtimeAgent) || rooms.some(room => room.agent === runtimeAgent))) {
  throw new Error('A runtime agent requires non-demo authentication and must be web-only');
}
const dataDir = process.env.MANOLO_DATA_DIR;
if (!dataDir) throw new Error('Set MANOLO_DATA_DIR');
const telegramToken = process.env.MANOLO_TELEGRAM_TOKEN;
const discordToken = process.env.MANOLO_DISCORD_TOKEN;
const stop = new AbortController();
if (config.transports.has('telegram') && !useXmpp && !telegramToken) throw new Error('Set MANOLO_TELEGRAM_TOKEN for direct Telegram');
if (config.transports.has('telegram') && useXmpp && telegramToken) throw new Error('Remove MANOLO_TELEGRAM_TOKEN from the relay when using the XMPP bridge');
if (config.transports.has('discord') && !discordToken) throw new Error('Set MANOLO_DISCORD_TOKEN for Discord routes');
const botScope = useXmpp ? process.env.MANOLO_TELEGRAM_BOT_ID : telegramToken?.split(':')[0];
const telegram = config.transports.has('telegram') && (useXmpp
  ? createTelegramXmppTransport(process.env, stop.signal)
  : createTelegramTransport({ token: telegramToken, baseUrl: process.env.MANOLO_TELEGRAM_BASE_URL, speech: createSpeechFromEnv(process.env),
    roomsEnabled: rooms.length > 0, botUsername }));
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
const webLiveId = (owner, id) => key('web', owner.name, owner.agent, id);
// MCP OAuth: the authorization server redirects the owner's browser to <publicUrl>/mcp/oauth/callback, and the state
// names the owner's worker. Entries expire, so an abandoned sign-in cannot be replayed against a later one.
const mcpSignIns = new Map();
const rememberSignIn = (state, agent) => {
  if (mcpSignIns.size >= 32) mcpSignIns.delete(mcpSignIns.keys().next().value);
  mcpSignIns.set(state, { agent, at: Date.now() });
};
const takeSignIn = state => {
  const entry = mcpSignIns.get(state);
  if (!entry) return undefined;
  mcpSignIns.delete(state);
  return Date.now() - entry.at > 15 * 60_000 ? undefined : entry;
};
const setLive = (id, live) => {
  if (!liveTurns.has(id) && liveTurns.size >= 100) liveTurns.delete(liveTurns.keys().next().value);
  liveTurns.set(id, live);
};
const telegramTyping = telegram && typeof telegram.typing === 'function'
  ? createTypingActivity(telegram.typing.bind(telegram), stop.signal) : null;
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
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/markdown.mjs', ['markdown.mjs', 'text/javascript; charset=utf-8']],
].map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL(`./web/${file}`, import.meta.url)) }]));
// Markdown and Mermaid rendering run in the browser with the same pinned packages the worker uses. Serving them from the
// image keeps the page's CSP at `script-src 'self'`: no CDN, no inline script.
const VENDOR = new Map([
  ['/vendor/markdown-it.min.js', ['../node_modules/markdown-it/dist/markdown-it.min.js', 'text/javascript; charset=utf-8']],
  ['/vendor/pele.js', ['../node_modules/pele/dist/pele.js', 'text/javascript; charset=utf-8']],
].map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL(file, import.meta.url)) }]));

// Browser sign-in. The relay keeps sessions in memory; a restart signs everyone out.
const loginPage = readFileSync(new URL('./web/login.html', import.meta.url), 'utf8');
const LOGIN_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const sessions = createWebSessions();
const COOKIE = 'manolo_session';
const cookieSecure = process.env.MANOLO_COOKIE_SECURE !== '0';
const proxyHeader = process.env.MANOLO_PROXY_AUTH_HEADER;
if (proxyHeader !== undefined && !/^[a-z0-9-]{1,64}$/.test(proxyHeader)) throw new Error('MANOLO_PROXY_AUTH_HEADER must be a lowercase header name');
if (proxyHeader) {
  console.warn('WARNING: MANOLO_PROXY_AUTH_HEADER trusts an upstream identity header; enable it only behind an authenticating gateway');
}
const loginFailures = new Map();
const MAX_LOGIN_FAILURES = 10;
const LOGIN_FAILURE_WINDOW = 10 * 60_000;
function loginBlocked(address) {
  const entry = loginFailures.get(address);
  if (!entry) return false;
  if (entry.reset <= Date.now()) {
    loginFailures.delete(address);
    return false;
  }
  return entry.count >= MAX_LOGIN_FAILURES;
}
function recordLoginFailure(address) {
  const now = Date.now();
  if (loginFailures.size > 1000) for (const [key, value] of loginFailures) if (value.reset <= now) loginFailures.delete(key);
  const entry = loginFailures.get(address);
  if (!entry || entry.reset <= Date.now()) {
    loginFailures.set(address, { count: 1, reset: Date.now() + LOGIN_FAILURE_WINDOW });
    return;
  }
  entry.count += 1;
}

const fail = (statusCode) => Object.assign(new Error('Request rejected'), { statusCode });
const digest = (s) => createHash('sha256').update(s).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));
const isText = value => typeof value === 'string' && value.length > 0 && value.length <= 4000 && value.trim().length > 0;
// Reserve room for the IDs and the owner's answer in the worker's 4000-unit input.
const isInboxPrompt = value => isText(value) && value.length <= 2000 && JSON.stringify(value).length <= 2500;
const ownFields = (obj, ...fields) => obj !== null && typeof obj === 'object' && !Array.isArray(obj) &&
  fields.length === Object.keys(obj).length && fields.every(field => Object.hasOwn(obj, field));
const TASK_ID = /^[0-9a-f]{32}$/;
const MAX_TASK_TITLE = 120;
const MAX_TASK_INPUT = 4000;
const MAX_TASK_NOTE = 500;
const MAX_TASK_PROMPT = 2000;
const isTaskTitle = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TASK_TITLE;
const isTaskInput = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TASK_INPUT;
const isTaskNote = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TASK_NOTE;
const isTaskPrompt = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TASK_PROMPT;

// A Task operation is scoped by the originating browser turn, never by an owner or scope the caller names.
function taskTurnScope(turnId, agent) {
  if (typeof turnId !== 'string' || !ID.test(turnId)) throw fail(400);
  const turn = store.webTurnRow(turnId);
  if (!turn || turn.agent !== agent || turn.owner.startsWith('device:')) throw fail(404);
  if (config.owners.get(turn.owner)?.agent !== agent) throw fail(404);
  return { turn, scope: store.webSession(turn.owner, agent) };
}

// A new-style Task carries a pinned snapshot/profile, review binding, or the finish protocol. The relay asks the worker
// for its protocol before sending those fields. A worker with no route is old and is never fed a newer assignment that
// it might silently run with substituted defaults.
const workerProtocols = new Map();
async function workerTaskProtocol(agent) {
  const cached = workerProtocols.get(agent);
  // A negative result is short-lived so a worker upgrade is noticed without a relay restart.
  if (cached && Date.now() - cached.at < (cached.version === 2 ? 30_000 : 2_000)) return cached.version;
  let version = 0;
  try {
    const { url, token } = config.agents.get(agent);
    const response = await fetch(`${url}/v1/task-protocol`, {
      redirect: 'error', signal: AbortSignal.any([stop.signal, AbortSignal.timeout(3000)]),
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      const body = JSON.parse((await readBounded(response, 8192, AbortSignal.timeout(3000))).toString('utf8'));
      if (body?.version === 2) version = 2;
    } else {
      await response.body?.cancel().catch(() => {});
    }
  } catch {
    version = 0;
  }
  workerProtocols.set(agent, { version, at: Date.now() });
  return version;
}

async function workerTaskRequest(agent, path, { method = 'GET', body, timeout = 15_000 } = {}) {
  const { url, token } = config.agents.get(agent);
  const response = await fetch(`${url}${path}`, {
    method, redirect: 'error', signal: AbortSignal.any([stop.signal, AbortSignal.timeout(timeout)]),
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try {
    payload = JSON.parse((await readBounded(response, 512 * 1024, AbortSignal.timeout(timeout))).toString('utf8'));
  } catch {
    payload = undefined;
  }
  return { ok: response.ok, status: response.status, body: payload };
}


function respond(res, status, body, additional) {
  res.writeHead(status, { 'content-type': 'application/json', ...additional });
  res.end(JSON.stringify(body));
}

function limits(res, web) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (web) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
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

function sessionToken(req) {
  const cookies = req.headersDistinct.cookie;
  if (cookies?.length !== 1) return;
  const values = cookies[0].split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${COOKIE}=`)).map(part => part.slice(COOKIE.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

// A gateway can assert the identity once it has authenticated the browser. Only a configured header
// is trusted, only for a known owner, and only when exactly one copy arrives.
function proxyOwner(req) {
  if (!proxyHeader) return;
  const values = req.headersDistinct[proxyHeader];
  if (values?.length !== 1 || !/^[A-Za-z0-9_.@-]{1,128}$/.test(values[0])) return;
  const entry = config.owners.get(values[0]);
  if (!entry) return;
  return { name: values[0], ...entry, via: 'proxy' };
}

function cookieOwner(req) {
  const token = sessionToken(req);
  if (token === undefined) return;
  const name = sessions.resolve(token);
  const entry = name === undefined ? undefined : config.owners.get(name);
  if (!entry) return;
  return { name, ...entry, via: 'cookie', token };
}

function ownerAuth(req) {
  const proxied = proxyOwner(req);
  if (proxied) return proxied;
  const cookie = cookieOwner(req);
  if (cookie) return cookie;
  const authorization = req.headers.authorization ?? '';
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!match) return;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 1) return;
  const name = decoded.slice(0, sep);
  const entry = config.owners.get(name);
  if (equal(decoded.slice(sep + 1), entry?.password ?? '\0') && entry) return { name, ...entry, via: 'basic' };
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

async function workerWorkSessions(owner, id) {
  if (!workSessionsEnabled(owner.agent)) throw fail(404);
  const { url, token } = config.agents.get(owner.agent);
  // Never accept a worker scope or an internal turn ID from the browser.
  const scope = store.webSession(owner.name, owner.agent);
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]);
  let payload;
  try {
    const result = await fetch(`${url}/v1/work-sessions/${scope}${id ? `/${id}` : ''}`, {
      redirect: 'error', headers: { authorization: `Bearer ${token}` }, signal,
    });
    if (result.status === 404) {
      void result.body?.cancel().catch(() => {});
      throw fail(404);
    }
    if (!result.ok) {
      void result.body?.cancel().catch(() => {});
      throw fail(503);
    }
    payload = JSON.parse((await readBounded(result, 1_048_576, signal)).toString('utf8'));
  } catch (error) {
    throw fail(error.statusCode === 404 ? 404 : 503);
  }
  const summary = row => {
    if (!row || typeof row.id !== 'string' || !ID.test(row.id) || typeof row.parentTurnId !== 'string' ||
        !['queued', 'running', 'waiting', 'done', 'failed'].includes(row.status) || row.target !== 'pod') return null;
    const parentTurnId = store.webClientTurnId(owner.name, owner.agent, row.parentTurnId);
    if (!parentTurnId) return null;
    const blueprint = row.blueprint;
    return { id: row.id, parentTurnId, status: row.status, target: row.target, title: clipText(row.title, 120) ?? 'Work session',
      ...(typeof blueprint?.id === 'string' && BLUEPRINT_ID.test(blueprint.id) &&
        typeof blueprint?.revision === 'string' && /^[0-9a-f]{64}$/.test(blueprint.revision) &&
        { blueprint: { id: blueprint.id, revision: blueprint.revision } }),
    };
  };
  if (!id) {
    if (!Array.isArray(payload?.sessions)) throw fail(503);
    return { sessions: payload.sessions.slice(0, 100).map(summary).filter(Boolean) };
  }
  const row = payload?.session;
  const session = summary(row);
  if (!session || session.id !== id || !Array.isArray(row.transcript)) throw fail(404);
  session.transcript = row.transcript.slice(0, 100).flatMap(entry => {
    if (!entry || !['user', 'assistant'].includes(entry.role) || typeof entry.text !== 'string') return [];
    return [{ role: entry.role, text: entry.text.slice(0, 16000) }];
  });
  return { session };
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

const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieSecure ? '; Secure' : ''}`;
const clearedCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecure ? '; Secure' : ''}`;

function sendLogin(res, status, message) {
  const body = loginPage.replace('<!--LOGIN-ERROR-->', message
    ? `<p id="login-error" class="login-error" role="alert">${escapeHtml(message)}</p>` : '');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': LOGIN_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    ...(status === 401 && { 'www-authenticate': 'Basic realm="Manolo", charset="UTF-8"' }),
  });
  res.end(body);
}

async function readLoginForm(req) {
  if (req.headersDistinct['content-type']?.length !== 1 ||
      req.headersDistinct['content-type'][0].split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw fail(415);
  if (Number(req.headers['content-length']) > 4096) throw fail(413);
  let size = 0;
  const chunks = [];
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.length;
    if (size > 4096) throw fail(413);
    chunks.push(part);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return { username: form.get('username') ?? '', password: form.get('password') ?? '' };
}

async function login(req, res) {
  // A cross-site form post must not be able to sign the browser into someone else's account.
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && !['same-origin', 'none'].includes(site)) throw fail(403);
  const address = req.socket.remoteAddress ?? 'unknown';
  if (loginBlocked(address)) {
    return sendLogin(res, 429, 'Too many failed sign-in attempts. Wait a few minutes and try again.');
  }
  const { username, password } = await readLoginForm(req);
  const entry = config.owners.get(username);
  const valid = entry !== undefined && password.length <= 256 && equal(password, entry.password);
  if (!valid) {
    recordLoginFailure(address);
    // One message for every failure: never reveal whether the username exists.
    return sendLogin(res, 401, 'That username and password did not match.');
  }
  loginFailures.delete(address);
  const { token, maxAge } = sessions.issue(username);
  res.writeHead(303, { location: '/', 'set-cookie': sessionCookie(token, maxAge), 'cache-control': 'no-store' });
  res.end();
}

// Owner-facing MCP management talks to the owner's own worker. The relay holds the agent token; the browser never does.
async function workerApi(agent, path, { method = 'GET', body, maxBytes = 256 * 1024 } = {}) {
  const { url, token } = config.agents.get(agent);
  let response;
  try {
    response = await fetch(`${url}${path}`, {
      method, redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch { throw fail(503); }
  // A worker is trusted, but a version skew or a bug must not be able to stream an unbounded body into the relay.
  let result;
  try {
    result = JSON.parse((await readBounded(response, maxBytes, AbortSignal.timeout(30_000))).toString('utf8'));
  } catch { throw fail(503); }
  if (!response.ok) throw fail(response.status >= 400 && response.status < 500 ? response.status : 503);
  return result;
}

// The panel renders what it gets, so the relay projects a worker's inventory onto the fields it reads: a version skew or
// a malformed row becomes 503 instead of a null a template would dereference.
function capabilityInventory(value) {
  const text = (item, key, limit = 4096) => (typeof item?.[key] === 'string' ? item[key].slice(0, limit) : undefined);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(503);
  const agent = value.agent;
  if (!agent || typeof agent !== 'object' || Array.isArray(agent) || typeof agent.instructions !== 'string' ||
      typeof agent.id !== 'string') throw fail(503);
  const rows = (key, project, limit) => {
    const list = value[key];
    if (!Array.isArray(list)) throw fail(503);
    return list.slice(0, limit).map(project).filter(Boolean);
  };
  // A worker that predates a section returns no field at all; that is an empty inventory, not a broken response.
  const optionalRows = (key, project, limit) => {
    const list = value[key];
    return Array.isArray(list) ? list.slice(0, limit).map(project).filter(Boolean) : [];
  };
  return {
    agent: {
      id: agent.id.slice(0, 128),
      instructions: agent.instructions.slice(0, 4000),
      ...(typeof agent.workSessionRules === 'string' && { workSessionRules: agent.workSessionRules.slice(0, 4000) }),
    },
    tools: rows('tools', item => typeof item?.name === 'string' && {
      name: item.name.slice(0, 64),
      ...(text(item, 'description', 200) !== undefined && { description: text(item, 'description', 200) }),
      ...(text(item, 'source', 64) !== undefined && { source: text(item, 'source', 64) }),
    }, 128),
    // The catalog for creating work, forwarded exactly as the worker filtered it. The limit is the validated configured
    // maximum for both Blueprint formats, so this projection can never hide a row that create_task still accepts.
    blueprints: rows('blueprints', item => typeof item?.id === 'string' && {
      id: item.id.slice(0, 64),
      ...(text(item, 'description', 200) !== undefined && { description: text(item, 'description', 200) }),
      ...(text(item, 'profile', 64) !== undefined && { profile: text(item, 'profile', 64) }),
    }, TASK_CATALOG_LIMIT),
    profiles: optionalRows('profiles', item => typeof item?.id === 'string' && {
      id: item.id.slice(0, 64),
      ...(text(item, 'description', 200) !== undefined && { description: text(item, 'description', 200) }),
      ...(text(item, 'model', 128) !== undefined && { model: text(item, 'model', 128) }),
      ...(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(item?.thinkingLevel) &&
        { thinkingLevel: item.thinkingLevel }),
    }, TASK_PROFILE_LIMIT),
    agentsFiles: rows('agentsFiles', item => typeof item?.path === 'string' && {
      path: item.path.slice(0, 1024),
      bytes: Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : 0,
    }, 16),
    skills: rows('skills', item => typeof item?.name === 'string' && {
      name: item.name.slice(0, 64),
      ...(text(item, 'description', 200) !== undefined && { description: text(item, 'description', 200) }),
      ...(text(item, 'path', 1024) !== undefined && { path: text(item, 'path', 1024) }),
      ...(text(item, 'source', 32) !== undefined && { source: text(item, 'source', 32) }),
    }, 16),
  };
}

async function web(req, res, path, search = '') {
  if (path === '/login') {
    if (req.method === 'GET') return sendLogin(res, 200);
    if (req.method === 'POST') return login(req, res);
    return respond(res, 405, { error: 'Method not allowed' }, { allow: 'GET, POST' });
  }
  if (path === '/logout' && req.method === 'POST') {
    if (req.headers['x-manolo-request'] !== '1') throw fail(403);
    const owner = ownerAuth(req);
    if (!owner) return respond(res, 401, { error: 'Sign in as an owner' });
    if (owner.token !== undefined) sessions.revoke(owner.token);
    return respond(res, 200, { ok: true }, { 'set-cookie': clearedCookie() });
  }
  // The stylesheet is public so the sign-in form is not a bare page. It holds no data.
  if (req.method === 'GET' && path === '/style.css') {
    const { type, body } = WEB.get(path);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    return res.end(body);
  }
  // The theme runs before the workspace loads, so the first paint already has the owner's choice. It is public for the
  // same reason the stylesheet is: it holds no data, and the sign-in page uses it too.
  if (req.method === 'GET' && path === '/theme.js') {
    const { type, body } = WEB.get(path);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (req.method === 'GET' && VENDOR.has(path)) {
    const { type, body } = VENDOR.get(path);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400, immutable', 'x-content-type-options': 'nosniff' });
    return res.end(body);
  }
  const owner = ownerAuth(req);
  if (!owner) {
    // A browser navigation gets the sign-in page; an API caller keeps the machine-readable 401.
    if (req.method === 'GET' && !path.startsWith('/api/') && req.headers.accept?.includes('text/html')) {
      res.writeHead(303, { location: '/login', 'cache-control': 'no-store' });
      return res.end();
    }
    return respond(res, 401, { error: 'Sign in as an owner' }, { 'www-authenticate': 'Basic realm="Manolo", charset="UTF-8"' });
  }
  if (req.method === 'GET' && path === '/api/session') {
    return respond(res, 200, { user: owner.name, agent: owner.agent, via: owner.via, browser: browserUrls.has(owner.agent) });
  }
  // The agent's desktop, proxied only for the signed-in owner's own agent; the path never names an agent.
  if (isDesktopPath(path)) {
    const base = browserUrls.get(owner.agent);
    if (!base) throw fail(404);
    if (path === DESKTOP_PATH) return respond(res, 308, { error: 'Desktop lives at /desktop/' }, { location: `${DESKTOP_PATH}/${search}` });
    res.removeHeader('content-security-policy');
    res.removeHeader('x-content-type-options');
    return proxyDesktop(req, res, base, path.slice(DESKTOP_PATH.length), search);
  }
  // Read-only capability inventory for the owner's own agent. The relay holds the agent token; the browser never does.
  if (path === '/api/capabilities') {
    if (req.method !== 'GET') throw fail(404);
    const inventory = await workerApi(owner.agent, '/v1/capabilities', { maxBytes: 64 * 1024 });
    return respond(res, 200, capabilityInventory(inventory));
  }
  if (path === '/api/mcp' || path.startsWith('/api/mcp/')) {
    if (req.method === 'GET' && path === '/api/mcp') {
      // The MCP config rides in this response JSON-escaped, so its wire budget is larger than the 128 KiB text limit.
      const state = await workerApi(owner.agent, '/v1/mcp', { maxBytes: 512 * 1024 });
      // A sign-in started while connecting (before the owner asked) is already pending in the worker; adopt its state
      // so the callback route recognizes it.
      for (const server of state.servers ?? []) if (server.authState) rememberSignIn(server.authState, owner.agent);
      return respond(res, 200, state);
    }
    if (req.headers['x-manolo-request'] !== '1') throw fail(403);
    if (req.method === 'PUT' && path === '/api/mcp/config') {
      // The worker enforces 128 KiB on the config text itself; the envelope is larger because JSON escapes it.
      const body = await readJson(req, 512 * 1024);
      if (!ownFields(body, 'text') || typeof body.text !== 'string') throw fail(400);
      return respond(res, 200, await workerApi(owner.agent, '/v1/mcp/config', { method: 'PUT', body: { text: body.text } }));
    }
    if (req.method === 'POST' && path === '/api/mcp/sign-in') {
      const body = await readJson(req);
      if (!ownFields(body, 'server') || !ID.test(body.server)) throw fail(400);
      const started = await workerApi(owner.agent, '/v1/mcp/sign-in', { method: 'POST', body: { server: body.server } });
      if (started.state) rememberSignIn(started.state, owner.agent);
      return respond(res, 200, started);
    }
    throw fail(404);
  }
  // The authorization server redirects the owner's browser here; a state started by another owner is refused.
  if (req.method === 'GET' && path === '/mcp/oauth/callback') {
    const query = new URLSearchParams(search);
    const state = query.get('state') ?? '';
    const code = query.get('code') ?? '';
    const entry = state === '' ? undefined : takeSignIn(state);
    const page = (status, message) => {
      res.removeHeader('content-security-policy');
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Manolo · MCP sign-in</title>` +
        `<body style="font:15px/1.5 system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem;background:#17171b;color:#eeeef3">` +
        `<p>${message}</p><p><a style="color:#c4acff" href="/">Back to Manolo</a></p>`);
    };
    if (!entry || entry.agent !== owner.agent) return page(400, 'This sign-in link is unknown or has expired. Start it again from the workspace.');
    if (query.get('error')) return page(400, 'The authorization server refused the sign-in. Try again from the workspace.');
    if (code === '') return page(400, 'The authorization server returned no code.');
    try {
      const result = await workerApi(owner.agent, '/v1/mcp/callback', { method: 'POST', body: { code, state } });
      return page(200, `Signed in. ${result.server ? `The ${result.server} server is reconnecting.` : ''} You can close this tab.`);
    } catch {
      return page(502, 'The agent could not complete the sign-in. Try again from the workspace.');
    }
  }
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
  if (req.method === 'GET' && path === '/api/inbox') return respond(res, 200, {
    messages: store.messages(owner.agent),
    ...(workSessionsEnabled(owner.agent) && { questions: store.inboxQuestions(owner.name, owner.agent) }),
    ...(workSessionsEnabled(owner.agent) && { taskItems: store.tasks.openItems(store.webSession(owner.name, owner.agent)) }),
  });
  // Tasks are scoped to the signed-in owner's own conversation; the relay never takes an owner from the request.
  if (req.method === 'GET' && path === '/api/tasks/events') {
    if (!workSessionsEnabled(owner.agent)) throw fail(404);
    return respond(res, 200, { events: store.tasks.notices(store.webSession(owner.name, owner.agent)) });
  }
  if (req.method === 'GET' && path === '/api/tasks') {
    if (!workSessionsEnabled(owner.agent)) throw fail(404);
    // Active work and History are separate reads: terminal traffic can never crowd active Tasks out of the view, and
    // History is filtered and paged by the ledger rather than by the browser.
    const query = new URLSearchParams(search);
    const status = query.get('status') ?? 'history';
    if (!['history', 'done', 'failed', 'cancelled'].includes(status)) throw fail(400);
    const blueprint = query.get('blueprint') ?? undefined;
    if (blueprint !== undefined && !BLUEPRINT_ID.test(blueprint)) throw fail(400);
    const text = query.get('text')?.slice(0, 120) || undefined;
    const cursor = query.get('cursor') ?? undefined;
    if (cursor !== undefined && !/^[0-9]{1,16}$/.test(cursor)) throw fail(400);
    const scope = store.webSession(owner.name, owner.agent);
    const history = store.tasks.history(scope, { status, blueprint, text, cursor });
    return respond(res, 200, {
      active: store.tasks.active(scope),
      history: history.tasks,
      ...(history.nextCursor && { historyCursor: history.nextCursor }),
      blueprints: store.tasks.blueprints(scope),
    });
  }
  const taskDetail = /^\/api\/tasks\/([0-9a-f]{32})$/.exec(path);
  if (req.method === 'GET' && taskDetail) {
    if (!workSessionsEnabled(owner.agent)) throw fail(404);
    const task = store.tasks.get(store.webSession(owner.name, owner.agent), taskDetail[1]);
    if (!task) throw fail(404);
    let transcript;
    try {
      const execution = await workerTaskRequest(owner.agent, `/v1/tasks/${taskDetail[1]}/transcript`, { timeout: 5000 });
      if (execution.ok && Array.isArray(execution.body?.transcript)) transcript = execution.body.transcript;
    } catch {
      // The Task detail is still useful without the child transcript.
    }
    return respond(res, 200, { task, ...(transcript && { transcript }) });
  }
  const session = /^\/api\/sessions(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(path);
  if (req.method === 'GET' && session) return respond(res, 200, await workerWorkSessions(owner, session[1]));
  if (req.method === 'GET' && path === '/api/turns') {
    const turns = store.webHistory(owner.name, owner.agent).map(turn => {
      const live = turn.status === 'pending' && liveTurns.get(webLiveId(owner, turn.id));
      return live ? { ...turn, live } : turn;
    });
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
    const result = store.webTurn(owner.name, owner.agent, turn[1], { includeActivity: true });
    if (!result) throw fail(404);
    const live = result.status === 'pending' && liveTurns.get(webLiveId(owner, turn[1]));
    if (live) result.live = live;
    return respond(res, 200, result);
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    if (req.headers['x-manolo-request'] !== '1') throw fail(403);
    const taskCancel = /^\/api\/tasks\/([0-9a-f]{32})\/cancel$/.exec(path);
    if (req.method === 'POST' && taskCancel) {
      if (!workSessionsEnabled(owner.agent)) throw fail(404);
      const result = store.tasks.cancel(store.webSession(owner.name, owner.agent), taskCancel[1]);
      // The ledger cancellation is final; stopping the worker is a durable, retried step reported separately.
      if (result.stopPending) {
        void runStop({ id: taskCancel[1], agent: owner.agent, execution_id: result.executionId });
      }
      return respond(res, 200, result.task);
    }
    const taskRespond = /^\/api\/tasks\/([0-9a-f]{32})\/inbox\/([0-9a-f]{32})\/respond$/.exec(path);
    if (req.method === 'POST' && taskRespond) {
      if (!workSessionsEnabled(owner.agent)) throw fail(404);
      const body = await readJson(req);
      const answer = body && ownFields(body, 'answer') && isTaskInput(body.answer) ? body.answer
        : body && ownFields(body, 'decline') && body.decline === true ? null : undefined;
      if (answer === undefined) throw fail(400);
      return respond(res, 200, store.tasks.respond(store.webSession(owner.name, owner.agent), taskRespond[2], answer));
    }
    const question = /^\/api\/inbox\/questions\/([0-9a-f]{64})\/respond$/.exec(path);
    if (req.method === 'POST' && question) {
      if (!workSessionsEnabled(owner.agent)) throw fail(404);
      const body = await readJson(req);
      const answer = ownFields(body, 'answer') && isText(body.answer) ? body.answer
        : ownFields(body, 'decline') && body.decline === true ? null : undefined;
      if (answer === undefined) throw fail(400);
      return respond(res, 200, store.respondInboxQuestion(owner.name, owner.agent, question[1], answer));
    }
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
      return respond(res, 200, store.webSubmit(owner.name, owner.agent, body.id, body.text, { includeActivity: true }));
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
  if (req.method === 'POST' && path === '/v1/inbox/question') {
    if (!workSessionAgents.size) throw fail(404);
    // Keep the old split: an unconfigured relay has no route, an unlisted agent is forbidden.
    if (!workSessionsEnabled(agent)) throw fail(403);
    const idem = req.headersDistinct['idempotency-key'];
    if (idem?.length !== 1 || !ID.test(idem[0])) throw fail(400);
    const body = await readJson(req);
    if (!ownFields(body, 'turnId', 'prompt') || typeof body.turnId !== 'string' || !ID.test(body.turnId) ||
        !isInboxPrompt(body.prompt)) throw fail(400);
    return respond(res, 200, store.openInboxQuestion(agent, body.turnId, body.prompt, idem[0],
      name => config.owners.get(name)?.agent === agent));
  }
  const taskRoute = /^\/v1\/tasks(?:\/([0-9a-f]{32})(?:\/(cancel|inbox|progress|settle|finish|heartbeat|state|block))?)?$/.exec(path);
  if (taskRoute) {
    if (!workSessionAgents.size) throw fail(404);
    if (!workSessionsEnabled(agent)) throw fail(403);
    const [, taskId, action] = taskRoute;
    const idem = req.headersDistinct['idempotency-key'];
    const idempotencyKey = () => {
      if (idem?.length !== 1 || !ID.test(idem[0])) throw fail(400);
      return key('task-operation', agent, idem[0]);
    };
    if (req.method === 'POST' && taskId === undefined) {
      // A pinned Blueprint snapshot travels with the Task. The extra budget is for explicit Markdown text, never files.
      const body = await readJson(req, 64 * 1024);
      let blueprintSnapshot;
      let profile;
      let review;
      try {
        if (body && Object.hasOwn(body, 'blueprint') && body.blueprint && Object.hasOwn(body.blueprint, 'snapshot')) {
          blueprintSnapshot = verifyBlueprintSnapshot(body.blueprint.snapshot);
        }
        if (body && Object.hasOwn(body, 'profile')) profile = verifyProfileSnapshot(body.profile);
      } catch {
        throw fail(400);
      }
      if (body && Object.hasOwn(body, 'reviewOf') &&
          (typeof body.reviewOf !== 'string' || !TASK_ID.test(body.reviewOf))) throw fail(400);
      if (body && Object.hasOwn(body, 'requiresPullRequest') && typeof body.requiresPullRequest !== 'boolean') throw fail(400);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some(field => !['turnId', 'title', 'task', 'blueprint', 'profile', 'reviewOf', 'requiresPullRequest', 'notBefore'].includes(field)) ||
          typeof body.turnId !== 'string' || !isTaskTitle(body.title) || !isTaskInput(body.task) ||
          (Object.hasOwn(body, 'blueprint') && (!body.blueprint || typeof body.blueprint !== 'object' ||
            !ownFields(body.blueprint, 'id', 'revision', ...(blueprintSnapshot ? ['snapshot'] : [])) || typeof body.blueprint.id !== 'string' ||
            !BLUEPRINT_ID.test(body.blueprint.id) || typeof body.blueprint.revision !== 'string' ||
            !/^[0-9a-f]{64}$/.test(body.blueprint.revision) ||
            (blueprintSnapshot && (blueprintSnapshot.id !== body.blueprint.id || blueprintSnapshot.revision !== body.blueprint.revision)))) ||
          (Object.hasOwn(body, 'notBefore') && (!Number.isSafeInteger(body.notBefore) || body.notBefore < 0))) {
        throw fail(400);
      }
      const operationKey = idempotencyKey();
      const { turn, scope } = taskTurnScope(body.turnId, agent);
      if (body.reviewOf) {
        const source = store.tasks.get(scope, body.reviewOf);
        if (!source || source.status !== 'done') throw fail(409);
        if (!source.handoff?.commit || !/^[0-9a-f]{40,64}$/.test(source.handoff.commit) ||
            !/^[0-9a-f]{40,64}$/.test(source.handoff.base ?? '')) throw fail(409);
        if (!blueprintSnapshot?.repository) throw fail(409);
        if (!source.handoff.handoff || source.handoff.handoff !== blueprintSnapshot.repository.handoff) throw fail(409);
        review = {
          sourceTaskId: source.id, commit: source.handoff.commit, baseSha: source.handoff.base,
          ...(source.handoff.branch && { branch: source.handoff.branch }),
          ...(source.handoff.handoff && { handoff: source.handoff.handoff }),
        };
      }
      // A structured new-style Task pins a snapshot, profile, review binding, or required evidence. It always needs the
      // finish protocol, even during a mixed-version rollout. `MANOLO_TASK_FINISH=legacy` is an explicit, relay-wide
      // override for a worker that predates `finish`: it marks a new *unstructured* Task `finish_required=0` so an old
      // worker can still settle its bare final. The override is narrow by construction and enforced in the ledger, not
      // here: `settle` accepts a bare success only for a row that records no snapshot, no profile, no review binding, and
      // no pull-request requirement, so structured evidence can never be bypassed by the rollout mode or a migrated row.
      const structured = Boolean(blueprintSnapshot || profile || review || body.requiresPullRequest === true);
      const task = store.tasks.create({
        owner: turn.owner, agent, scope, originTurnId: turn.id, title: body.title, input: body.task,
        blueprint: body.blueprint, blueprintSnapshot, profile, review,
        requiresPr: body.requiresPullRequest === true,
        finishRequired: taskFinishRequired || structured, notBefore: body.notBefore ?? 0, key: operationKey,
      });
      return respond(res, 200, task);
    }
    if (req.method === 'GET' && taskId === undefined) {
      const query = new URLSearchParams(new URL(req.url, 'http://local.invalid').search);
      const { scope } = taskTurnScope(query.get('turnId'), agent);
      const blueprint = query.get('blueprint') ?? undefined;
      if (blueprint !== undefined && !BLUEPRINT_ID.test(blueprint)) throw fail(400);
      return respond(res, 200, {
        tasks: store.tasks.list(scope, {
          status: query.get('status') ?? undefined, blueprint,
          text: query.get('text')?.slice(0, 120) || undefined,
        }),
      });
    }
    if (req.method === 'GET' && action === undefined) {
      const query = new URLSearchParams(new URL(req.url, 'http://local.invalid').search);
      const { scope } = taskTurnScope(query.get('turnId'), agent);
      const task = store.tasks.get(scope, taskId);
      if (!task) throw fail(404);
      return respond(res, 200, task);
    }
    if (req.method === 'GET' && action === 'state') {
      const meta = store.tasks.meta(taskId);
      if (!meta || meta.agent !== agent) throw fail(404);
      const query = new URLSearchParams(new URL(req.url, 'http://local.invalid').search);
      const executionId = query.get('executionId');
      if (executionId !== null && (!TASK_ID.test(executionId) || meta.executionId !== executionId)) throw fail(409);
      return respond(res, 200, {
        status: meta.status, executionId: meta.executionId, finishAccepted: meta.finishAccepted,
        finishSummary: meta.finishSummary, evidence: meta.handoff, blocked: meta.blocked,
      });
    }
    if (req.method === 'POST' && action === 'cancel') {
      const body = await readJson(req);
      if (!ownFields(body, 'turnId')) throw fail(400);
      const { scope } = taskTurnScope(body.turnId, agent);
      const result = store.tasks.cancel(scope, taskId);
      if (result.stopPending) {
        void runStop({ id: taskId, agent, execution_id: result.executionId });
      }
      return respond(res, 200, result.task);
    }
    // The worker's own calls: the execution ID it was given fences every one of them.
    const meta = taskId && store.tasks.meta(taskId);
    if (taskId !== undefined && action !== undefined && action !== 'cancel' && (!meta || meta.agent !== agent)) throw fail(404);
    if (req.method === 'POST' && action === 'inbox') {
      const operationKey = idempotencyKey();
      const body = await readJson(req);
      if (!ownFields(body, 'executionId', 'kind', 'prompt') || typeof body.executionId !== 'string' ||
          !TASK_ID.test(body.executionId) || !['question', 'report'].includes(body.kind) || !isTaskPrompt(body.prompt)) throw fail(400);
      return respond(res, 200, store.tasks.park({ taskId, executionId: body.executionId, kind: body.kind, prompt: body.prompt, key: operationKey }));
    }
    if (req.method === 'POST' && action === 'progress') {
      const operationKey = idempotencyKey();
      const body = await readJson(req);
      if (!ownFields(body, 'executionId', 'note') || typeof body.executionId !== 'string' ||
          !TASK_ID.test(body.executionId) || !isTaskNote(body.note)) throw fail(400);
      return respond(res, 200, store.tasks.progress({ taskId, executionId: body.executionId, note: body.note, key: operationKey }));
    }
    if (req.method === 'POST' && action === 'finish') {
      const operationKey = idempotencyKey();
      const body = await readJson(req);
      const finishFields = ['executionId', 'summary',
        ...(body?.evidence === undefined ? [] : ['evidence']), ...(body?.run === undefined ? [] : ['run'])];
      if (!ownFields(body, ...finishFields)) throw fail(400);
      if (typeof body.executionId !== 'string' || !TASK_ID.test(body.executionId) || typeof body.summary !== 'string' ||
          body.summary.length > 2500 ||
          (body.run !== undefined && (!Number.isSafeInteger(body.run) || body.run < 1)) ||
          (body.evidence !== undefined && (typeof body.evidence !== 'object' || body.evidence === null ||
            Object.keys(body.evidence).some(field => !['commit', 'base', 'branch', 'handoff', 'review', 'pullRequest'].includes(field)) ||
            ['commit', 'branch', 'handoff'].some(field => body.evidence[field] !== undefined &&
              (typeof body.evidence[field] !== 'string' || body.evidence[field].length > 2048)) ||
            (body.evidence.commit !== undefined && !/^[0-9a-f]{40,64}$/.test(body.evidence.commit)) ||
            (body.evidence.base !== undefined && body.evidence.base !== null && !/^[0-9a-f]{40,64}$/.test(body.evidence.base)) ||
            (body.evidence.review !== undefined && (typeof body.evidence.review !== 'object' || body.evidence.review === null)) ||
            (body.evidence.pullRequest !== undefined && (!body.evidence.pullRequest ||
              typeof body.evidence.pullRequest.url !== 'string' || !/^https:\/\/github\.com\//.test(body.evidence.pullRequest.url) ||
              typeof body.evidence.pullRequest.commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(body.evidence.pullRequest.commit)))))) throw fail(400);
      return respond(res, 200, store.tasks.acceptFinish({
        taskId, executionId: body.executionId, summary: body.summary, evidence: body.evidence, key: operationKey, run: body.run,
      }));
    }
    if (req.method === 'POST' && action === 'settle') {
      const operationKey = idempotencyKey();
      const body = await readJson(req);
      // The worker's own delivery receipts ride along with the outcome. They are the only evidence that an Inbox answer
      // reached the child; the ledger never infers a delivery from the settle itself.
      const delivered = body?.deliveredItems ?? [];
      // The settlement names the admission it belongs to. The ledger refuses one for a submission a recovery has already
      // replaced, so an outcome that was in flight when the relay opened a block or a continuation landed cannot end the
      // live work that replaced it. The field is optional, so a worker that predates it keeps the unversioned contract.
      const fields = ['executionId', 'outcome', 'summary',
        ...(body?.deliveredItems === undefined ? [] : ['deliveredItems']), ...(body?.run === undefined ? [] : ['run'])];
      if (!ownFields(body, ...fields) || typeof body.executionId !== 'string' ||
          !TASK_ID.test(body.executionId) || !['done', 'failed'].includes(body.outcome) ||
          typeof body.summary !== 'string' || body.summary.length > MAX_TASK_INPUT ||
          (body.run !== undefined && (!Number.isSafeInteger(body.run) || body.run < 1)) ||
          !Array.isArray(delivered) || delivered.length > 10 ||
          !delivered.every(id => typeof id === 'string' && TASK_ID.test(id))) throw fail(400);
      return respond(res, 200, store.tasks.settle({
        taskId, executionId: body.executionId, outcome: body.outcome, summary: body.summary,
        deliveredItems: delivered, key: operationKey, run: body.run,
      }));
    }
    // The child reports a recoverable workspace loss mid-run instead of spending a corrective turn or failing the Task.
    if (req.method === 'POST' && action === 'block') {
      const body = await readJson(req);
      const blockFields = ['executionId', 'reason', ...(body?.run === undefined ? [] : ['run'])];
      if (!ownFields(body, ...blockFields) || typeof body.executionId !== 'string' ||
          !TASK_ID.test(body.executionId) || !isTaskNote(body.reason) ||
          (body.run !== undefined && (!Number.isSafeInteger(body.run) || body.run < 1))) throw fail(400);
      return respond(res, 200, { ok: store.tasks.block(taskId, body.executionId, body.reason, Date.now(), 60_000, { run: body.run }) });
    }
    if (req.method === 'POST' && action === 'heartbeat') {
      const body = await readJson(req);
      if (!ownFields(body, 'executionId') || typeof body.executionId !== 'string' || !TASK_ID.test(body.executionId)) throw fail(400);
      return respond(res, 200, { ok: store.tasks.heartbeat({ taskId, executionId: body.executionId }) });
    }
    throw fail(404);
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

function serve(handler, port, host, onUpgrade) {
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    limits(res, handler === web);
    try {
      const url = new URL(req.url, 'http://local.invalid');
      if (handler !== device && url.pathname === '/healthz' && req.method === 'GET') return respond(res, 200, { ok: true });
      await handler(req, res, url.pathname, url.search);
    } catch (error) {
      if (res.headersSent || res.destroyed) return res.destroy();
      const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
      if (status === 500) console.error('Relay request failed unexpectedly');
      respond(res, status, { error: status >= 500 ? 'Service unavailable' : 'Request rejected' }, !req.readableEnded ? { connection: 'close' } : undefined);
    }
  });
  if (onUpgrade) server.on('upgrade', onUpgrade);
  server.listen(port, host, () => console.log(`${handler.name} listening on ${server.address().address}:${server.address().port}`));
  return server;
}

// A websocket handshake bypasses `web()`, so it repeats the owner check and keeps the agent fixed by the owner.
function webUpgrade(req, socket, head) {
  const reject = (status, headers = '') => socket.end(`HTTP/1.1 ${status}\r\n${headers}connection: close\r\ncontent-length: 0\r\n\r\n`);
  let url;
  try { url = new URL(req.url, 'http://local.invalid'); } catch { return reject('400 Bad Request'); }
  if (!isDesktopPath(url.pathname)) return reject('404 Not Found');
  const owner = ownerAuth(req);
  if (!owner) return reject('401 Unauthorized', 'www-authenticate: Basic realm="Manolo", charset="UTF-8"\r\n');
  const base = browserUrls.get(owner.agent);
  if (!base) return reject('404 Not Found');
  if (!upgradeDesktop(req, socket, head, base)) reject('404 Not Found');
}

async function pollTelegram() {
  let wait = 1000;
  while (!stop.signal.aborted) {
    try {
      const updates = await telegram.poll(store.cursor(), stop.signal);
      store.ingest(updates, config.routes, botScope, config.rooms);
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
  const typing = transport === 'telegram' ? telegramTyping : null;
  // Recheck durable jobs against the current config before worker admission and before every delivery.
  const isRoom = transport === 'telegram' && job.room_mentioned != null;
  const room = isRoom ? config.rooms.get(chatId) : undefined;
  const allowed = isRoom
    ? room?.agent === agent && admittedRoom(room, userId, job.room_mentioned === 1) &&
      sessionId === key('telegram-room', botScope, chatId, agent) &&
      !job.voice_file_id && !job.voice_reply && Number.isSafeInteger(job.reply_message_id) && job.reply_message_id > 0
    : config.routes.get(routeKey({ transport, userId, chatId })) === agent;
  if (!allowed) {
    typing?.end(chatId);
    return advance('dead');
  }
  if (job.state === 'send') typing?.end(chatId);
  else typing?.begin(chatId);
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
    const turn = await worker(agent, id, job.state === 'submit' ? {
      sessionId, text: job.input, ...(isRoom && { room: { instructions: room.instructions } }),
    } : undefined);
    if (turn.status === 'pending') return advance('wait', null, Date.now() + 1000);
    typing?.end(chatId);
    return advance('send', turn.text || 'The agent returned no text.');
  } catch (err) {
    typing?.end(chatId);
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
    liveTurns.delete(job.turn_id);
    return advance('failed');
  }
  // Undelivered Task notices ride along with the next orchestrator turn, so the model does not have to poll. They are
  // recorded as delivered only once the worker accepted this admission, and the same event never becomes a chat turn.
  const notices = job.state === 'submit' && !job.owner.startsWith('device:')
    ? store.tasks.pendingNotices(store.webSession(job.owner, job.agent)) : [];
  try {
    const turn = await worker(job.agent, job.turn_id, job.state === 'submit' ? {
      sessionId: job.session_id, text: job.input,
      ...(workSessionsEnabled(job.agent) && !job.owner.startsWith('device:') && { workSessions: true }),
      ...(notices.length > 0 && { taskNotices: notices.map(note => note.text) }),
      ...(runtimes && job.agent === runtimeAgent && runtimeOwner(job.owner) && { runtimes: runtimes.targets() }),
    } : undefined);
    if (notices.length > 0) store.tasks.markNoticesDelivered(notices.map(note => note.seq), job.turn_id);
    if (turn.status === 'pending') {
      if (turn.live) setLive(job.turn_id, turn.live);
      else liveTurns.delete(job.turn_id);
      return advance('wait', { next: Date.now() + 500 });
    }
    liveTurns.delete(job.turn_id);
    advance(turn.status, { output: turn.status === 'done' ? turn.text : null, tools: turn.tools ?? null });
  } catch (err) {
    if (stop.signal.aborted) return;
    if (isFinal(err)) {
      liveTurns.delete(job.turn_id);
      return advance('failed');
    }
    advance(job.state, { next: retryAt(job.attempts + 1), attempts: job.attempts + 1 });
  }
}

// Only a well-formed refusal that no retry can fix is definitive. Anything else - a transport error, a 5xx, a timeout,
// a missing or malformed acknowledgement - is ambiguous and is retried under the same execution identity.
const DEFINITIVE_START = new Map([
  ['blueprint_revision_unavailable', 'The pinned blueprint revision is no longer available.'],
  ['unknown_blueprint', 'The pinned blueprint is no longer configured for this worker.'],
  ['another_execution_current', 'The worker already has a different execution for this Task.'],
  ['invalid_task', 'The worker refused the Task assignment as invalid.'],
  ['invalid_blueprint', 'The pinned Blueprint snapshot is invalid.'],
]);
// These are recoverable by restoring the worker/profile/tool/workspace, not by substituting another selection. The Task
// stays running and blocked, with the same execution identity, and dispatch is retried.
const BLOCKING_START = new Map([
  ['profile_unavailable', 'The pinned model profile is temporarily unavailable on the worker. Restore it; the same assignment will resume.'],
  ['unknown_tool', 'A tool pinned by the Blueprint is not installed on the worker. Install it; the same assignment will resume.'],
  ['invalid_repository', 'The pinned repository configuration is invalid for this worker.'],
  ['worktree_missing', 'The Task worktree is missing or was replaced. Restore it; the Task will resume.'],
  ['git_failed', 'The worker could not prepare the Task worktree.'],
  ['invalid_review', 'The review binding needs a repository Blueprint and exact commit.'],
  ['review_commit_missing', 'The exact review commit is not available from the configured handoff remote.'],
  ['worker_protocol', 'The worker does not support this Task protocol. Upgrade it; the Task will resume.'],
]);
const DEFINITIVE_RESUME = new Set(['unknown_execution', 'no_parked_call']);
// A start is acknowledged only by a parsed worker reply naming a state a worker reports for an admitted execution. A 200
// with an empty or unfamiliar body does not prove the child was admitted, so the dispatch stays owed.
const START_ACK = new Set(['running', 'parked', 'settled', 'failed', 'cancelled']);

// One scheduler pass per Task: a claimed row is either a fresh execution or the delivery of an Inbox response to the
// parked one. Nothing here starts a second execution while the previous one can still be live.
async function runTask(task) {
  const executionId = task.execution_id;
  // The exact dispatch obligation this pass is driving. A late answer or report from an earlier one (an RPC that was in
  // flight when the worker reported a block, a newer response, or an accepted finish) carries a stale epoch and can
  // neither clear the newer recovery nor reset its backoff.
  const epoch = task.dispatch_epoch;
  if (task.execution_kind === 'resume') {
    const item = store.tasks.inboxItem(task.resume_item_id);
    if (!item) {
      store.tasks.resumeUnavailable({
        taskId: task.id, executionId, itemId: task.resume_item_id,
        reason: 'The Inbox item for this resume is missing; the Task was stopped.',
      });
      return;
    }
    // The item's delivery time is the durable resume receipt. A retried delivery reads it instead of calling again.
    if (item.delivered_at !== null) {
      store.tasks.resumeDelivered({ taskId: task.id, executionId, itemId: item.id, epoch });
      return;
    }
    let result;
    try {
      result = await workerTaskRequest(task.agent, `/v1/tasks/${task.id}/resume`, {
        method: 'POST',
        body: { executionId, itemId: item.id, status: item.status, response: item.response ?? '' },
      });
    } catch {
      store.tasks.retryDispatch(task.id, executionId, Date.now(), 'The worker could not be reached for the resume.', { epoch });
      return;
    }
    if (result.ok && result.body?.delivered === true) {
      store.tasks.resumeDelivered({ taskId: task.id, executionId, itemId: item.id, epoch });
      return;
    }
    if (result.ok && result.body?.delivered === false && result.body.reason === 'not_yet_parked') {
      // The execution is live but had not stored its park marker when the answer arrived, so the answer may still reach
      // it. That is ambiguous, not a lost call: retry the same delivery under the same IDs.
      store.tasks.retryDispatch(task.id, executionId, Date.now(), 'The execution had not parked for the response yet.', { epoch });
      return;
    }
    if (result.ok && result.body?.delivered === false && result.body.reason === 'worktree_missing') {
      // A lost or replaced worktree is recoverable. Keep the answered item and block; restoring the workspace retries
      // the same resume instead of terminally failing the Task.
      store.tasks.block(task.id, executionId, result.body.message ?? 'The Task worktree is missing; restore it and the response will resume.', Date.now(), 60_000, { epoch });
      return;
    }
    if (result.ok && result.body?.delivered === false && DEFINITIVE_RESUME.has(result.body.reason)) {
      // An accepted finish is the durable boundary even when the execution that accepted it has ended before the answer
      // was delivered. Settle from the receipt instead of failing a finished Task.
      if (store.tasks.meta(task.id)?.finishAccepted) {
        store.tasks.retryDispatch(task.id, executionId, Date.now(), 'The accepted finish was reconciled after the execution ended.', { epoch });
        return;
      }
      // Never replace the child for Inbox input: end the Task clearly and keep the response on the item.
      store.tasks.resumeUnavailable({
        taskId: task.id, executionId, itemId: item.id,
        reason: 'The execution that asked for your input is no longer available. Your response is saved in the Task.',
      });
      return;
    }
    store.tasks.retryDispatch(task.id, executionId, Date.now(), 'The worker did not confirm the resume.', { epoch });
    return;
  }
  // A new-style assignment must not reach a worker that would ignore its snapshot/profile/review fields or its finish
  // protocol. Version 2 is required for those fields; a legacy Task (no snapshot/profile/review and no finish protocol)
  // may still use the old path.
  const requiresV2 = Boolean(task.blueprint_snapshot || task.profile_snapshot || task.review_snapshot ||
    task.requires_pr === 1 || task.finish_required === 1);
  if (requiresV2 && await workerTaskProtocol(task.agent) < 2) {
    store.tasks.block(task.id, executionId, 'The worker does not support the Task protocol needed by this assignment. Upgrade it; the same assignment will resume.', Date.now(), 60_000, { epoch });
    return;
  }
  // The versioned path is the contract. If the probe said v2 but the worker was replaced in between, the v2 POST is
  // refused or missing; the assignment is then held (blocked) and is never downgraded onto the old path.
  const dispatchPath = requiresV2 ? `/v1/tasks/${task.id}/executions/v2` : `/v1/tasks/${task.id}/executions`;
  let result;
  try {
    result = await workerTaskRequest(task.agent, dispatchPath, {
      method: 'POST',
      body: {
        executionId,
        // The two routes carry two contracts. The versioned route carries the explicit protocol, pinned snapshot,
        // profile, review binding, and finish/PR requirements; the plain route carries only the legacy shape, so a worker
        // holding either contract cannot misread the other.
        task: requiresV2 ? {
          protocol: 2,
          finishRequired: true,
          title: task.title, input: task.input,
          ...(task.context && { context: task.context }),
          ...(task.blueprint_id && {
            blueprint: {
              id: task.blueprint_id, revision: task.blueprint_revision,
              ...(task.blueprint_snapshot && { snapshot: JSON.parse(task.blueprint_snapshot) }),
            },
          }),
          ...(task.profile_snapshot && { profile: JSON.parse(task.profile_snapshot) }),
          ...(task.review_snapshot && { review: JSON.parse(task.review_snapshot) }),
          ...(task.requires_pr === 1 && { requiresPullRequest: true }),
        } : {
          title: task.title, input: task.input,
          ...(task.context && { context: task.context }),
          ...(task.blueprint_id && { blueprint: { id: task.blueprint_id, revision: task.blueprint_revision } }),
        },
      },
    });
  } catch {
    store.tasks.retryDispatch(task.id, executionId, Date.now(), 'The worker could not be reached.', { epoch });
    return;
  }
  if (requiresV2 && !result.ok && [404, 405, 415, 422].includes(result.status)) {
    // A worker that no longer has the v2 route is not fed the same assignment through the old path.
    store.tasks.block(task.id, executionId, BLOCKING_START.get('worker_protocol'), Date.now(), 60_000, { epoch });
    return;
  }
  if (result.ok && result.body?.status === 'blocked') {
    // A blocked answer names the admission that reported it, so the block fences out a settlement from that admission
    // that is still in flight. A worker that does not report one keeps the unversioned behaviour.
    store.tasks.block(task.id, executionId, result.body.message ?? BLOCKING_START.get(result.body.reason) ?? 'The Task is blocked on a recoverable worker condition.', Date.now(), 60_000, { epoch, run: result.body.run });
    return;
  }
  if (result.ok && START_ACK.has(result.body?.status)) {
    // Only a parsed acknowledgement naming a state the worker reports: the child is admitted, and a later restart must
    // not re-drive this dispatch. Anything else leaves the dispatch owed and retried under the same identity. The worker
    // also returns the admission run it made current, so a continuation it admitted while handling this RPC fences out a
    // settlement from the admission it replaced.
    store.tasks.ackDispatch(task.id, executionId, epoch, Date.now(), result.body.run);
    return;
  }
  if (result.body?.reason === 'task_cancelled') {
    // The Task was cancelled while the dispatch was in flight; the ledger already decided.
    store.tasks.ackDispatch(task.id, executionId, epoch);
    return;
  }
  const definitive = DEFINITIVE_START.get(result.body?.reason);
  if (definitive) {
    store.tasks.failExecution(task.id, executionId, definitive);
    return;
  }
  const blocking = BLOCKING_START.get(result.body?.reason);
  if (blocking) {
    store.tasks.block(task.id, executionId, blocking, Date.now(), 60_000, { epoch, run: result.body?.run });
    return;
  }
  store.tasks.retryDispatch(task.id, executionId, Date.now(), 'The worker did not accept the execution.', { epoch });
}

// Cancelling is a ledger decision; this is the separate, retried step that asks the worker to stop. A dispatch that was
// never sent is already stopped by the cleared pending marker, and a dispatch that races this stop is refused by the
// worker's cancelled-execution tombstone. Neither step rolls back work already done outside Manolo.
async function runStop(task) {
  const executionId = task.execution_id;
  if (!executionId) {
    store.tasks.ackStop(task.id);
    return;
  }
  let result;
  try {
    result = await workerTaskRequest(task.agent, `/v1/tasks/${task.id}/cancel`, {
      method: 'POST', body: { executionId },
    });
  } catch {
    store.tasks.retryStop(task.id);
    return;
  }
  if (result.ok && result.body?.ok === true) {
    store.tasks.ackStop(task.id);
    return;
  }
  store.tasks.retryStop(task.id);
}

async function runTasks() {
  while (!stop.signal.aborted) {
    const now = Date.now();
    // Snapshot pending work before claiming, so a freshly claimed row is driven once by this pass, not twice.
    const pending = store.tasks.dueDispatch(now);
    const stops = store.tasks.dueStop(now);
    const claimed = [];
    for (let slot = 0; slot < 4; slot++) {
      const task = store.tasks.claim(now);
      if (!task) break;
      claimed.push(task);
    }
    await Promise.all([...pending.map(runTask), ...claimed.map(runTask), ...stops.map(runStop)]);
    await sleep(300, undefined, { signal: stop.signal });
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
  serve(web, Number(process.env.PORT ?? 8080), webHost, webUpgrade),
  serve(internal, Number(process.env.MANOLO_INTERNAL_PORT ?? 8082), internalHost),
];
if (device) listeners.push(serve(device, Number(process.env.MANOLO_DEVICE_PORT ?? 8083), deviceHost));
if (runtimes) listeners.push(serve(runtimes.device, Number(process.env.MANOLO_RUNTIME_PORT ?? 8084), runtimeHost));
const loops = [drain(store.webReady, runWebTurn), runTasks()];
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
