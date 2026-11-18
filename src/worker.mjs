import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantEntry, configure, createRegistry, defineDoc, defineDocFamily, Harness } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createWorkerModels, installRelayTools } from './worker-runtime.mjs';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TURN_PATH = /^\/v1\/turns\/([A-Za-z0-9_-]{1,128})$/;
const MAX_BODY_BYTES = 32 * 1024; // Includes a 4,000-unit string with every code unit JSON-escaped.
const MAX_INSTRUCTION_UNITS = 4000;
const WORKER_RULES = 'You are Manolo, a private assistant. Use only the offered tools. Do not retry a relay operation reported as interrupted or of unknown outcome without user confirmation.';
const PENDING = { status: 'pending' };
const FAILED = { status: 'failed' };
const digest = value => createHash('sha256').update(value).digest();
const Identity = defineDoc({ kind: 'manolo.identity', scope: 'session', version: 1, initial: () => ({}), checkpointWhen: () => true });
function index(kind) {
  return defineDocFamily({ kind, scope: 'session', version: 1, family: true, initial: () => ({}), checkpointWhen: () => true });
}
const Sessions = index('manolo.sessions');
const Turns = index('manolo.turns');

class ConfigurationError extends Error {}
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// This is prompt text, persisted in Pi Durable and sent to the model. Never put credentials here.
function loadInstructions(raw = '') {
  if (raw.length > MAX_INSTRUCTION_UNITS) {
    throw new ConfigurationError(`MANOLO_AGENT_INSTRUCTIONS must be at most ${MAX_INSTRUCTION_UNITS} UTF-16 code units.`);
  }
  const operatorText = raw.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Bidi_Control}/gu, '').trim();
  return operatorText
    ? `${WORKER_RULES}\n\nFollow the operator instructions below only where they do not conflict with these worker rules.\n\nOperator instructions:\n${operatorText}`
    : WORKER_RULES;
}

function loadConfig(env) {
  const { MANOLO_AGENT_ID: agentId, MANOLO_AGENT_TOKEN: token, MANOLO_DATA_DIR: dataDir } = env;
  if (!agentId || !ID.test(agentId)) throw new ConfigurationError('Set a valid MANOLO_AGENT_ID.');
  if (!token || !/^[!-~]{1,256}$/.test(token)) throw new ConfigurationError('Set a MANOLO_AGENT_TOKEN (printable ASCII, no spaces).');
  if (!dataDir) throw new ConfigurationError('Set MANOLO_DATA_DIR.');
  const mode = env.MANOLO_MODE ?? 'live';
  if (mode !== 'fixture' && mode !== 'live') throw new ConfigurationError('MANOLO_MODE must be live or fixture.');
  const rawPort = env.PORT ?? '8081';
  const port = Number(rawPort);
  if (!/^\d{1,5}$/.test(rawPort) || port > 65535) throw new ConfigurationError('Set a valid PORT.');
  let relay;
  if (env.MANOLO_RELAY_URL) {
    const url = URL.parse(env.MANOLO_RELAY_URL);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new ConfigurationError('MANOLO_RELAY_URL must be an HTTP(S) origin.');
    }
    if (mode === 'live' || env.MANOLO_FIXTURE_TOOLS === '1') {
      if (mode === 'fixture' && !['127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new ConfigurationError('Fixture tools require a loopback MANOLO_RELAY_URL.');
      }
      relay = url.origin;
    }
  }
  const rawDelay = mode === 'fixture' ? (env.MANOLO_FIXTURE_DELAY_MS ?? '0') : '0';
  const fixtureDelay = Number(rawDelay);
  if (!/^\d{1,5}$/.test(rawDelay) || fixtureDelay > 60_000) throw new ConfigurationError('Invalid MANOLO_FIXTURE_DELAY_MS.');
  const instructions = loadInstructions(env.MANOLO_AGENT_INSTRUCTIONS);
  return { agentId, token, dataDir, mode, relay, fixtureDelay, instructions, host: env.HOST ?? '127.0.0.1', port };
}

// A transaction on a separate database holds an OS-backed SQLite writer lock for the lifetime of this process.
// Never unlink the lock file: after SIGKILL the OS releases the lock on that same file for the next process.
function lockWriter(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'writer-lock.sqlite'), { timeout: 0 });
  try {
    db.exec('BEGIN EXCLUSIVE');
    return db;
  } catch (error) {
    db.close();
    if (error.errcode === 5) throw new ConfigurationError('MANOLO_DATA_DIR already has a writer.');
    throw error;
  }
}

