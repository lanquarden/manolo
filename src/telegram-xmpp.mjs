import { randomUUID } from 'node:crypto';
import { client, xml } from '@xmpp/client';

const NS = 'urn:manolo:telegram-bridge:0';
const STANZA = 'urn:ietf:params:xml:ns:xmpp-stanzas';
const TIMEOUT = 40_000;
const BATCH = 4; // Bound the escaped IQ size on standard Prosody listeners.
const MAX_RESPONSE = 150_000;
const ACCOUNT = /^([a-z0-9_.-]+)@([a-z0-9.-]+)\/([a-z0-9_-]+)$/;
const CHAT = /^[1-9][0-9]{0,15}$/;
const validChat = id => typeof id === 'string' && CHAT.test(id) && Number.isSafeInteger(Number(id));
const validOffset = id => Number.isSafeInteger(id) && id >= 0;

function load(env) {
  const local = ACCOUNT.exec(env.MANOLO_XMPP_JID ?? '');
  const peer = env.MANOLO_XMPP_PEER;
  const remote = ACCOUNT.exec(peer ?? '');
  const service = URL.parse(env.MANOLO_XMPP_SERVICE ?? '');
  const password = env.MANOLO_XMPP_PASSWORD;
  if (!local || !remote || local[0].split('/')[0] === peer.split('/')[0] || local[2] !== remote[2] ||
    !password || !service || service.protocol !== 'xmpps:' || !service.hostname || service.username || service.password ||
    !['', '/'].includes(service.pathname) || service.search || service.hash) {
    throw new Error('Configure TLS XMPP service, distinct same-domain account JIDs with resources, and password');
  }
  return { peer, options: { service: service.href, domain: local[2], username: local[1], resource: local[3], password } };
}

function connect(env, lifecycle, onClient) {
  const { peer, options } = load(env);
  const xmpp = client(options);
  xmpp.on('error', () => { if (!lifecycle.aborted) console.error('Telegram XMPP connection or stanza failed'); });
  onClient?.(xmpp, peer);
  lifecycle.addEventListener('abort', () => void xmpp.stop().catch(() => {}), { once: true });
  if (!lifecycle.aborted) void xmpp.start().catch(() => {});
  return { xmpp, peer };
}

function validateBatch(batch, offset) {
  if (!Array.isArray(batch) || batch.length > BATCH) throw new Error('Invalid Telegram XMPP batch');
  let next = offset;
  for (const { updateId, envelope } of batch) {
    if (!validOffset(updateId) || updateId < next || updateId >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid Telegram XMPP update');
    next = updateId + 1;
    if (envelope === null) continue;
    const { transport, userId, chatId, text } = envelope;
    if (transport !== 'telegram' || !validChat(userId) || chatId !== userId || typeof text !== 'string' || !text.length || text.length > 4000) {
      throw new Error('Invalid Telegram XMPP envelope');
    }
  }
  return batch;
}

export function createTelegramXmppTransport(env, lifecycle) {
  const bot = env.MANOLO_TELEGRAM_BOT_ID;
  if (!/^[1-9][0-9]*$/.test(bot ?? '')) throw new Error('Configure the Telegram bot ID for XMPP');
  const { xmpp, peer } = connect(env, lifecycle);
  async function call(name, type, attrs, content, signal) {
    signal?.throwIfAborted();
    if (lifecycle.aborted || xmpp.status !== 'online') throw new Error('Telegram XMPP bridge is not online');
    const result = await xmpp.iqCaller.request(xml('iq', { to: peer, type, id: randomUUID() }, xml(name, { xmlns: NS, bot, ...attrs }, content)), TIMEOUT);
    signal?.throwIfAborted();
    if (result.attrs.from !== peer) throw new Error('Unexpected Telegram XMPP reply sender');
    const payload = result.getChild(name, NS);
    if (!payload) throw new Error('Missing Telegram XMPP response');
    if (payload.attrs.result === 'permanent') throw Object.assign(new Error('Telegram rejected the delivery'), { permanent: true });
    if (payload.attrs.result !== 'ok') throw new Error('Telegram bridge request failed');
    return payload;
  }
  return {
    async poll(offset, signal) {
      const payload = await call('poll', 'get', { offset: String(offset) }, undefined, signal);
      const data = payload.getText();
      if (data.length > MAX_RESPONSE) throw new Error('Telegram XMPP batch too large');
      return validateBatch(JSON.parse(data), offset);
    },
    async send({ chatId, text }, signal) {
      await call('send', 'set', { chat: chatId }, JSON.stringify(text), signal);
    },
  };
}

export function serveTelegramOverXmpp(env, telegram, lifecycle) {
  const err = () => xml('error', { type: 'auth' }, xml('forbidden', { xmlns: STANZA }));
  let polling = false;
  return connect(env, lifecycle, (xmpp, peer) => {
    function handler(name, operation) {
      return async ({ stanza, element }) => {
        if (stanza.attrs.from !== peer || element.attrs.bot !== env.MANOLO_TELEGRAM_BOT_ID) return err();
        const response = (result, payload) => xml(name, { xmlns: NS, result }, payload);
        try {
          const data = await operation(element);
          return response('ok', data);
        } catch (error) {
          return response(error?.permanent && name === 'send' ? 'permanent' : 'retry');
        }
      };
    }
    xmpp.iqCallee.get(NS, 'poll', handler('poll', async element => {
      const offset = Number(element.attrs.offset);
      if (polling || !validOffset(offset) || String(offset) !== element.attrs.offset) throw new Error('Invalid poll');
      polling = true;
      try {
        return JSON.stringify(validateBatch(await telegram.poll(offset, lifecycle), offset));
      } finally {
        polling = false;
      }
    }));
    xmpp.iqCallee.set(NS, 'send', handler('send', async element => {
      const chatId = element.attrs.chat;
      const payload = element.getText();
      if (payload.length > 100_000) throw new Error('Oversized delivery');
      const text = JSON.parse(payload);
      if (!validChat(chatId) || typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Invalid delivery');
      await telegram.send({ chatId, text }, lifecycle);
    }));
  });
}

export { BATCH as TELEGRAM_XMPP_BATCH };
