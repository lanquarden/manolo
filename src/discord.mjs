import { once } from 'node:events';
import {
  ChannelType, Client, DefaultRestOptions, Events, GatewayIntentBits, MessageFlags,
  MessageReferenceType, MessageType, Partials, Routes,
} from 'discord.js';

const SNOWFLAKE = /^[1-9][0-9]{16,19}$/u;
const MAX_INPUT_UNITS = 4000;
const MAX_SEND_UNITS = 2000;
const TRUNCATED = '\n\n[truncated]';
const DEFINITIVE_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 422]);

class DiscordTransportError extends Error {
  constructor(message, permanent = false) {
    super(message);
    this.name = 'DiscordTransportError';
    this.permanent = permanent;
  }
}

const isSnowflake = id => typeof id === 'string' && SNOWFLAKE.test(id);
const hasText = value => typeof value === 'string' && !!value.trim();

function checkSignal(signal) {
  if (signal != null && !(signal instanceof AbortSignal)) {
    throw new DiscordTransportError('Invalid Discord abort signal', true);
  }
}

function envelopeFrom(message) {
  const { author, channel, channelId, id, content } = message ?? {};
  if (channel?.type !== ChannelType.DM || channel.id !== channelId || message.guildId != null ||
    ![author?.id, channelId, id].every(isSnowflake) || author.bot || author.system ||
    message.webhookId != null || message.system || message.flags?.has(MessageFlags.Ephemeral) ||
    ![MessageType.Default, MessageType.Reply].includes(message.type) ||
    message.reference?.type === MessageReferenceType.Forward || message.messageSnapshots?.size ||
    !hasText(content) || content.length > MAX_INPUT_UNITS) return;
  return { transport: 'discord', userId: author.id, chatId: channelId, eventId: id, text: content };
}

function boundedText(text) {
  if (text.length <= MAX_SEND_UNITS) return text.toWellFormed();
  // Leave room for the marker, and do not cut through a surrogate pair.
  const prefix = text.slice(0, MAX_SEND_UNITS - TRUNCATED.length).replace(/[\uD800-\uDBFF]$/u, '');
  return prefix.toWellFormed() + TRUNCATED;
}

