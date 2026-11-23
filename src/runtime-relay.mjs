import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const RUNTIME_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const MAX_RUNTIMES = 8;
const MAX_TIMEOUT = 120_000;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = statusCode => Object.assign(new Error('Runtime request rejected'), { statusCode });
const exact = (value, ...keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function createRuntimeRelay(db, agent, { readJson, respond, signal, now = Date.now, pollMs = 8000 }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_devices (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE, UNIQUE(agent,name)
    );
  `);
  const statements = {
    find: db.prepare('SELECT id,name FROM runtime_devices WHERE agent=? AND key_hash=?'),
    all: db.prepare('SELECT id,name FROM runtime_devices WHERE agent=? ORDER BY name'),
    add: db.prepare('INSERT OR IGNORE INTO runtime_devices(id,agent,name,key_hash) VALUES(?,?,?,?)'),
    remove: db.prepare('DELETE FROM runtime_devices WHERE agent=? AND id=?'),
    turn: db.prepare('SELECT owner,agent,state FROM web_turns WHERE turn_id=?'),
  };
  // Enrollment expires on restart. Device identity survives. Commands and waits never replay.
  let enrollment;
  const polls = new Map();
  const calls = new Map();
  const list = () => statements.all.all(agent).map(({ id, name }) => ({ id, name, online: polls.has(id) || calls.has(id) }));
  const targets = () => list().filter(device => device.online).map(({ name }) => name);
  const closeDevice = id => {
    polls.get(id)?.finish(null);
    calls.get(id)?.finish({ status: 'unknown' });
  };
  signal.addEventListener('abort', () => {
    for (const id of new Set([...polls.keys(), ...calls.keys()])) closeDevice(id);
  }, { once: true });

  async function device(req, res, path) {
    if (req.method !== 'POST') throw fail(404);
    if (path === '/v1/runtime/enroll') {
      const body = await readJson(req, 2048);
      if (!exact(body, 'code', 'name', 'key') || typeof body.code !== 'string' || !KEY.test(body.code) ||
          typeof body.name !== 'string' || !RUNTIME_NAME.test(body.name) || typeof body.key !== 'string' || !KEY.test(body.key)) throw fail(400);
      if (enrollment === undefined || now() >= enrollment.expires || sha(body.code) !== enrollment.hash) throw fail(401);
      if (list().length >= MAX_RUNTIMES) throw fail(409);
      const id = randomUUID();
      if (!statements.add.run(id, agent, body.name, sha(body.key)).changes) throw fail(409);
      enrollment = undefined;
      return respond(res, 200, { id, name: body.name });
    }
    if (!['/v1/runtime/poll', '/v1/runtime/result'].includes(path)) throw fail(404);
    const key = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!key || !statements.find.get(agent, sha(key))) throw fail(401);
    const body = await readJson(req, 64 * 1024);
    // Authorization can change while awaiting the request body.
    const row = statements.find.get(agent, sha(key));
    if (!row) throw fail(401);
    if (path === '/v1/runtime/result') {
      if (!exact(body, 'id', 'exitCode', 'output', 'timedOut') || typeof body.id !== 'string' ||
          (body.exitCode !== null && (!Number.isInteger(body.exitCode) || body.exitCode < 0 || body.exitCode > 0xffffffff)) ||
          typeof body.output !== 'string' || body.output.length > 8000 || typeof body.timedOut !== 'boolean') throw fail(400);
      const call = calls.get(row.id);
      if (!call || call.id !== body.id) throw fail(409);
      call.finish({ status: 'completed', exitCode: body.exitCode, output: body.output, timedOut: body.timedOut });
      return respond(res, 200, { ok: true });
    }
    if (!exact(body)) throw fail(400);
    if (polls.has(row.id) || calls.has(row.id)) throw fail(409);
    if (signal.aborted || res.destroyed) throw fail(503);
    const job = await new Promise(resolve => {
      const finish = value => {
        clearTimeout(timer);
        res.off('close', closed);
        polls.delete(row.id);
        resolve(value);
      };
      const closed = () => finish(null);
      const timer = setTimeout(closed, pollMs);
      polls.set(row.id, { finish });
      res.once('close', closed);
    });
    if (!res.destroyed) respond(res, 200, { job });
  }

  async function owner(req, res, path) {
    if (req.method === 'GET' && path === '/api/runtimes') return respond(res, 200, { runtimes: list() });
    if (req.method === 'POST' && path === '/api/runtimes/enroll') {
      if (!exact(await readJson(req, 1024))) throw fail(400);
      if (list().length >= MAX_RUNTIMES) throw fail(409);
      const code = randomBytes(32).toString('base64url');
      const expires = now() + 10 * 60_000;
      enrollment = { hash: sha(code), expires };
      return respond(res, 200, { code, expires });
    }
    const revoke = /^\/api\/runtimes\/([0-9a-f-]{36})\/revoke$/.exec(path);
    if (req.method === 'POST' && revoke) {
      if (!exact(await readJson(req, 1024))) throw fail(400);
      if (!statements.remove.run(agent, revoke[1]).changes) throw fail(404);
      closeDevice(revoke[1]);
      return respond(res, 200, { ok: true });
    }
    throw fail(404);
  }

  async function execute(req, res, caller, ownerAllowed) {
    if (caller !== agent) throw fail(403);
    const body = await readJson(req, 64 * 1024);
    const { turn, target, command, cwd, timeoutMs = 30_000 } = body;
    if (Object.keys(body).some(key => !['turn', 'target', 'command', 'cwd', 'timeoutMs'].includes(key)) ||
        typeof turn !== 'string' || !/^[a-f0-9]{64}$/.test(turn) || typeof target !== 'string' || !RUNTIME_NAME.test(target) ||
        typeof command !== 'string' || !command.trim() || command.length > 8000 || command.includes('\0') ||
        (cwd !== undefined && (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || cwd.includes('\0'))) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT) throw fail(400);
    const job = statements.turn.get(turn);
    if (!job || !['submit', 'wait'].includes(job.state) || job.agent !== agent || !ownerAllowed(job.owner)) throw fail(403);
    const row = list().find(device => device.name === target);
    const poll = row && polls.get(row.id);
    if (!poll || signal.aborted) return respond(res, 200, { status: 'unavailable' });
    const id = randomUUID();
    const result = await new Promise(resolve => {
      const finish = value => {
        clearTimeout(timer);
        res.off('close', lost);
        calls.delete(row.id);
        resolve(value);
      };
      // On loss the companion may have started. Never return this call to any poller.
      // Keep the device busy until its result or deadline even if the worker connection breaks.
      const lost = () => resolve({ status: 'unknown' });
      const timer = setTimeout(() => finish({ status: 'unknown' }), timeoutMs + 2500);
      res.once('close', lost);
      calls.set(row.id, { id, finish });
      poll.finish({ id, command, ...(cwd !== undefined && { cwd }), timeoutMs });
    });
    if (!res.destroyed) respond(res, 200, result);
  }
  return { device, owner, targets, execute };
}
