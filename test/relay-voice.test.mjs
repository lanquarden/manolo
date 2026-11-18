import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const audio = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead')]);
const note = (update_id, user, file_id) => ({ update_id, message: { message_id: update_id * 10,
  from: { id: user }, chat: { id: user, type: 'private' }, voice: { file_id, duration: 2 } } });
const sendJson = (res, data) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));

async function until(predicate, label) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(30);
  }
  assert.fail(`Timed out: ${label}`);
}

function launch(t, env, role = 'relay') {
  const child = spawn(process.execPath, [`src/${role}.mjs`], { cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exit = once(child, 'exit');
  const close = async () => { child.kill('SIGKILL'); await exit; };
  t.after(close);
  return { close, get output() { return output; }, assertRunning() { assert.equal(child.exitCode, null, output); } };
}

test('relay authorizes voice before Bot API download; durably retries and replies to the original note after restart', { timeout: 25_000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'manolo-voice-relay-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const workerInputs = [];
  const fileIds = [];
  const speechCalls = [];
  const voiceSends = [];
  const textSends = [];
  const updates = [note(1, 999, 'denied_file'), note(2, 101, 'allowed_file'), note(3, 101, 'unreadable_file'), note(4, 101, 'route_revoked_file')];
  let offerRevoked = false;
  let workerReady = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const json = () => JSON.parse(body);
    const bot = result => sendJson(res, { ok: true, result });
    if (req.url.endsWith('/getUpdates')) return bot(updates.filter(u => u.update_id >= json().offset && (offerRevoked || u.update_id < 4)));
    if (req.url.endsWith('/getFile')) {
      fileIds.push(json().file_id);
      if (json().file_id === 'unreadable_file') return res.writeHead(400).end();
      return bot({ file_path: 'voice/file.oga' });
    }
    if (req.url.endsWith('/voice/file.oga')) return res.end(audio);
    if (req.url === '/v1/audio/transcriptions') {
      speechCalls.push('stt');
      assert.ok(body.includes(audio));
      return sendJson(res, { text: 'authorized voice transcript' });
    }
    if (req.url === '/v1/audio/speech') {
      speechCalls.push(['tts', json().input]);
      return res.end(audio);
    }
    if (req.url.startsWith('/v1/turns/')) {
      workerInputs.push(json());
      if (!workerReady) return res.writeHead(503).end();
      return sendJson(res, { status: 'done', text: 'spoken reply' });
    }
    if (req.url.endsWith('/sendVoice')) {
      voiceSends.push(body);
      if (voiceSends.length === 1) return res.writeHead(503).end();
      return bot({});
    }
    if (req.url.endsWith('/sendMessage')) { textSends.push(json()); return bot({}); }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const configPath = join(storage, 'config.json');
  const speechEnv = { MANOLO_TELEGRAM_TOKEN: '12345:fixture', MANOLO_TELEGRAM_BASE_URL: base,
    MANOLO_STT_BASE_URL: `${base}/v1`, MANOLO_TTS_BASE_URL: `${base}/v1` };
  const env = { PATH: process.env.PATH, PORT: '0', MANOLO_INTERNAL_PORT: '0', MANOLO_DATA_DIR: storage, MANOLO_RELAY_CONFIG: configPath,
    A_TOKEN: 'fixture-worker-token-not-a-credential' };
  if (process.env.TEST_MANOLO_XMPP_SERVICE) {
    const xmpp = { MANOLO_XMPP_SERVICE: process.env.TEST_MANOLO_XMPP_SERVICE,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, MANOLO_TELEGRAM_BOT_ID: '12345' };
    const bridge = launch(t, { ...xmpp, ...speechEnv, MANOLO_XMPP_JID: 'telegram@localhost/bridge',
      MANOLO_XMPP_PEER: 'manolo@localhost/relay', MANOLO_XMPP_PASSWORD: 'fixture-bridge-password' }, 'telegram-bridge');
    await until(() => { bridge.assertRunning(); return bridge.output.includes('Telegram XMPP bridge online'); }, 'bridge authenticated');
    Object.assign(env, xmpp, { MANOLO_TELEGRAM_MODE: 'xmpp', MANOLO_XMPP_JID: 'manolo@localhost/relay',
      MANOLO_XMPP_PEER: 'telegram@localhost/bridge', MANOLO_XMPP_PASSWORD: 'fixture-relay-password' });
  } else Object.assign(env, speechEnv);
  const firstRoute = { transport: 'telegram', userId: '101', chatId: '101', agent: 'a' };
  const configure = routes => writeFile(configPath, JSON.stringify({ agents: { a: { url: base, tokenEnv: 'A_TOKEN' } }, owners: {}, routes, inbox: [] }));
  const active = launchAfter => until(() => { launchAfter.assertRunning(); return workerInputs.length > 0; }, 'worker sees persisted STT input');
  await configure([firstRoute]);
  const first = launch(t, env);
  await active(first);
  await first.close();
  const db = new DatabaseSync(join(storage, 'relay.sqlite'));
  t.after(() => db.close());
  const job = id => db.prepare('SELECT * FROM telegram_jobs WHERE update_id=?').get(id);
  assert.equal(db.prepare('SELECT cursor FROM telegram_state').get().cursor, 4);
  assert.equal(job(1), undefined);
  assert.equal(job(2).input, 'authorized voice transcript');
  assert.equal(job(2).voice_file_id, null);
  assert.equal(job(3).voice_file_id, 'unreadable_file');
  assert.deepEqual(fileIds, ['allowed_file']);

  workerReady = true;
  const second = launch(t, env);
  await until(() => { second.assertRunning(); return job(3)?.state === 'sent'; }, 'durable voice send retry and permanent STT fallback');
  assert.deepEqual(fileIds, ['allowed_file', 'unreadable_file']);
  assert.deepEqual(speechCalls, ['stt', ['tts', 'spoken reply'], ['tts', 'spoken reply']]);
  assert.deepEqual(workerInputs.map(x => x.text), Array(workerInputs.length).fill('authorized voice transcript'));
  assert.equal(voiceSends.length, 2);
  for (const voice of voiceSends) {
    assert.match(voice.toString(), /name="chat_id"\r\n\r\n101/);
    assert.match(voice.toString(), /name="reply_parameters"\r\n\r\n\{"message_id":20\}/);
    assert.ok(voice.includes(audio));
  }
  assert.deepEqual(textSends, [{ chat_id: '101', reply_parameters: { message_id: 30 }, text: 'I could not transcribe this voice note. Please try sending text.' }]);
  assert.equal(job(2).reply_message_id, null);
  assert.equal(job(2).input, '');

  // Simulate a queued voice note that has not reached STT when the operator
  // removes its route; another exact Telegram route keeps the relay enabled.
  db.prepare(`INSERT INTO telegram_jobs (update_id,turn_id,session_id,user_id,chat_id,agent,input,state,voice_file_id,reply_message_id,voice_reply)
    VALUES(4,'old-turn','old-session','101','101','a','','submit','route_revoked_file',40,1)`).run();
  await second.close();
  offerRevoked = true;
  db.exec('UPDATE telegram_state SET cursor=5');
  await configure([{ ...firstRoute, userId: '202', chatId: '202' }]);
  const third = launch(t, env);
  await until(() => { third.assertRunning(); return job(4).state === 'dead'; }, 'revoked route is removed before download');
  assert.deepEqual(fileIds, ['allowed_file', 'unreadable_file']);
  assert.equal(job(4).voice_file_id, null);
});
