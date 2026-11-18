import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import {
  ChannelType, Client, Events, GatewayIntentBits, MessageFlags, MessageReferenceType, MessageType, Partials, Routes,
} from 'discord.js';
import { createDiscordTransport } from '../src/discord.mjs';

const TOKEN = 'mock.token.fixture';
const USER = '1550000000000000001';
const OTHER_USER = '1550000000000000002';
const BOT = '1550000000000000003';
const CHAT = '1550000000000000004';
const EVENT = '1550000000000000005';
const channel = { type: ChannelType.DM, id: CHAT };
const remoteChannel = { ...channel, recipients: [{ id: USER }] };
const message = { id: EVENT, channelId: CHAT, channel, content: '  hello  ', author: { id: USER }, type: MessageType.Default };
const envelope = { transport: 'discord', userId: USER, chatId: CHAT, eventId: EVENT, text: message.content };
const delivery = { chatId: CHAT, userId: USER, eventId: EVENT, text: '<@1550000000000000001> @everyone' };

function fixture(t) {
  const client = new EventEmitter();
  client.user = { id: BOT };
  client.login = t.mock.fn(async () => client.emit(Events.ClientReady, client));
  client.destroy = t.mock.fn(async () => {});
  client.rest = { get: t.mock.fn(async () => remoteChannel), post: t.mock.fn(async () => {}) };
  const createClient = t.mock.fn(() => client);
  const transport = createDiscordTransport({ token: TOKEN, createClient });
  t.after(() => transport.stop());
  return { client, createClient, transport };
}

const isPermanent = error => error.permanent === true;
const isTransient = error => error.permanent === false;

function callArgs(mock) {
  return mock.mock.calls.map(call => call.arguments);
}

function deferred() {
  return Promise.withResolvers();
}

test('validates the token and respects a pre-aborted startup before creating a client', async t => {
  const createClient = t.mock.fn();
  for (const token of [undefined, '', 'invalid token not echoed', 'mock.token.fixture\n', 'Bot mock.token.fixture']) {
    const transport = createDiscordTransport({ token, createClient });
    await assert.rejects(transport.start(() => {}), { message: 'Invalid Discord token', permanent: true });
    await transport.closed;
  }
  const transport = createDiscordTransport({ token: TOKEN, createClient });
  await assert.rejects(transport.start(() => {}, AbortSignal.abort('private reason')), { message: 'Discord startup cancelled' });
  await transport.closed;
  assert.equal(createClient.mock.callCount(), 0);
});

test('registers messageCreate before login and resolves start only after login and initial ready', async t => {
  const { client, createClient, transport } = fixture(t);
  const login = deferred();
  client.login.mock.mockImplementation(() => {
    assert.equal(client.listenerCount(Events.MessageCreate), 1);
    return login.promise;
  });
  const onEnvelope = t.mock.fn();
  const start = transport.start(onEnvelope);
  let resolved = false;
  void start.then(() => { resolved = true; }, () => {});
  await setImmediate();
  assert.equal(resolved, false);
  await assert.rejects(transport.send(delivery), isTransient);
  assert.deepEqual(callArgs(client.login), [[TOKEN]]);
  const [options] = callArgs(createClient)[0];
  assert.deepEqual(options.intents, [GatewayIntentBits.DirectMessages]);
  assert.deepEqual(options.partials, [Partials.Channel]);
  client.emit(Events.ClientReady, client);
  await setImmediate();
  assert.equal(resolved, false);
  login.resolve(TOKEN);
  await start;
  client.emit(Events.MessageCreate, message);
  assert.deepEqual(callArgs(onEnvelope), [[envelope]]);
  await assert.rejects(transport.start(onEnvelope), /cannot be restarted/);
});

