import { MAX_VOICE_BYTES, MAX_VOICE_SECONDS, readBounded, speechError, validVoiceFileId } from './speech.mjs';

const POLL_SECONDS = 25;
const POLL_DEADLINE_MS = 35_000;
const SEND_DEADLINE_MS = 10_000;
const MAX_INPUT_UNITS = 4000;
const MAX_SEND_UNITS = 4096;
const TRUNCATED = '\n\n[truncated]';
const FORWARD_FIELDS = [
  'forward_origin', 'forward_date', 'forward_from', 'forward_from_chat',
  'forward_from_message_id', 'forward_signature', 'forward_sender_name',
];

class TelegramTransportError extends Error {
  constructor(message, permanent = false) {
    super(message);
    this.name = 'TelegramTransportError';
    this.permanent = permanent;
  }
}

function remoteError(code) {
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    return new TelegramTransportError('Telegram rejected the request');
  }
  const permanent = code >= 400 && code < 500 && ![408, 425, 429].includes(code);
  return new TelegramTransportError(`Telegram rejected the request (${code})`, permanent);
}

function endpointPrefix(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('Invalid Telegram base URL');
  }
  const { hostname } = url;
  const loopback = hostname === 'localhost' || hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username || url.password || url.search || url.hash) {
    throw new TypeError('Invalid Telegram base URL');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

const positiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

function toEnvelope(message) {
  const { from, chat, text, voice, message_id: messageId } = message ?? {};
  if (chat?.type !== 'private' || !positiveSafeInteger(chat.id) ||
    !positiveSafeInteger(from?.id) || from.is_bot === true ||
    message.is_automatic_forward === true || FORWARD_FIELDS.some((key) => Object.hasOwn(message, key))) {
    return null;
  }
  const dm = { transport: 'telegram', userId: String(from.id), chatId: String(chat.id) };
  if (typeof text === 'string' && text.length > 0 && text.length <= MAX_INPUT_UNITS) return { ...dm, text };
  if (chat.id === from.id && positiveSafeInteger(messageId) && validVoiceFileId(voice?.file_id) &&
      Number.isInteger(voice.duration) && voice.duration >= 0 && voice.duration <= MAX_VOICE_SECONDS &&
      (voice.file_size === undefined || (positiveSafeInteger(voice.file_size) && voice.file_size <= MAX_VOICE_BYTES))) {
    return { ...dm, voiceFileId: voice.file_id, messageId };
  }
  return null;
}

function boundedText(text) {
  if (text.length <= MAX_SEND_UNITS) return text;
  // Send one truncated message rather than chunks: a caller retry after a
  // partial failure must not resend already acknowledged chunks. Telegram
  // offers no idempotency key, so an ambiguous failure can still duplicate it.
  return text.slice(0, MAX_SEND_UNITS - TRUNCATED.length).replace(/[\uD800-\uDBFF]$/u, '') + TRUNCATED;
}

function telegramChatId(chatId) {
  const id = typeof chatId === 'string' ? Number(chatId) : chatId;
  if (!Number.isSafeInteger(id) || id === 0 || (typeof chatId === 'string' && String(id) !== chatId)) {
    throw new TypeError('Invalid Telegram chat ID');
  }
  return String(id);
}

const replyParameters = messageId => {
  if (!positiveSafeInteger(messageId)) throw new TypeError('Invalid Telegram reply message ID');
  return { message_id: messageId };
};

export function createTelegramTransport({ token, baseUrl = 'https://api.telegram.org', fetchImpl = fetch, limit, speech }) {
  if (typeof token !== 'string' || !token || /[^a-zA-Z0-9:_-]/u.test(token)) {
    throw new TypeError('Invalid Telegram token');
  }
  const base = endpointPrefix(baseUrl);
  const prefix = `${base}/bot${token}`;

  async function request(method, payload, callerSignal, timeoutMs) {
    if (callerSignal != null && !(callerSignal instanceof AbortSignal)) {
      throw new TypeError('Invalid Telegram abort signal');
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    const transportError = (fallback) => new TelegramTransportError(
      callerSignal?.aborted ? 'Telegram request cancelled' :
        deadline.aborted ? 'Telegram request timed out' : fallback,
    );
    let response;
    try {
      signal.throwIfAborted();
      response = await fetchImpl(`${prefix}/${method}`, {
        method: 'POST',
        headers: payload instanceof FormData ? {} : { 'content-type': 'application/json' },
        body: payload instanceof FormData ? payload : JSON.stringify(payload),
        redirect: 'error',
        signal,
      });
      signal.throwIfAborted();
    } catch {
      // Fetch errors (and abort reasons) can contain the token-bearing URL.
      throw transportError('Telegram request failed');
    }
    if (!response.ok) {
      // Do not read or retain remote error bodies.
      void response.body?.cancel().catch(() => {});
      throw remoteError(response.status);
    }
    let data;
    try {
      data = await response.json();
      signal.throwIfAborted();
    } catch {
      // JSON parser errors can quote the response body.
      throw transportError('Invalid Telegram response');
    }
    if (data?.ok === false) throw remoteError(data.error_code);
    if (data?.ok !== true) throw new TelegramTransportError('Invalid Telegram response');
    return data.result;
  }

  async function downloadVoice(fileId, callerSignal) {
    if (!validVoiceFileId(fileId)) throw speechError('Invalid Telegram voice file ID', true);
    const file = await request('getFile', { file_id: fileId }, callerSignal, 5000);
    // The path is server-supplied, but it cannot change host or escape the bot's /file route.
    const path = file?.file_path;
    if (typeof path !== 'string' || path.length > 512 || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/u.test(path) ||
        (file.file_size !== undefined && (!positiveSafeInteger(file.file_size) || file.file_size > MAX_VOICE_BYTES))) {
      throw speechError('Invalid or oversized Telegram voice file', true);
    }
    const deadline = AbortSignal.timeout(8000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    let response;
    try {
      signal.throwIfAborted();
      response = await fetchImpl(`${base}/file/bot${token}/${path}`, { redirect: 'error', signal });
      signal.throwIfAborted();
    } catch { throw new TelegramTransportError('Telegram voice download failed'); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      // Expired file links can be refreshed by repeating getFile.
      if ([403, 404].includes(response.status)) throw new TelegramTransportError('Telegram voice file unavailable');
      throw remoteError(response.status);
    }
    return readBounded(response, MAX_VOICE_BYTES, signal);
  }

  return {
    async poll(offset = 0, signal) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid Telegram offset');
      const updates = await request('getUpdates', {
        offset, timeout: POLL_SECONDS, allowed_updates: ['message'], ...(limit && { limit }),
      }, signal, POLL_DEADLINE_MS);
      if (!Array.isArray(updates)) throw new TelegramTransportError('Invalid Telegram updates');
      const entries = [];
      for (const update of updates) {
        if (!positiveSafeInteger(update?.update_id)) continue;
        // Keep unsupported updates so the caller can advance its cursor.
        entries.push({ updateId: update.update_id, envelope: toEnvelope(update.message) });
      }
      return entries.sort((a, b) => a.updateId - b.updateId);
    },

    async send({ chatId, text, messageId }, signal) {
      if (typeof text !== 'string' || !text) throw new TypeError('Invalid Telegram text');
      await request('sendMessage', { chat_id: telegramChatId(chatId), text: boundedText(text),
        ...(messageId !== undefined && { reply_parameters: replyParameters(messageId) }),
      }, signal, SEND_DEADLINE_MS);
    },

    async transcribeVoice(fileId, signal) {
      if (!speech) throw speechError('Telegram speech is not configured', true);
      return speech.transcribe(await downloadVoice(fileId, signal), signal);
    },

    async sendVoice({ chatId, messageId, text }, signal) {
      if (!speech) throw speechError('Telegram speech is not configured', true);
      const id = telegramChatId(chatId);
      if (id.startsWith('-')) throw new TypeError('Expected a private Telegram chat');
      const reply = replyParameters(messageId);
      const audio = await speech.synthesize(text, signal);
      const form = new FormData();
      form.set('chat_id', id);
      form.set('reply_parameters', JSON.stringify(reply));
      form.set('voice', new Blob([audio], { type: 'audio/ogg' }), 'reply.ogg');
      await request('sendVoice', form, signal, SEND_DEADLINE_MS);
    },
  };
}
