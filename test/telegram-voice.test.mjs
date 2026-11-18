import assert from 'node:assert/strict';
import { test } from 'node:test';
import { xml } from '@xmpp/client';
import { createSpeechFromEnv, MAX_VOICE_BYTES, readBounded } from '../src/speech.mjs';
import { createTelegramTransport } from '../src/telegram.mjs';
import { createTelegramXmppTransport, serveTelegramOverXmpp } from '../src/telegram-xmpp.mjs';

const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead')]);
const fileId = 'Bot_owned-file-id';
const voice = { file_id: fileId, duration: 60, file_size: MAX_VOICE_BYTES };
const message = { message_id: 42, from: { id: 101 }, chat: { id: 101, type: 'private' }, voice };
const bot = '12345';
const token = `${bot}:fixture`;
const envelope = { transport: 'telegram', userId: '101', chatId: '101', voiceFileId: fileId, messageId: 42 };
const config = { MANOLO_STT_BASE_URL: 'http://stt.invalid/v1', MANOLO_TTS_BASE_URL: 'https://tts.invalid/v1/' };

test('Bot API and OpenAI-compatible speech use fixed URLs, bounded media, and reply to the original voice note', async () => {
  const paths = [];
  const speech = createSpeechFromEnv(config, async (url, opts) => {
    paths.push(url);
    assert.equal(opts.redirect, 'error');
    if (url === 'http://stt.invalid/v1/audio/transcriptions') {
      assert.equal(opts.body.get('model'), 'qwen3-asr-1.7b');
      assert.equal(opts.body.get('file').type, 'audio/ogg');
      assert.deepEqual(Buffer.from(await opts.body.get('file').arrayBuffer()), ogg);
      return Response.json({ text: 'Hello from speech' });
    }
    assert.equal(url, 'https://tts.invalid/v1/audio/speech');
    const { model, voice, input, response_format: format } = JSON.parse(opts.body);
    assert.deepEqual([model, voice, input, format], ['qwen3-tts-1.7b', 'jarvis', 'x'.repeat(999), 'opus']);
    return new Response(ogg);
  });
  const telegram = createTelegramTransport({ token, baseUrl: 'http://127.0.0.1/api', speech, async fetchImpl(url, opts) {
    const path = new URL(url).pathname;
    paths.push(path);
    assert.equal(opts.redirect, 'error');
    let result;
    if (path.endsWith('/getUpdates')) {
      result = [message, { ...message, forward_origin: {} }, { ...message, voice: { ...voice, duration: 61 } },
        { ...message, voice: { ...voice, file_size: MAX_VOICE_BYTES + 1 } }, { ...message, voice: { ...voice, file_id: 'https://evil.invalid/a' } },
        { ...message, chat: { id: 202, type: 'private' } }].map((message, i) => ({ message, update_id: i + 1 }));
    } else if (path.endsWith('/getFile')) {
      assert.deepEqual(JSON.parse(opts.body), { file_id: fileId });
      result = { file_path: 'voice/file_1.oga' };
    } else if (path.endsWith('/voice/file_1.oga')) {
      return new Response(ogg);
    } else {
      assert.equal(path, `/api/bot${token}/sendVoice`);
      assert.equal(opts.body.get('chat_id'), '101');
      assert.deepEqual(JSON.parse(opts.body.get('reply_parameters')), { message_id: 42 });
      assert.equal(opts.body.get('voice').name, 'reply.ogg');
      assert.deepEqual(Buffer.from(await opts.body.get('voice').arrayBuffer()), ogg);
      result = {};
    }
    return Response.json({ ok: true, result });
  } });
  const updates = await telegram.poll();
  assert.deepEqual(updates.map(x => x.envelope), [envelope, null, null, null, null, null]);
  assert.equal(paths.length, 1, 'poll only returns metadata');
  await assert.rejects(telegram.transcribeVoice('https://evil.invalid/a'), { permanent: true });
  assert.equal(await telegram.transcribeVoice(fileId), 'Hello from speech');
  await telegram.sendVoice({ ...envelope, text: `${'x'.repeat(999)}😀 tail` });
  assert.deepEqual(paths, [`/api/bot${token}/getUpdates`, `/api/bot${token}/getFile`, `/api/file/bot${token}/voice/file_1.oga`,
    'http://stt.invalid/v1/audio/transcriptions', 'https://tts.invalid/v1/audio/speech', `/api/bot${token}/sendVoice`]);
});

