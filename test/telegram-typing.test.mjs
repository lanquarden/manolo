import assert from 'node:assert/strict';
import { test } from 'node:test';
import { xml } from '@xmpp/client';
import { createTelegramTransport } from '../src/telegram.mjs';
import { createTelegramXmppTransport, serveTelegramOverXmpp } from '../src/telegram-xmpp.mjs';

const ns = 'urn:manolo:telegram-bridge:0';
const core = 'manolo@localhost/core';
const bridge = 'telegram@localhost/bridge';
const bot = '12345';
const token = `${bot}:fixture`;
const baseUrl = 'http://127.0.0.1:1234/api';
const expectedCall = { url: `${baseUrl}/bot${token}/sendChatAction`, method: 'POST', redirect: 'error',
  body: { chat_id: '101', action: 'typing' } };
const env = (local, peer) => ({ MANOLO_TELEGRAM_BOT_ID: bot, MANOLO_XMPP_JID: local, MANOLO_XMPP_PEER: peer,
  MANOLO_XMPP_PASSWORD: 'offline-fixture', MANOLO_XMPP_SERVICE: 'xmpps://localhost:5223' });
const fakeClient = { on() {}, async start() {}, async stop() {}, status: 'online' };

function telegramFixture(reply = () => Response.json({ ok: true, result: true })) {
  const calls = [];
  const transport = createTelegramTransport({ token, baseUrl, fetchImpl(url, { method, redirect, body, signal }) {
    calls.push({ url, method, redirect, body: JSON.parse(body) });
    return reply(signal);
  } });
  return { transport, calls };
}

function parseStanza(stanza) {
  const parser = new xml.Parser();
  let parsed;
  parser.on('element', element => { parsed = element; });
  parser.write(`<stream>${stanza.toString()}</stream>`);
  assert.ok(parsed);
  return parsed;
}

function relayFixture(t, request, lifecycle = new AbortController()) {
  t.after(() => lifecycle.abort());
  return createTelegramXmppTransport(env(core, bridge), lifecycle.signal,
    () => ({ ...fakeClient, iqCaller: { request } }));
}

test('direct typing posts only sendChatAction for a valid private chat and surfaces Telegram rejection', async () => {
  const { transport, calls } = telegramFixture();
  await transport.typing({ chatId: '101' });
  for (const chatId of ['-101', '0101', '9007199254740992', '0', '1e2']) {
    await assert.rejects(transport.typing({ chatId }), /Telegram chat/);
  }
  assert.deepEqual(calls, [expectedCall]);
  const rejected = telegramFixture(() => Response.json({ ok: false, error_code: 429 }));
  await assert.rejects(rejected.transport.typing({ chatId: '101' }), /Telegram rejected the request \(429\)/);
  assert.deepEqual(rejected.calls, [expectedCall], 'there is no retry or message fallback');
  const malformed = telegramFixture(() => Response.json({ ok: true, result: false }));
  await assert.rejects(malformed.transport.typing({ chatId: '101' }), /Invalid Telegram typing response/);
});

test('direct typing has a short deadline and propagates caller cancellation', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const abort = new AbortController();
    deadlines.push({ milliseconds, abort });
    return abort.signal;
  });
  const { transport, calls } = telegramFixture(signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = transport.typing({ chatId: '101' });
  assert.ok(deadlines[0].milliseconds > 0 && deadlines[0].milliseconds <= 3000);
  deadlines[0].abort.abort();
  await assert.rejects(pending, /Telegram request timed out/);
  const abort = new AbortController();
  const cancelled = transport.typing({ chatId: '101' }, abort.signal);
  abort.abort(new Error(token));
  await assert.rejects(cancelled, { message: 'Telegram request cancelled' });
  await assert.rejects(transport.typing({ chatId: '101' }, abort.signal), { message: 'Telegram request cancelled' });
  assert.deepEqual(calls, [expectedCall, expectedCall]);
});

