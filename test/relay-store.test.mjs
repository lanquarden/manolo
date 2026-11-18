import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadRelayConfig, routeKey } from '../src/relay-config.mjs';
import { openRelayStore } from '../src/relay-store.mjs';

const userId = '1234567890123456789';
const chatId = '1234567890123456790';
const bot = '1234567890123456791';
const otherBot = '1234567890123456792';
const event = (suffix, extra) => ({
  transport: 'discord', userId, chatId, eventId: `123456789012345${suffix}`, text: `message ${suffix}`, ...extra,
});

const workspace = t => {
  const root = mkdtempSync(join(tmpdir(), 'manolo-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('Discord routes retain full snowflakes and reject imprecise or unknown input', t => {
  const path = join(workspace(t), 'config.json');
  const route = { transport: 'discord', userId, chatId, agent: 'canary' };
  const check = routes => {
    writeFileSync(path, JSON.stringify({
      agents: { canary: { url: 'http://127.0.0.1:12345', tokenEnv: 'TEST_TOKEN' } }, owners: {}, inbox: [], routes,
    }));
    return loadRelayConfig(path, { TEST_TOKEN: 'fixture-token-'.padEnd(32, 'q') });
  };
  const config = check([route, { transport: 'telegram', userId: '123', chatId: '123', agent: 'canary' }]);
  assert.deepEqual([...config.transports], ['discord', 'telegram']);
  assert.equal(config.routes.get(routeKey(route)), 'canary');
  assert.throws(() => check([{ ...route, userId: Number(userId) }]), /snowflakes as strings/);
  assert.throws(() => check([{ ...route, transport: 'xmpp' }]), /Unknown transport/);
  assert.throws(() => check([route, route]), /Duplicate transport route/);
});

test('Discord admission deduplicates events, persists pending sends, and keeps bot and routes separate', t => {
  const path = join(workspace(t), 'store.sqlite');
  const routes = new Map([[routeKey(event('0001')), 'primary']]);
  let store = openRelayStore(path);
  assert.equal(store.ingestDiscord(event('0000', { chatId: bot }), routes, bot), false);
  assert.equal(store.ingestDiscord(event('0000', { userId: bot }), routes, bot), false);
  assert.equal(store.ingestDiscord(event('0000', { text: '   ' }), routes, bot), false);
  assert.equal(store.ingestDiscord(event('0001'), routes, bot), true);
  assert.equal(store.ingestDiscord(event('0001'), routes, bot), false);
  assert.equal(store.ingestDiscord(event('0002'), routes, bot), true);
  assert.equal(store.ingestDiscord(event('0001'), routes, otherBot), true);
  const [first] = store.discordReady(Date.now(), bot);
  assert.equal(store.discordReady(Date.now(), bot).length, 1, 'later messages wait for the earlier one');
  assert.notEqual(first.session_id, store.discordReady(Date.now(), otherBot)[0].session_id);
  assert.equal(first.event_id, event('0001').eventId);
  assert.equal(first.chat_id, chatId);
  store.advance('discord', first, 'send', 'right reply');
  store.db.close();

  store = openRelayStore(path);
  try {
    const [pending] = store.discordReady(Date.now(), bot);
    assert.equal(pending.state, 'send');
    assert.equal(pending.output, 'right reply');
    assert.equal(pending.turn_id, first.turn_id);
    store.advance('discord', pending, 'sent');
    assert.equal(store.discordReady(Date.now(), bot)[0].event_id, event('0002').eventId);
    assert.equal(store.ingestDiscord(event('0001'), routes, bot), false);
    assert.equal(store.db.prepare('SELECT input FROM discord_jobs WHERE seq=?').get(first.seq).input, '');
  } finally { store.db.close(); }
});

test('browser recent history is ordered and bounded without forgetting earlier turn IDs', t => {
  const store = openRelayStore(join(workspace(t), 'store.sqlite'));
  try {
    for (let i = 1; i <= 35; i++) store.webSubmit('owner', 'primary', `t${i}`, `prompt ${i}`);
    assert.throws(() => store.webSubmit('owner', 'primary', 't1', 'not the same prompt'), { statusCode: 409 });
    assert.deepEqual(store.webTurn('owner', 'primary', 't1'), { status: 'pending' });
    assert.deepEqual(store.webHistory('owner', 'primary').map(t => t.id), Array.from({ length: 30 }, (_, i) => `t${i + 6}`));
    assert.deepEqual(store.webHistory('other', 'primary'), []);
    assert.deepEqual(store.webHistory('owner', 'canary'), []);
  } finally { store.db.close(); }
});