test('emits only plain one-to-one DM envelopes, keeping Discord IDs lossless', async t => {
  const { client, transport } = fixture(t);
  const onEnvelope = t.mock.fn();
  await transport.start(onEnvelope);
  const rejected = [
    { channel: undefined }, { channel: { ...channel, type: ChannelType.GroupDM } },
    { channel: { ...channel, type: ChannelType.GuildText } }, { guildId: CHAT },
    { channelId: OTHER_USER }, { channelId: Number(CHAT) }, { id: Number(EVENT) },
    { author: { id: Number(USER) } }, { author: { id: USER, bot: true } },
    { author: { id: USER, system: true } }, { author: null }, { webhookId: OTHER_USER },
    { system: true }, { type: MessageType.Call }, { flags: { has: flag => flag === MessageFlags.Ephemeral } },
    { reference: { type: MessageReferenceType.Forward } }, { messageSnapshots: new Map([[EVENT, {}]]) },
    { content: '' }, { content: ' \n\t' }, { content: null }, { content: 'a'.repeat(4001) },
  ];
  for (const overrides of rejected) client.emit(Events.MessageCreate, { ...message, ...overrides });
  assert.equal(onEnvelope.mock.callCount(), 0);
  client.emit(Events.MessageUpdate, message);
  client.emit(Events.MessageCreate, message);
  const reply = { ...message, type: MessageType.Reply, reference: { type: MessageReferenceType.Default }, content: 'a'.repeat(4000) };
  client.emit(Events.MessageCreate, reply);
  assert.deepEqual(callArgs(onEnvelope), [[envelope], [{ ...envelope, text: reply.content }]]);
});

test('ingest and gateway errors are contained and logs never contain raw error detail', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const { client, transport } = fixture(t);
  const onEnvelope = t.mock.fn(() => { throw new Error('private ingest data'); });
  await transport.start(onEnvelope);
  client.emit(Events.MessageCreate, message);
  onEnvelope.mock.mockImplementationOnce(async () => { throw new Error('private async error'); });
  client.emit(Events.MessageCreate, message);
  client.emit(Events.Error, new Error(TOKEN));
  client.emit(Events.ShardError, new Error('private shard info'), 0);
  await setImmediate();
  assert.deepEqual(callArgs(log), [
    ['Discord message ingest failed'], ['Discord gateway error'], ['Discord gateway error'], ['Discord message ingest failed'],
  ]);
  assert.equal(client.rest.post.mock.callCount(), 0);
});

test('lets Discord.js reconnect and resume, and cleans up once on lifecycle abort', async t => {
  const { client, transport } = fixture(t);
  const controller = new AbortController();
  const onEnvelope = t.mock.fn();
  await transport.start(onEnvelope, controller.signal);
  let closed = false;
  void transport.closed.then(() => { closed = true; });
  client.emit(Events.ShardReconnecting, 0);
  client.emit(Events.ShardResume, 0, 2);
  client.emit(Events.ClientReady, client);
  client.emit(Events.MessageCreate, message);
  assert.deepEqual(callArgs(onEnvelope), [[envelope]]);
  assert.equal(client.login.mock.callCount(), 1);
  assert.equal(client.destroy.mock.callCount(), 0);
  await setImmediate();
  assert.equal(closed, false);
  controller.abort('private stop reason');
  client.emit(Events.MessageCreate, message);
  await Promise.all([transport.closed, transport.stop(), transport.stop()]);
  assert.equal(closed, true);
  assert.equal(client.destroy.mock.callCount(), 1);
  assert.equal(client.listenerCount(Events.MessageCreate), 0);
  assert.equal(onEnvelope.mock.callCount(), 1);
  await assert.rejects(transport.send(delivery), isTransient);
});