test('rejects getFile paths that can escape the bot media route and counts chunked body bytes', async () => {
  for (const file_path of ['https://evil.invalid/a', '//evil.invalid/a', '../a', 'voice/%2e%2e/a', 'voice/file.ogg?q=1', 'voice\\file.ogg']) {
    const calls = [];
    const telegram = createTelegramTransport({ token, speech: { transcribe: assert.fail }, fetchImpl(url) {
      calls.push(url);
      return Response.json({ ok: true, result: { file_path } });
    } });
    await assert.rejects(telegram.transcribeVoice(fileId), { permanent: true });
    assert.equal(calls.length, 1);
  }
  let cancelled = false;
  const oversized = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readBounded(oversized, 100), { permanent: true });
  assert.ok(cancelled);
  const speech = createSpeechFromEnv(config, async () => new Response('not an Ogg Opus stream'));
  await assert.rejects(speech.synthesize('hello'), { permanent: true });
  assert.throws(() => createSpeechFromEnv({ ...config, MANOLO_STT_BASE_URL: 'http://user:pass@stt.invalid/v1' }), /fixed HTTP/);
});

const ns = 'urn:manolo:telegram-bridge:0';
const core = 'manolo@localhost/core';
const bridge = 'telegram@localhost/bridge';
const env = (local, peer) => ({ MANOLO_TELEGRAM_BOT_ID: bot, MANOLO_XMPP_JID: local, MANOLO_XMPP_PEER: peer,
  MANOLO_XMPP_PASSWORD: 'offline-fixture', MANOLO_XMPP_SERVICE: 'xmpps://localhost:5223' });
function parseStanza(encoded) {
  const parser = new xml.Parser();
  let parsed;
  parser.on('element', element => { parsed = element; });
  parser.write(`<stream>${encoded}</stream>`);
  assert.ok(parsed);
  return parsed;
}

test('XMPP IQ operations are separately authenticated and carry only bounded metadata/text, never audio', async () => {
  const lifecycle = new AbortController();
  const handlers = new Map();
  const wire = [];
  const called = [];
  const fakeClient = { on() {}, async start() {}, async stop() {}, status: 'online' };
  const mockRequest = (element, from = core, type = 'set') => handlers.get(`${type}/${element.name}`)({ stanza: { attrs: { from } }, element });
  serveTelegramOverXmpp(env(bridge, core), {
    async poll() { return [{ updateId: 1, envelope }]; },
    async transcribeVoice(id) { called.push(['transcribe', id]); return '<voice> & text'; },
    async sendVoice(delivery) { called.push(['send-voice', delivery]); },
    async send(delivery) { called.push(['send', delivery]); },
  }, lifecycle.signal, () => ({ ...fakeClient, iqCallee: {
    get: (_ns, name, fn) => handlers.set(`get/${name}`, fn), set: (_ns, name, fn) => handlers.set(`set/${name}`, fn),
  } }));
  const relay = createTelegramXmppTransport(env(core, bridge), lifecycle.signal, () => ({ ...fakeClient, iqCaller: {
    async request(iq) {
      assert.equal(iq.attrs.to, bridge);
      wire.push(iq.toString());
      const result = await mockRequest(parseStanza(wire.at(-1)).children[0], core, iq.attrs.type);
      return parseStanza(xml('iq', { type: 'result', from: bridge }, result).toString());
    },
  } }));
  const transcribe = xml('transcribe', { xmlns: ns, bot, file: fileId });
  const deliver = xml('send-voice', { xmlns: ns, bot, chat: '101', message: '42' }, '"foo"');
  for (const element of [transcribe, deliver]) {
    assert.equal((await mockRequest(element, 'manolo@localhost/other')).name, 'error');
    assert.equal((await mockRequest(element, 'stranger@localhost/core')).name, 'error');
    assert.equal((await mockRequest(xml(element.name, { ...element.attrs, bot: '99' }))).name, 'error');
  }
  assert.equal((await mockRequest(xml('transcribe', { xmlns: ns, bot, file: 'https://evil.invalid/a' }))).attrs.result, 'permanent');
  assert.equal((await mockRequest(xml('send-voice', { xmlns: ns, bot, chat: '101', message: '42' }, JSON.stringify({ audio: 'fake' })))).attrs.result, 'permanent');
  assert.deepEqual(called, []);
  assert.deepEqual(await relay.poll(0), [{ updateId: 1, envelope }]);
  assert.equal(await relay.transcribeVoice(fileId), '<voice> & text');
  await relay.sendVoice({ chatId: '101', messageId: 42, text: 'x'.repeat(16_000) });
  await relay.send({ chatId: '101', messageId: 42, text: 'fallback' });
  assert.deepEqual(called, [['transcribe', fileId], ['send-voice', { chatId: '101', messageId: 42, text: 'x'.repeat(1000) }],
    ['send', { chatId: '101', messageId: 42, text: 'fallback' }]]);
  assert.ok(wire.every(stanza => stanza.length < 1200));
  lifecycle.abort();
});
