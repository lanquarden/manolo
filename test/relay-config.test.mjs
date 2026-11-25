import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRelayConfig } from '../src/relay-config.mjs';

const agentEnv = { PRIMARY_TOKEN: 'p'.repeat(32), CANARY_TOKEN: 'c'.repeat(32), OWNER_PASSWORD: 'o'.repeat(32) };
const base = {
  agents: {
    primary: { url: 'http://127.0.0.1:1', tokenEnv: 'PRIMARY_TOKEN' },
    canary: { url: 'http://127.0.0.1:2', tokenEnv: 'CANARY_TOKEN' },
  },
  owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' } }, routes: [], inbox: [],
};
const room = { transport: 'telegram', chatId: '-1001', agent: 'primary', wake: 'mentions', members: ['7', '8'] };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'manolo-room-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'relay.json');
  return { dir, path, write: cfg => writeFileSync(path, JSON.stringify(cfg)) };
}

test('room bindings are optional, exact, distinct from routes, and one agent per chat', t => {
  const { path, write } = fixture(t);
  const load = config => { write(config); return loadRelayConfig(path, agentEnv); };
  assert.equal(load(base).rooms.size, 0);
  const parsed = load({ ...base, rooms: [{ ...room, instructions: '  note\r\nnext  ' }] });
  assert.deepEqual([...parsed.transports], ['telegram']);
  assert.deepEqual(parsed.rooms.get('-1001'), { agent: 'primary', wake: 'mentions', members: new Set(['7', '8']), instructions: 'note\nnext' });
  for (const [patch, error] of [
    [{ chatId: '1001' }, /negative Telegram room/],
    [{ chatId: '-9007199254740992' }, /negative Telegram room/],
    [{ agent: 'missing' }, /Unknown agent/],
    [{ wake: 'when-asked' }, /wake must be all or mentions/],
    [{ members: [] }, /member allowlist/],
    [{ members: ['7', '7'] }, /member allowlist/],
    [{ members: [7] }, /member allowlist/],
    [{ instructions: 'x'.repeat(2001) }, /at most 2000/],
    [{ webOwner: 'owner' }, /Invalid fields: room/],
  ]) assert.throws(() => load({ ...base, rooms: [{ ...room, ...patch }] }), error);
  assert.throws(() => load({ ...base, rooms: [room, { ...room, agent: 'canary' }] }), /one agent per Telegram room/);
  assert.throws(() => load({ ...base, routes: [{ transport: 'telegram', userId: '-1001', chatId: '-1001', agent: 'primary' }] }),
    /exact Telegram private user\/chat pair/);
});

test('relay refuses XMPP rooms, missing mention identity, and a runtime-paired room agent', t => {
  const { dir, path, write } = fixture(t);
  write({ ...base, rooms: [room] });
  const relay = fileURLToPath(new URL('../src/relay.mjs', import.meta.url));
  for (const [patch, expected] of [
    [{ MANOLO_TELEGRAM_MODE: 'xmpp' }, /require direct Bot API mode; XMPP is not supported/],
    [{}, /Set MANOLO_TELEGRAM_BOT_USERNAME/],
    [{ MANOLO_TELEGRAM_BOT_USERNAME: 'Room_Bot', MANOLO_RUNTIME_AGENT: 'primary' }, /must be web-only/],
  ]) {
    const proc = spawnSync(process.execPath, [relay], { encoding: 'utf8', timeout: 5000, env: {
      ...agentEnv, MANOLO_RELAY_CONFIG: path, MANOLO_DATA_DIR: dir, PORT: '0', MANOLO_INTERNAL_PORT: '0', ...patch,
    } });
    assert.equal(proc.status, 1, proc.stderr);
    assert.match(proc.stderr, expected);
    assert.doesNotMatch(proc.stdout, /listening/);
  }
});