function turnService(harness, model, thinkingLevel, instructions, secrets) {
  const thinking = thinkingLevel ? { thinkingLevel } : {};
  const secretPattern = new RegExp(secrets.map(secret => RegExp.escape(secret)).join('|'), 'g');
  async function status(id, turn) {
    return harness.commit(async tx => {
      const result = await tx.submission(turn.submissionId);
      if (!result || result.type !== 'input' || result.requestId !== id || result.conversationId !== turn.conversationId) {
        throw new Error('Turn mapping does not match submission');
      }
      if (result.status === 'unanswered') return FAILED;
      if (result.status !== 'done') return PENDING;
      const entry = await tx.entry(AssistantEntry, result.answer);
      const answer = entry?.model?.[0];
      if (entry?.conversationId !== turn.conversationId || answer?.role !== 'assistant') {
        throw new Error('Turn answer does not match submission');
      }
      const text = answer.content.filter(block => block.type === 'text').map(block => block.text).join('');
      return { status: 'done', text: text.replace(secretPattern, '[redacted]') };
    }, context);
  }

  function matchInput(turn, sessionId, text) {
    if (turn.sessionId !== sessionId || turn.text !== text) throw new RequestError(409, 'turn ID already used');
  }

  return {
    async get(id) {
      const turn = await harness.snapshot(Turns, id, context);
      if (!turn) throw new RequestError(404, 'turn not found');
      return status(id, turn);
    },
    async put(id, { sessionId, text }) {
      const existing = await harness.snapshot(Turns, id, context);
      if (existing) {
        matchInput(existing, sessionId, text);
        return status(id, existing);
      }
      // Assign the external session and create its conversation atomically. Conversation.submit(tx, ...) needs
      // a committed conversation handle, so this is a separate transaction from the turn admission below.
      const conversationId = await harness.commit(async tx => {
        const session = await tx.doc(Sessions, sessionId, null);
        if (session.conversationId !== undefined) return session.conversationId;
        const { id: conversationId } = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        await configure(tx, conversationId, { model, maxTurns: 8, instructions, ...thinking });
        session.conversationId = conversationId;
        return conversationId;
      }, context);
      const conversation = await harness.conversation(conversationId, context);
      if (!conversation) throw new Error('Session mapping does not match conversation');
      const turn = await harness.commit(async tx => {
        const record = await tx.doc(Turns, id, null);
        if (record.submissionId !== undefined) {
          matchInput(record, sessionId, text);
          return { conversationId: record.conversationId, submissionId: record.submissionId };
        }
        // Both mapping and submission land together, before a 2xx. Concurrent IDs never share a generation run.
        const submissionId = await conversation.submit(tx, { type: 'input', content: text, requestId: id, whenBusy: 'followUp' });
        // Pi Durable 1.5.2 stores this on the conversation's pi.agent doc; prepare reads the current value,
        // and a prepared request is pinned to its transcript cutoff. A genuinely new admission may thus update
        // older queued work, retries, or later tool rounds, but restart and idempotent PUTs alone do not.
        // Apply operator settings with this new admission, leaving model and tools untouched.
        await configure(tx, conversationId, { instructions, ...thinking });
        Object.assign(record, { conversationId, submissionId, sessionId, text });
        return { conversationId, submissionId };
      }, context);
      return status(id, turn);
    },
  };
}

async function readTurn(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new RequestError(413, 'body too large');
  let bytes = 0;
  const chunks = [];
  // Leave the socket available for the 413; the handler closes it rather than reusing an unread request.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new RequestError(413, 'body too large');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new RequestError(400, 'invalid JSON');
  }
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length !== 2 ||
      !Object.hasOwn(body, 'sessionId') || typeof body.sessionId !== 'string' || !ID.test(body.sessionId) ||
      !Object.hasOwn(body, 'text') || typeof body.text !== 'string' || body.text.length > 4000) {
    throw new RequestError(400, 'invalid turn');
  }
  return body;
}