test('startup rejection is sanitized and cancellation settles even if login never resolves', async t => {
  const rejection = fixture(t);
  rejection.client.login.mock.mockImplementation(async () => {
    throw Object.assign(new Error(TOKEN), { status: 401 });
  });
  await assert.rejects(rejection.transport.start(() => {}), { message: 'Discord startup failed', permanent: true });
  await rejection.transport.closed;
  assert.equal(rejection.client.destroy.mock.callCount(), 1);
  assert.equal(rejection.client.listenerCount(Events.ClientReady), 0);

  const cancelled = fixture(t);
  const controller = new AbortController();
  const login = deferred();
  cancelled.client.login.mock.mockImplementation(() => login.promise);
  const start = cancelled.transport.start(() => {}, controller.signal);
  await setImmediate();
  controller.abort(new Error('private abort reason'));
  await assert.rejects(start, { message: 'Discord startup cancelled', permanent: false });
  login.reject(new Error('private late login error'));
  await cancelled.transport.closed;
  assert.equal(cancelled.client.destroy.mock.callCount(), 1);
  assert.equal(cancelled.client.listenerCount(Events.ClientReady), 0);
});

test('terminal Gateway close stops the transport without a manual reconnect', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const { client, transport } = fixture(t);
  const onEnvelope = t.mock.fn();
  await transport.start(onEnvelope);
  const destroy = deferred();
  client.destroy.mock.mockImplementation(() => destroy.promise);
  let closed = false;
  void transport.closed.then(() => { closed = true; });
  client.emit(Events.ShardDisconnect, { code: 4004, reason: TOKEN }, 0);
  client.emit(Events.MessageCreate, message);
  await setImmediate();
  assert.equal(closed, false);
  destroy.resolve();
  await transport.closed;
  assert.equal(closed, true);
  assert.equal(onEnvelope.mock.callCount(), 0);
  assert.equal(client.login.mock.callCount(), 1);
  assert.equal(client.destroy.mock.callCount(), 1);
  assert.deepEqual(callArgs(log), [['Discord gateway disconnected permanently']]);
});

test('verifies a DM route once and posts one mention-disabled message per send with the stable nonce', async t => {
  const { client, transport } = fixture(t);
  await transport.start(() => {});
  await transport.send(delivery);
  await transport.send(delivery);
  assert.deepEqual(callArgs(client.rest.get).map(([route]) => route), [Routes.channel(CHAT)]);
  const expected = [Routes.channelMessages(CHAT), {
    content: delivery.text, allowed_mentions: { parse: [] }, nonce: EVENT, enforce_nonce: true,
  }];
  assert.deepEqual(callArgs(client.rest.post).map(([route, { body }]) => [route, body]), [expected, expected]);
  await assert.rejects(transport.send({ ...delivery, userId: OTHER_USER }), isPermanent);
  assert.equal(client.rest.get.mock.callCount(), 1);
  assert.equal(client.rest.post.mock.callCount(), 2);
});

test('rejects unverified destinations and malformed jobs before any message POST', async t => {
  const { client, transport } = fixture(t);
  await transport.start(() => {});
  const invalidDestinations = [
    null, { ...remoteChannel, type: ChannelType.GuildText }, { ...remoteChannel, type: ChannelType.GroupDM },
    { ...remoteChannel, id: OTHER_USER }, { ...remoteChannel, recipients: [{ id: OTHER_USER }] },
    { ...remoteChannel, recipients: [{ id: USER }, { id: OTHER_USER }] }, { ...remoteChannel, recipients: [{ id: BOT }] },
  ];
  for (const target of invalidDestinations) {
    client.rest.get.mock.mockImplementationOnce(async () => target);
    await assert.rejects(transport.send(delivery), { message: 'Discord DM route mismatch', permanent: true });
  }
  for (const overrides of [{ chatId: '../users/@me' }, { userId: Number(USER) }, { eventId: '1'.repeat(26) }, { text: ' ' }]) {
    await assert.rejects(transport.send({ ...delivery, ...overrides }), { message: 'Invalid Discord delivery', permanent: true });
  }
  await assert.rejects(transport.send(null), isPermanent);
  assert.equal(client.rest.get.mock.callCount(), invalidDestinations.length);
  assert.equal(client.rest.post.mock.callCount(), 0);
});

