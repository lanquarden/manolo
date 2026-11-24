import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { client, xml } from '@xmpp/client';
import { boundedSpeechText, MAX_SPEECH_TEXT, speechError, validTranscript, validVoiceFileId } from './speech.mjs';

const NS = 'urn:manolo:telegram-bridge:0';
const STANZA = 'urn:ietf:params:xml:ns:xmpp-stanzas';
const TIMEOUT = 40_000;
const TYPING_TIMEOUT = 3000;
const BATCH = 4; // Bound the escaped IQ size on standard Prosody listeners.
const MAX_RESPONSE = 150_000;
const ACCOUNT = /^([a-z0-9_.-]+)@([a-z0-9.-]+)\/([a-z0-9_-]+)$/;
const CHAT = /^[1-9][0-9]{0,15}$/;
const validChat = id => typeof id === 'string' && CHAT.test(id) && Number.isSafeInteger(Number(id));
const validOffset = id => Number.isSafeInteger(id) && id >= 0;
const validMessage = id => Number.isSafeInteger(id) && id > 0;
const parseMessage = raw => validMessage(Number(raw)) && String(Number(raw)) === raw ? Number(raw) : undefined;
const json = value => JSON.stringify(value).replace(/\ufffe|\uffff/gu, char => `\\u${char.charCodeAt(0).toString(16)}`);

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

function connect(env, lifecycle, onClient, clientFactory) {
  const { peer, options } = load(env);
  const xmpp = clientFactory(options);
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
    const { transport, userId, chatId, text, voiceFileId, messageId } = envelope;
    const count = Object.keys(envelope).length;
    const isText = count === 4 && typeof text === 'string' && text.length > 0 && text.length <= 4000;
    const isVoice = count === 5 && validVoiceFileId(voiceFileId) && validMessage(messageId);
    if (transport !== 'telegram' || !validChat(userId) || chatId !== userId || !(isText || isVoice)) {
      throw new Error('Invalid Telegram XMPP envelope');
    }
  }
  return batch;
}

function botId(env) {
  const bot = env.MANOLO_TELEGRAM_BOT_ID;
  if (typeof bot !== 'string' || !/^[1-9][0-9]*$/.test(bot)) throw new Error('Configure the Telegram bot ID for XMPP');
  return bot;
}

export function createTelegramXmppTransport(env, lifecycle, clientFactory = client) {
  const bot = botId(env);
  const { xmpp, peer } = connect(env, lifecycle, undefined, clientFactory);
  async function call(name, type, attrs, content, signal, timeout = TIMEOUT) {
    signal?.throwIfAborted();
    if (lifecycle.aborted || xmpp.status !== 'online') throw new Error('Telegram XMPP bridge is not online');
    const result = await xmpp.iqCaller.request(xml('iq', { to: peer, type, id: randomUUID() }, xml(name, { xmlns: NS, bot, ...attrs }, content)), timeout);
    signal?.throwIfAborted();
    if (result.attrs.from !== peer) throw new Error('Unexpected Telegram XMPP reply sender');
    const payload = result.getChild(name, NS);
    if (!payload) throw new Error('Missing Telegram XMPP response');
    if (payload.attrs.result === 'permanent') throw speechError('Telegram bridge rejected the request', true);
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
    async send({ chatId, text, messageId }, signal) {
      await call('send', 'set', { chat: chatId, ...(messageId !== undefined && { message: String(messageId) }) }, json(text), signal);
    },
    async typing({ chatId }, signal) {
      if (!validChat(chatId)) throw new TypeError('Invalid Telegram chat ID');
      // The IQ library starts its reply timer after writing the stanza. Also
      // bound the caller's wait if the write stalls or the turn is cancelled.
      const deadline = AbortSignal.timeout(TYPING_TIMEOUT);
      const pendingSignal = AbortSignal.any(signal == null ? [lifecycle, deadline] : [signal, lifecycle, deadline]);
      pendingSignal.throwIfAborted();
      const { promise: aborted, reject } = Promise.withResolvers();
      const listener = addAbortListener(pendingSignal, () => reject(pendingSignal.reason));
      try {
        const response = await Promise.race([
          call('typing', 'set', { chat: chatId }, undefined, pendingSignal, TYPING_TIMEOUT), aborted,
        ]);
        if (response.children.length) throw new Error('Invalid Telegram XMPP typing response');
      } finally {
        listener[Symbol.dispose]();
      }
    },
    async transcribeVoice(fileId, signal) {
      if (!validVoiceFileId(fileId)) throw speechError('Invalid Telegram voice file ID', true);
      const response = await call('transcribe', 'set', { file: fileId }, undefined, signal);
      const payload = response.getText();
      if (payload.length > 24_002) throw new Error('Oversized transcription');
      const text = JSON.parse(payload);
      if (!validTranscript(text)) throw new Error('Invalid Telegram transcript');
      return text;
    },
    async sendVoice({ chatId, messageId, text }, signal) {
      if (!validChat(chatId) || !validMessage(messageId) || typeof text !== 'string' || !text.trim()) {
        throw speechError('Invalid Telegram voice reply', true);
      }
      await call('send-voice', 'set', { chat: chatId, message: String(messageId) }, json(boundedSpeechText(text)), signal);
    },
  };
}