test('XMPP typing makes a bodyless authenticated set IQ and the bridge only calls sendChatAction', async t => {
  const lifecycle = new AbortController();
  const { transport, calls } = telegramFixture();
  const handlers = new Map();
  let requests = 0;
  const bridgeEnv = env(bridge, core);
  assert.throws(() => serveTelegramOverXmpp({ ...bridgeEnv, MANOLO_TELEGRAM_BOT_ID: undefined }, transport,
    lifecycle.signal, assert.fail), /Configure the Telegram bot ID/);
  serveTelegramOverXmpp(bridgeEnv, transport, lifecycle.signal, () => ({ ...fakeClient, iqCallee: {
    get() {}, set: (namespace, name, handler) => handlers.set(`${namespace}/${name}`, handler),
  } }));
  const invoke = (element, from = core) => handlers.get(`${ns}/typing`)({ stanza: { attrs: { from } }, element });
  const relay = relayFixture(t, async (stanza, timeout) => {
    requests++;
    const iq = parseStanza(stanza);
    assert.equal(iq.attrs.to, bridge);
    assert.equal(iq.attrs.type, 'set');
    assert.ok(timeout > 0 && timeout <= 3000);
    assert.equal(iq.children.length, 1);
    const element = iq.getChild('typing', ns);
    assert.deepEqual(element.attrs, { xmlns: ns, bot, chat: '101' });
    assert.deepEqual(element.children, []);
    return parseStanza(xml('iq', { type: 'result', from: bridge }, await invoke(element)));
  }, lifecycle);

  const indicator = (attrs = {}, body) => xml('typing', { xmlns: ns, bot, chat: '101', ...attrs }, body);
  for (const from of ['manolo@localhost', 'manolo@localhost/other', 'stranger@localhost/core']) {
    assert.equal((await invoke(indicator(), from)).name, 'error');
  }
  for (const wrongBot of ['99999', undefined]) {
    assert.equal((await invoke(indicator({ bot: wrongBot }))).name, 'error');
  }
  for (const invalid of [indicator({ chat: undefined }), indicator({ chat: '-101' }), indicator({ chat: '0101' }),
    indicator({ chat: '9007199254740992' }), indicator({}, 'text'), indicator({}, xml('text')), indicator({}, ' ')]) {
    assert.equal((await invoke(invalid)).attrs.result, 'permanent');
  }
  for (const chatId of ['-101', '0101', '9007199254740992', 101]) {
    await assert.rejects(relay.typing({ chatId }), /Telegram chat/);
  }
  assert.equal(requests, 0);
  assert.deepEqual(calls, []);

  await relay.typing({ chatId: '101' });
  assert.equal(requests, 1);
  assert.deepEqual(calls, [expectedCall]);
});

test('XMPP typing surfaces unsupported bridges and rejects replies from the wrong resource', async t => {
  let requests = 0;
  const unsupported = Object.assign(new Error('service-unavailable'), { condition: 'service-unavailable' });
  const oldRelay = relayFixture(t, async () => { requests++; throw unsupported; });
  await assert.rejects(oldRelay.typing({ chatId: '101' }), { condition: 'service-unavailable' });
  assert.equal(requests, 1, 'there is no fallback request');
  const unexpected = relayFixture(t, async () =>
    xml('iq', { type: 'result', from: 'telegram@localhost/other' }, xml('typing', { xmlns: ns, result: 'ok' })));
  await assert.rejects(unexpected.typing({ chatId: '101' }), /Unexpected Telegram XMPP reply sender/);
  const rejected = relayFixture(t, async () =>
    xml('iq', { type: 'result', from: bridge }, xml('typing', { xmlns: ns, result: 'retry' })));
  await assert.rejects(rejected.typing({ chatId: '101' }), /Telegram bridge request failed/);
  const malformed = relayFixture(t, async () =>
    xml('iq', { type: 'result', from: bridge }, xml('typing', { xmlns: ns, result: 'ok' }, 'text')));
  await assert.rejects(malformed.typing({ chatId: '101' }), /Invalid Telegram XMPP typing response/);
});

test('XMPP typing bounds a stalled IQ and permits in-flight cancellation without waiting on the transport', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const abort = new AbortController();
    deadlines.push({ milliseconds, abort });
    return abort.signal;
  });
  let requests = 0;
  const relay = relayFixture(t, () => { requests++; return new Promise(() => {}); });
  const pending = relay.typing({ chatId: '101' });
  assert.ok(deadlines[0].milliseconds > 0 && deadlines[0].milliseconds <= 3000);
  deadlines[0].abort.abort(new DOMException('Deadline expired', 'TimeoutError'));
  await assert.rejects(pending, { name: 'TimeoutError' });
  const abort = new AbortController();
  const cancelled = relay.typing({ chatId: '101' }, abort.signal);
  abort.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await assert.rejects(relay.typing({ chatId: '101' }, abort.signal), { name: 'AbortError' });
  assert.equal(requests, 2);
});
