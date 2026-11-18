import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TG_ID = /^[1-9][0-9]{0,15}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
export const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const routeKey = ({ transport, userId, chatId }) => JSON.stringify([transport, userId, chatId]);
export const edgeKey = (from, to) => JSON.stringify([from, to]);

function invariant(ok, message) {
  if (!ok) throw new Error(message);
}

function object(value, label, shape) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `Expected object: ${label}`);
  if (shape) invariant(Object.keys(value).length === shape.length && shape.every(k => Object.hasOwn(value, k)), `Invalid fields: ${label}`);
  return value;
}

function identifier(value, label) {
  invariant(typeof value === 'string' && ID.test(value), `Invalid identifier: ${label}`);
  return value;
}

export function loadRelayConfig(path, env = process.env) {
  if (!path) throw new Error('Set MANOLO_RELAY_CONFIG to a JSON config file');
  const raw = object(JSON.parse(readFileSync(path, 'utf8')), 'config', ['agents', 'owners', 'routes', 'inbox']);
  const secrets = new Set();
  function credential(name) {
    invariant(typeof name === 'string' && ENV_NAME.test(name), 'Invalid credentials env var name');
    const value = env[name];
    invariant(typeof value === 'string' && /^[\x21-\x7e]{32,256}$/.test(value), `Set ${name} to an independent 32–256 character credential`);
    invariant(!secrets.has(value), `Reused credential: ${name}`);
    secrets.add(value);
    return value;
  }
  const agents = new Map(Object.entries(object(raw.agents, 'agents')).map(([id, entry]) => {
    identifier(id, 'agent');
    object(entry, 'agent', ['url', 'tokenEnv']);
    const url = typeof entry.url === 'string' ? URL.parse(entry.url) : null;
    invariant(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Agent URL must be an HTTP(S) origin');
    return [id, { url: url.origin, token: credential(entry.tokenEnv) }];
  }));
  invariant(agents.size > 0, 'Configure at least one agent');
  function agentId(id) {
    invariant(agents.has(identifier(id, 'agent reference')), 'Unknown agent reference');
    return id;
  }
  const owners = new Map(Object.entries(object(raw.owners, 'owners')).map(([name, entry]) => {
    identifier(name, 'owner');
    object(entry, 'owner', ['agent', 'passwordEnv']);
    return [name, { agent: agentId(entry.agent), password: credential(entry.passwordEnv) }];
  }));
  invariant(new Set([...owners.values()].map(owner => owner.agent)).size === owners.size, 'One browser owner per agent in the PoC');
  const routes = new Map();
  invariant(Array.isArray(raw.routes) && Array.isArray(raw.inbox), 'Expected routes and inbox arrays');
  for (const entry of raw.routes) {
    object(entry, 'route', ['transport', 'userId', 'chatId', 'agent']);
    invariant(entry.transport === 'telegram' && typeof entry.userId === 'string' && TG_ID.test(entry.userId) && entry.chatId === entry.userId && Number.isSafeInteger(Number(entry.userId)), 'Configure an exact Telegram private user/chat pair');
    const id = routeKey(entry);
    invariant(!routes.has(id), 'Duplicate transport route');
    routes.set(id, agentId(entry.agent));
  }
  const inbox = new Set();
  for (const entry of raw.inbox) {
    object(entry, 'inbox edge', ['from', 'to']);
    const from = agentId(entry.from);
    const to = agentId(entry.to);
    invariant(from !== to, 'Inbox edges must connect different agents');
    inbox.add(edgeKey(from, to));
  }
  return { agents, owners, routes, inbox };
}