export function serveTelegramOverXmpp(env, telegram, lifecycle, clientFactory = client) {
  const bot = botId(env);
  const err = () => xml('error', { type: 'auth' }, xml('forbidden', { xmlns: STANZA }));
  let polling = false;
  return connect(env, lifecycle, (xmpp, peer) => {
    function handler(name, operation) {
      return async ({ stanza, element }) => {
        if (stanza.attrs.from !== peer || element.attrs.bot !== bot) return err();
        const response = (result, payload) => xml(name, { xmlns: NS, result }, payload);
        try {
          const data = await operation(element);
          return response('ok', data);
        } catch (error) {
          return response(error?.permanent && name !== 'poll' ? 'permanent' : 'retry');
        }
      };
    }
    xmpp.iqCallee.get(NS, 'poll', handler('poll', async element => {
      const offset = Number(element.attrs.offset);
      if (polling || !validOffset(offset) || String(offset) !== element.attrs.offset) throw new Error('Invalid poll');
      polling = true;
      try {
        return json(validateBatch(await telegram.poll(offset, lifecycle), offset));
      } finally {
        polling = false;
      }
    }));
    xmpp.iqCallee.set(NS, 'send', handler('send', async element => {
      const chatId = element.attrs.chat;
      const messageId = parseMessage(element.attrs.message);
      const payload = element.getText();
      if (payload.length > 100_000) throw new Error('Oversized delivery');
      const text = JSON.parse(payload);
      if (!validChat(chatId) || (element.attrs.message !== undefined && !messageId) ||
          typeof text !== 'string' || !text.length || text.length > 16000) throw new Error('Invalid delivery');
      await telegram.send({ chatId, text, messageId }, lifecycle);
    }));
    xmpp.iqCallee.set(NS, 'typing', handler('typing', async element => {
      const chatId = element.attrs.chat;
      if (!validChat(chatId) || element.children.length) throw speechError('Invalid typing request', true);
      await telegram.typing({ chatId }, lifecycle);
    }));
    // The exact authenticated relay account is the authorization authority. It
    // requests STT only after routing an update, and voice sends from its outbox.
    // Keep the Ogg bytes entirely on this side of XMPP.
    xmpp.iqCallee.set(NS, 'transcribe', handler('transcribe', async element => {
      const fileId = element.attrs.file;
      if (!validVoiceFileId(fileId) || element.children.length) throw speechError('Invalid transcription request', true);
      const text = await telegram.transcribeVoice(fileId, lifecycle);
      if (!validTranscript(text)) throw speechError('Invalid transcription', true);
      return json(text);
    }));
    xmpp.iqCallee.set(NS, 'send-voice', handler('send-voice', async element => {
      const { chat: chatId, message } = element.attrs;
      const messageId = parseMessage(message);
      const payload = element.getText();
      if (!validChat(chatId) || !messageId || payload.length > 6 * MAX_SPEECH_TEXT + 2) {
        throw speechError('Invalid voice delivery', true);
      }
      let text;
      try { text = JSON.parse(payload); } catch { throw speechError('Invalid voice delivery', true); }
      if (typeof text !== 'string' || text.length > MAX_SPEECH_TEXT || !text.trim()) throw speechError('Invalid voice delivery', true);
      await telegram.sendVoice({ chatId, messageId, text }, lifecycle);
    }));
  }, clientFactory);
}

export { BATCH as TELEGRAM_XMPP_BATCH };