export function createDiscordTransport({ token, createClient = options => new Client(options) }) {
  const lifetime = new AbortController();
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers();
  const verifiedRecipients = new Map();
  let client, receive, detachAbort, cleanup;
  let ready = false;
  let disconnected = false;

  function stop() {
    if (cleanup) return cleanup;
    ready = false;
    detachAbort?.();
    cleanup = Promise.resolve().then(async () => {
      if (!client) return;
      try {
        client.off(Events.MessageCreate, receive);
        await client.destroy();
      } catch {
        console.error('Discord client cleanup failed');
      }
    }).finally(resolveClosed);
    lifetime.abort();
    return cleanup;
  }

  async function start(onEnvelope, signal) {
    if (client || lifetime.signal.aborted) throw new DiscordTransportError('Discord transport cannot be restarted');
    const deadline = AbortSignal.timeout(30_000);
    const startupSignal = AbortSignal.any([lifetime.signal, deadline]);
    try {
      if (typeof token !== 'string' || token.length > 256 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
        throw new DiscordTransportError('Invalid Discord token', true);
      }
      if (typeof onEnvelope !== 'function') throw new DiscordTransportError('Invalid Discord callback', true);
      checkSignal(signal);
      if (signal?.aborted) throw new DiscordTransportError('Discord startup cancelled');
      client = createClient({
        // DIRECT_MESSAGES provides DM events; Discord exempts app DMs from MESSAGE_CONTENT.
        intents: [GatewayIntentBits.DirectMessages],
        partials: [Partials.Channel],
        rest: {
          rejectOnRateLimit: ['/channels', '/gateway/bot'],
          // Also cancel Discord.js's own initial Gateway discovery request on shutdown.
          makeRequest: (url, options) => DefaultRestOptions.makeRequest(url, {
            ...options, signal: AbortSignal.any([lifetime.signal, options.signal]),
          }),
        },
      });
      const reportIngestFailure = () => console.error('Discord message ingest failed');
      receive = message => {
        if (lifetime.signal.aborted) return;
        try {
          const envelope = envelopeFrom(message);
          if (envelope) Promise.resolve(onEnvelope(envelope)).catch(reportIngestFailure);
        } catch {
          reportIngestFailure();
        }
      };
      const reportGatewayError = () => {
        if (!lifetime.signal.aborted) console.error('Discord gateway error');
      };
      client.on(Events.MessageCreate, receive);
      client.on(Events.Error, reportGatewayError);
      client.on(Events.ShardError, reportGatewayError);
      // Ordinary reconnects and resumes are handled by Discord.js. It only
      // emits ShardDisconnect for a terminal close.
      client.on(Events.ShardDisconnect, () => {
        if (lifetime.signal.aborted) return;
        disconnected = true;
        if (ready) console.error('Discord gateway disconnected permanently');
        void stop();
      });
      if (signal) {
        signal.addEventListener('abort', stop, { once: true });
        detachAbort = () => signal.removeEventListener('abort', stop);
        if (signal.aborted) void stop();
      }
      const initialReady = once(client, Events.ClientReady, { signal: startupSignal });
      await Promise.all([initialReady, Promise.resolve().then(() => {
        startupSignal.throwIfAborted();
        return client.login(token);
      })]);
      startupSignal.throwIfAborted();
      ready = true;
    } catch (error) {
      const message = disconnected ? 'Discord gateway disconnected during startup' :
        lifetime.signal.aborted ? 'Discord startup cancelled' :
          deadline.aborted ? 'Discord startup timed out' : 'Discord startup failed';
      void stop();
      if (error instanceof DiscordTransportError) throw error;
      throw new DiscordTransportError(message, disconnected || error?.code === 'TokenInvalid' || error?.status === 401);
    }
  }

  async function send(delivery, signal) {
    const { chatId, userId, text, eventId } = delivery ?? {};
    if (![chatId, userId, eventId].every(isSnowflake) || !hasText(text)) {
      throw new DiscordTransportError('Invalid Discord delivery', true);
    }
    checkSignal(signal);
    if (!ready) throw new DiscordTransportError('Discord transport is not running');
    const requestSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
    try {
      requestSignal.throwIfAborted();
      if (!verifiedRecipients.has(chatId)) {
        const channel = await client.rest.get(Routes.channel(chatId), { signal: requestSignal });
        const recipients = Array.isArray(channel?.recipients)
          ? channel.recipients.map(recipient => recipient?.id).filter(id => id !== client.user?.id)
          : [];
        if (channel?.type !== ChannelType.DM || channel.id !== chatId ||
          recipients.length !== 1 || recipients[0] !== userId) {
          throw new DiscordTransportError('Discord DM route mismatch', true);
        }
        // DM membership is fixed. A REST lookup also lets persisted jobs send after a restart.
        if (verifiedRecipients.size >= 128) verifiedRecipients.clear();
        verifiedRecipients.set(chatId, userId);
      }
      if (verifiedRecipients.get(chatId) !== userId) {
        throw new DiscordTransportError('Discord DM route mismatch', true);
      }
      requestSignal.throwIfAborted();
      await client.rest.post(Routes.channelMessages(chatId), {
        signal: requestSignal,
        body: { content: boundedText(text), allowed_mentions: { parse: [] }, nonce: eventId, enforce_nonce: true },
      });
      requestSignal.throwIfAborted();
    } catch (error) {
      if (requestSignal.aborted) throw new DiscordTransportError('Discord delivery cancelled or timed out');
      if (error instanceof DiscordTransportError) throw error;
      throw new DiscordTransportError('Discord delivery failed', DEFINITIVE_STATUSES.has(error?.status));
    }
  }

  return { start, send, stop, closed };
}