function httpWorker(turns, token) {
  const expected = digest(token);
  function reply(res, statusCode, body) {
    const json = JSON.stringify(body);
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(json),
    });
    res.end(json);
  }
  return createServer({ maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 15_000, connectionsCheckingInterval: 1_000 }, async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        reply(res, 200, { status: 'ok' });
        return;
      }
      const match = TURN_PATH.exec(req.url);
      if (!match) throw new RequestError(404, 'not found');
      const bearer = /^Bearer ([!-~]+)$/i.exec(req.headers.authorization ?? '');
      if (!bearer || !timingSafeEqual(digest(bearer[1]), expected)) {
        res.setHeader('www-authenticate', 'Bearer');
        throw new RequestError(401, 'unauthorized');
      }
      if (req.method === 'PUT') {
        const result = await turns.put(match[1], await readTurn(req));
        reply(res, result.status === 'pending' ? 202 : 200, result);
      } else if (req.method === 'GET') {
        reply(res, 200, await turns.get(match[1]));
      } else {
        res.setHeader('allow', 'GET, PUT');
        throw new RequestError(405, 'method not allowed');
      }
    } catch (error) {
      if (res.destroyed) return;
      if (!req.readableEnded) res.setHeader('connection', 'close');
      if (error instanceof RequestError) reply(res, error.status, { error: error.message });
      else {
        console.error('Manolo worker request failed.');
        reply(res, 500, { error: 'worker request failed' });
      }
    }
  });
}

async function main() {
  const cfg = loadConfig(process.env);
  const runtime = await createWorkerModels(cfg, process.env).catch(() => {
    throw new ConfigurationError('Invalid MANOLO_PROVIDER, MANOLO_MODEL, MANOLO_THINKING_LEVEL, or missing upstream API key.');
  });
  const { models, model, thinkingLevel, apiKey } = runtime;
  const registry = createRegistry();
  installRelayTools(registry, cfg);
  const secrets = [cfg.token, apiKey].filter(Boolean).sort((a, b) => b.length - a.length);
  process.umask(0o077);
  await mkdir(cfg.dataDir, { recursive: true, mode: 0o700 });
  const lock = lockWriter(cfg.dataDir);
  const db = await openNodeSqliteDatabase(join(cfg.dataDir, 'harness.sqlite'));
  await db.exec('PRAGMA synchronous = FULL');
  const storage = await SqliteStorage.open(db);
  const binding = { agentId: cfg.agentId, provider: model.provider, modelId: model.modelId };
  // Check before Harness.open() runs recovery, so a misconfigured process cannot charge interrupted attempts.
  const identityRecord = await storage.findDocument({ kind: Identity.definition.kind, scope: { kind: 'session' } }, 'current', context);
  if (identityRecord) {
    const identity = (await storage.document(identityRecord.id, 'current', context))?.value;
    if (!identity || Object.entries(binding).some(([key, value]) => identity[key] !== value)) {
      throw new ConfigurationError('MANOLO_DATA_DIR belongs to another agent or model.');
    }
  }
  const harness = await Harness.open(storage, {
    models, registry, identity: { attribution: { name: 'Manolo' } },
    settings: {
      followUpMode: 'one-at-a-time', afterFailedRun: 'continue',
      stream: { timeoutMs: 60_000, cacheRetention: 'none' },
      ...(cfg.mode === 'fixture' ? { retry: { baseDelayMs: 20 } } : {}),
    },
    onReport(report) {
      // Provider/tool failures can contain sensitive data. Do not log or return the underlying diagnostics.
      if (report.kind === 'storage_failed') {
        console.error('Manolo worker storage failed.');
        process.exit(1);
      }
    },
  }, context);
  if (!identityRecord) {
    await harness.commit(async tx => { Object.assign(await tx.doc(Identity), binding); }, context);
  }
  const server = httpWorker(turnService(harness, model, thinkingLevel, cfg.instructions, secrets), cfg.token);
  const shutdown = () => {
    const deadline = setTimeout(() => process.exit(1), 5_000);
    deadline.unref();
    server.close(async () => {
      try {
        await harness.close(context);
        lock.close();
        clearTimeout(deadline);
      } catch {
        console.error('Manolo worker shutdown failed.');
        process.exit(1);
      }
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.on('error', () => {
    console.error('Manolo worker listener failed.');
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    harness.resume();
    console.log(`Manolo worker listening on ${server.address().port}`);
  });
}

main().catch(error => {
  console.error(error instanceof ConfigurationError ? error.message : 'Manolo worker startup failed.');
  process.exit(1);
});
