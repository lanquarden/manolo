import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isRoomChatId, isRoomMemberId, normalizeRoomInstructions } from './telegram-room.mjs';

export const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TG_ID = /^[1-9][0-9]{0,15}$/;
export const SNOWFLAKE = /^[1-9][0-9]{16,19}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const CREDENTIAL = /^[\x21-\x7e]{32,256}$/;
const DEMO_CREDENTIAL = /^[\x21-\x7e]{1,256}$/;
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

/**
 * `demo` relaxes only the 32-character minimum on owner passwords. The relay
 * enables it for loopback-only listeners so a local smoke test can use short
 * credentials without weakening an ordinary deployment.
 */
export function loadRelayConfig(path, env = process.env, { demo = false } = {}) {
  if (!path) throw new Error('Set MANOLO_RELAY_CONFIG to a JSON config file');
  const raw = object(JSON.parse(readFileSync(path, 'utf8')), 'config');
  object(raw, 'config', ['agents', 'owners', 'routes', 'inbox', ...(Object.hasOwn(raw, 'rooms') ? ['rooms'] : [])]);
  const secrets = new Set();
  function credential(name) {
    invariant(typeof name === 'string' && ENV_NAME.test(name), 'Invalid credentials env var name');
    const value = env[name];
    invariant(typeof value === 'string' && (demo ? DEMO_CREDENTIAL : CREDENTIAL).test(value),
      demo ? `Set ${name} to a printable ASCII demo credential` : `Set ${name} to an independent 32–256 character credential`);
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
    const { transport, userId, chatId } = entry;
    if (transport === 'telegram') {
      invariant(typeof userId === 'string' && TG_ID.test(userId) && chatId === userId && Number.isSafeInteger(Number(userId)), 'Configure an exact Telegram private user/chat pair');
    } else if (transport === 'discord') {
      invariant(typeof userId === 'string' && SNOWFLAKE.test(userId) && typeof chatId === 'string' && SNOWFLAKE.test(chatId), 'Configure exact Discord user and DM channel snowflakes as strings');
    } else throw new Error('Unknown transport in route');
    const id = routeKey(entry);
    invariant(!routes.has(id), 'Duplicate transport route');
    routes.set(id, agentId(entry.agent));
  }
  const rooms = new Map();
  const roomEntries = Object.hasOwn(raw, 'rooms') ? raw.rooms : [];
  invariant(Array.isArray(roomEntries), 'Expected rooms array');
  for (const entry of roomEntries) {
    object(entry, 'room');
    object(entry, 'room', ['transport', 'chatId', 'agent', 'wake', 'members',
      ...(Object.hasOwn(entry, 'instructions') ? ['instructions'] : [])]);
    const { transport, chatId, agent, wake, members, instructions = '' } = entry;
    invariant(transport === 'telegram' && isRoomChatId(chatId), 'Configure a negative Telegram room chat ID as a string');
    invariant(!rooms.has(chatId), 'Configure only one agent per Telegram room');
    invariant(wake === 'all' || wake === 'mentions', 'Telegram room wake must be all or mentions');
    invariant(Array.isArray(members) && members.length > 0 && members.every(isRoomMemberId) &&
      new Set(members).size === members.length, 'Configure a nonempty Telegram room member allowlist of unique positive user ID strings');
    rooms.set(chatId, { agent: agentId(agent), wake, members: new Set(members), instructions: normalizeRoomInstructions(instructions) });
  }
  const inbox = new Set();
  for (const entry of raw.inbox) {
    object(entry, 'inbox edge', ['from', 'to']);
    const from = agentId(entry.from);
    const to = agentId(entry.to);
    invariant(from !== to, 'Inbox edges must connect different agents');
    inbox.add(edgeKey(from, to));
  }
  const transports = new Set(raw.routes.map(route => route.transport));
  if (rooms.size) transports.add('telegram');
  return { agents, owners, routes, rooms, inbox, transports };
}