test('limits each reply to one well-formed payload, including the truncation marker', async t => {
  const { client, transport } = fixture(t);
  await transport.start(() => {});
  const marker = '\n\n[truncated]';
  const limit = 2000 - marker.length;
  const prefix = 'x'.repeat(limit - 1);
  await transport.send({ ...delivery, text: 'x'.repeat(2000) });
  await transport.send({ ...delivery, text: 'x'.repeat(2001) });
  await transport.send({ ...delivery, text: prefix + '🙂'.repeat(20) });
  await transport.send({ ...delivery, text: '\uD800x\uDC00' });
  assert.deepEqual(callArgs(client.rest.post).map(([, { body }]) => body.content), [
    'x'.repeat(2000), 'x'.repeat(limit) + marker, prefix + marker, '\uFFFDx\uFFFD',
  ]);
});

test('distinguishes definitive REST failures from rate limits, other transient failures, and cancellation', async t => {
  const { client, transport } = fixture(t);
  await transport.start(() => {});
  client.rest.get.mock.mockImplementationOnce(async () => { throw Object.assign(new Error(TOKEN), { status: 404 }); });
  await assert.rejects(transport.send(delivery), { message: 'Discord delivery failed', permanent: true });
  assert.equal(client.rest.post.mock.callCount(), 0);
  for (const [status, permanent] of [[403, true], [429, false], [408, false], [503, false], [undefined, false]]) {
    client.rest.post.mock.mockImplementationOnce(async () => { throw Object.assign(new Error(TOKEN), { status }); });
    await assert.rejects(transport.send(delivery), { message: 'Discord delivery failed', permanent });
  }

  const controller = new AbortController();
  const postStarted = deferred();
  client.rest.post.mock.mockImplementationOnce(async (_route, { signal }) => {
    postStarted.resolve();
    await once(signal, 'abort');
    signal.throwIfAborted();
  });
  const send = transport.send(delivery, controller.signal);
  await postStarted.promise;
  controller.abort(TOKEN);
  await assert.rejects(send, { message: 'Discord delivery cancelled or timed out', permanent: false });
  await assert.rejects(transport.send(delivery, controller.signal), isTransient);
  assert.equal(client.rest.post.mock.callCount(), 6);
});

test('pinned Discord.js handles an uncached DM and serializes replies with offline REST', async t => {
  const request = t.mock.fn(async (url, options) => {
    if (options.method === 'GET' && new URL(url).pathname.endsWith(Routes.channel(CHAT))) return Response.json(remoteChannel);
    if (options.method === 'POST' && new URL(url).pathname.endsWith(Routes.channelMessages(CHAT))) return Response.json({ id: EVENT });
    assert.fail('unexpected request');
  });
  let client;
  const transport = createDiscordTransport({ token: TOKEN, createClient: options => {
    client = new Client({ ...options, rest: { ...options.rest, makeRequest: request } });
    client.login = async () => {
      client.user = { id: BOT };
      client.rest.setToken(TOKEN);
      client.emit(Events.ClientReady, client);
    };
    return client;
  } });
  t.after(() => transport.stop());
  const onEnvelope = t.mock.fn();
  await transport.start(onEnvelope);
  const packet = {
    id: EVENT, channel_id: CHAT, channel_type: ChannelType.DM, content: message.content, type: MessageType.Default,
    author: { id: USER, username: 'mock-user', discriminator: '0', avatar: null }, mentions: [], mention_roles: [],
    pinned: false, tts: false, mention_everyone: false, attachments: [], embeds: [],
  };
  assert.equal(client.channels.cache.size, 0);
  client.actions.MessageCreate.handle(packet);
  assert.deepEqual(callArgs(onEnvelope), [[envelope]]);
  await transport.send(delivery);
  assert.deepEqual(JSON.parse(callArgs(request)[1][1].body), {
    content: delivery.text, allowed_mentions: { parse: [] }, nonce: EVENT, enforce_nonce: true,
  });
  assert.equal(request.mock.callCount(), 2);
});
