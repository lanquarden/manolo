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

function endpointPrefix(baseUrl, token) {
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
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}/bot${token}`;
}

const positiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

function toEnvelope(message) {
  const { from, chat, text } = message ?? {};
  if (chat?.type !== 'private' || !positiveSafeInteger(chat.id) ||
    !positiveSafeInteger(from?.id) || from.is_bot === true ||
    typeof text !== 'string' || text.length === 0 || text.length > MAX_INPUT_UNITS ||
    message.is_automatic_forward === true || FORWARD_FIELDS.some((key) => Object.hasOwn(message, key))) {
    return null;
  }
  return { transport: 'telegram', userId: String(from.id), chatId: String(chat.id), text };
}

function boundedText(text) {
  if (text.length <= MAX_SEND_UNITS) return text;
  // Send one truncated message rather than chunks: a caller retry after a
  // partial failure must not resend already acknowledged chunks. Telegram
  // offers no idempotency key, so an ambiguous failure can still duplicate it.
  return text.slice(0, MAX_SEND_UNITS - TRUNCATED.length).replace(/[\uD800-\uDBFF]$/u, '') + TRUNCATED;
}

export function createTelegramTransport({ token, baseUrl = 'https://api.telegram.org', fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token || /[^a-zA-Z0-9:_-]/u.test(token)) {
    throw new TypeError('Invalid Telegram token');
  }
  const prefix = endpointPrefix(baseUrl, token);

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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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

  return {
    async poll(offset = 0, signal) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid Telegram offset');
      const updates = await request('getUpdates', {
        offset, timeout: POLL_SECONDS, allowed_updates: ['message'],
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

    async send({ chatId, text }, signal) {
      const id = typeof chatId === 'string' ? Number(chatId) : chatId;
      if (!Number.isSafeInteger(id) || id === 0 || (typeof chatId === 'string' && String(id) !== chatId)) {
        throw new TypeError('Invalid Telegram chat ID');
      }
      if (typeof text !== 'string' || !text) throw new TypeError('Invalid Telegram text');
      await request('sendMessage', { chat_id: String(id), text: boundedText(text) }, signal, SEND_DEADLINE_MS);
    },
  };
}
