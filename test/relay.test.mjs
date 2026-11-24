import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const cwd = new URL('../', import.meta.url);
const secret = () => randomBytes(24).toString('hex');
const addr = port => `http://127.0.0.1:${port}`;
const basic = (user, pw) => ({ authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}` });
const bearer = token => ({ authorization: `Bearer ${token}` });
const request = (url, path, auth, method = 'GET', body, extra = {}) => fetch(`${url}${path}`, {
  method, headers: { ...auth, ...(body && { 'content-type': 'application/json' }), ...extra }, body: body && JSON.stringify(body),
  signal: AbortSignal.timeout(3000),
});

async function until(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}`);
}

// A minimal valid 2x2 24-bit BMP: only the worker's image processor can turn this into a provider-ready PNG.
function bmp2x2() {
  const pixels = Buffer.from([0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0]);
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(2, 18);
  header.writeInt32LE(2, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
}

function start(t, filename, env) {
  const child = spawn(process.execPath, [`src/${filename}.mjs`], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const exited = once(child, 'exit');
  const end = async (signal = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await exited;
  };
  t.after(() => end('SIGKILL'));
  return { end, async online(message) {
    await until(() => {
      assert.equal(child.exitCode, null, log);
      return log.includes(message);
    }, `waiting for ${filename} startup`);
  }, async port(re) {
    return until(() => {
      assert.equal(child.exitCode, null, log);
      return Number(re.exec(log)?.[1]) || null;
    }, `waiting for ${filename} listener`);
  } };
}

const update = (id, user, text, type = 'private') => ({ update_id: id, message: { from: { id: user, is_bot: false }, chat: { id: user, type }, text } });

test('real relay and Pi worker processes: message recovery, private routing, web and inbox boundaries', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-relay-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const updates = [update(21, 101, 'primary-route-unique'), update(22, 999, 'denied-user'), update(23, 202, 'canary-route-unique'), update(24, 101, 'denied-group', 'group')];
  const sent = [];
  const discordSent = [];
  const offsets = [];
  const mock = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    let result;
    if (req.url.endsWith('/getUpdates')) {
      offsets.push(data.offset);
      result = updates.filter(update => update.update_id >= data.offset);
    } else if (req.url.endsWith('/sendChatAction')) {
      result = true;
    } else if (req.url === '/mock-discord-reply') {
      discordSent.push(data);
      result = { message_id: discordSent.length };
    } else {
      sent.push(data);
      result = { message_id: sent.length };
    }
    res.end(JSON.stringify({ ok: true, result }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => mock.close());

  // Replace only the Discord adapter boundary in the child. The real routing, worker and
  // SQLite recovery still run; adapter protocol behavior is covered in discord.test.mjs.
  const loader = join(root, 'load-fixture.mjs');
  await writeFile(loader, `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './discord.mjs' && context.parentURL.endsWith('/src/relay.mjs')) {
        return { url: new URL('./fake-discord.mjs', import.meta.url).href, shortCircuit: true };
      }
      return next(specifier, context);
    }});`);
  const userId = '123456789012345678';
  const chatId = '223456789012345678';
  const discordEvent = (id, text, user = userId) => ({ transport: 'discord', chatId, userId: user, eventId: `62345678901234567${id}`, text });
  const discordEvents = [discordEvent(0, 'denied-discord', chatId), discordEvent(1, 'first-discord-turn'), discordEvent(2, 'fixture:history')];
  await writeFile(join(root, 'fake-discord.mjs'), `export function createDiscordTransport() {
    const { promise: closed, resolve } = Promise.withResolvers();
    return { closed, stop: resolve, async start(onEnvelope, signal) {
      signal.addEventListener('abort', resolve, { once: true });
      const fixtures = ${JSON.stringify(discordEvents)};
      for (const envelope of process.env.DISCORD_TEST_FIRST === '1' ? fixtures : fixtures.slice(0, 2)) onEnvelope(envelope);
      console.log('Discord fixture ready: 1');
    }, async send(data, signal) {
      await fetch(${JSON.stringify(`${addr(mock.address().port)}/mock-discord-reply`)}, {
        method: 'POST', body: JSON.stringify(data), signal,
      });
    } };
  }`);
  const env = { PRIMARY_TOKEN: secret(), CANARY_TOKEN: secret(), OWNER_PASSWORD: secret(), TESTER_PASSWORD: secret() };
  const conf = {
    agents: {
      primary: { url: addr(1), tokenEnv: 'PRIMARY_TOKEN' },
      canary: { url: addr(2), tokenEnv: 'CANARY_TOKEN' },
    },
    owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' }, tester: { agent: 'canary', passwordEnv: 'TESTER_PASSWORD' } },
    routes: [
      { transport: 'telegram', userId: '101', chatId: '101', agent: 'primary' },
      { transport: 'telegram', userId: '202', chatId: '202', agent: 'canary' },
      { transport: 'discord', userId, chatId, agent: 'primary' },
    ],
    inbox: [{ from: 'primary', to: 'canary' }],
  };
  const configPath = join(root, 'relay.json');
  await writeFile(configPath, JSON.stringify(conf));
  const telegramBase = addr(mock.address().port);
  const xmppService = process.env.TEST_MANOLO_XMPP_SERVICE;
  const xmppEnv = {
    MANOLO_XMPP_SERVICE: xmppService, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    MANOLO_TELEGRAM_BOT_ID: '123456',
  };
  if (xmppService) {
    const bridge = start(t, 'telegram-bridge', {
      ...xmppEnv, MANOLO_XMPP_JID: 'telegram@localhost/bridge', MANOLO_XMPP_PEER: 'manolo@localhost/relay',
      MANOLO_XMPP_PASSWORD: 'fixture-bridge-password', MANOLO_TELEGRAM_TOKEN: '123456:fixture-key-not-real',
      MANOLO_TELEGRAM_BASE_URL: telegramBase,
    });
    await bridge.online('Telegram XMPP bridge online');
    const { client, xml } = await import('@xmpp/client');
    const stranger = client({ service: xmppService, domain: 'localhost', username: 'test', password: 'password', resource: 'stranger' });
    stranger.on('error', () => {});
    const online = once(stranger, 'online');
    try {
      await stranger.start();
      await online;
      await assert.rejects(stranger.iqCaller.request(xml('iq', { type: 'set', to: 'telegram@localhost/bridge' },
        xml('send', { xmlns: 'urn:manolo:telegram-bridge:0', bot: '123456', chat: '101' }, '"unauthorized"')), 3000),
      { condition: 'forbidden' });
      assert.deepEqual(sent, []);
    } finally { await stranger.stop(); }
  }
  const launchRelay = (port = 0, firstRun = false) => start(t, 'relay', {
    ...env, MANOLO_RELAY_CONFIG: configPath, MANOLO_DATA_DIR: join(root, 'relay'),
    ...(xmppService ? {
      ...xmppEnv, MANOLO_TELEGRAM_MODE: 'xmpp', MANOLO_XMPP_JID: 'manolo@localhost/relay',
      MANOLO_XMPP_PEER: 'telegram@localhost/bridge', MANOLO_XMPP_PASSWORD: 'fixture-relay-password',
    } : { MANOLO_TELEGRAM_TOKEN: '123456:fixture-key-not-real', MANOLO_TELEGRAM_BASE_URL: telegramBase }),
    MANOLO_DISCORD_TOKEN: `${Buffer.from('999456789012345678').toString('base64url')}.fake.token`,
    NODE_OPTIONS: `--import=${loader}`, DISCORD_TEST_FIRST: firstRun ? '1' : '0',
    PORT: '0', MANOLO_INTERNAL_PORT: String(port),
  });
  const first = launchRelay(0, true);
  await first.port(/web listening on .*:(\d+)/);
  await first.port(/Discord fixture ready: (1)/);
  const relayInternalPort = await first.port(/internal listening on .*:(\d+)/);
  await until(() => offsets.includes(25), 'relay acknowledges four persisted updates before any worker is available');
  assert.deepEqual(sent, []);
  assert.deepEqual(discordSent, []);
  await first.end('SIGKILL');

  for (const [id, token] of [['primary', env.PRIMARY_TOKEN], ['canary', env.CANARY_TOKEN]]) {
    const process = start(t, 'worker', {
      MANOLO_AGENT_ID: id, MANOLO_AGENT_TOKEN: token, MANOLO_DATA_DIR: join(root, id), MANOLO_MODE: 'fixture', PORT: '0',
      MANOLO_FIXTURE_TOOLS: '1', MANOLO_RELAY_URL: addr(relayInternalPort),
    });
    conf.agents[id].url = addr(await process.port(/worker listening on (\d+)/));
  }
  await writeFile(configPath, JSON.stringify(conf));
  const relay = launchRelay(relayInternalPort);
  const web = addr(await relay.port(/web listening on .*:(\d+)/));
  const internal = addr(await relay.port(/internal listening on .*:(\d+)/));
  await until(() => sent.length >= 2, 'both recovered deliveries');
  assert.deepEqual(sent.map(m => m.chat_id).sort(), ['101', '202']);
  assert.match(sent.find(m => m.chat_id === '101').text, /primary-route-unique/);
  assert.match(sent.find(m => m.chat_id === '202').text, /canary-route-unique/);
  await until(() => discordSent.length >= 2, 'both Discord deliveries');
  assert.deepEqual(discordSent.map(m => [m.userId, m.chatId, m.eventId]), discordEvents.slice(1).map(e => [e.userId, e.chatId, e.eventId]));
  assert.equal(discordSent[0].text, 'Fixture: first-discord-turn');
  assert.deepEqual(JSON.parse(discordSent[1].text), ['first-discord-turn'], 'Discord continues its own conversation, not Telegram');
  assert.equal((await request(conf.agents.canary.url, '/v1/turns/x', bearer(env.PRIMARY_TOKEN))).status, 401);
  assert.equal((await request(web, '/', {})).status, 401);
  const owner = basic('owner', env.OWNER_PASSWORD);
  const tester = basic('tester', env.TESTER_PASSWORD);
  const mutation = { 'x-manolo-request': '1' };
  const page = await request(web, '/', owner);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await request(web, '/api/turns', owner, 'POST', { id: 'web-turn', text: 'browser-only' })).status, 403);
  const submitted = await request(web, '/api/turns', owner, 'POST', { id: 'web-turn', text: 'browser-only' }, mutation);
  assert.equal(submitted.status, 200, await submitted.text());
  assert.equal((await request(web, '/api/turns/web-turn', tester)).status, 404);
  const turn = await until(async () => {
    const payload = await (await request(web, '/api/turns/web-turn', owner)).json();
    return payload.status === 'done' && payload;
  }, 'browser completion');
  assert.match(turn.text, /browser-only/);
  const history = async (base, auth) => (await (await request(base, '/api/turns', auth)).json()).turns;
  assert.deepEqual((await history(web, owner)).map(({ id, text, status, reply }) => ({ id, text, status, reply })), [
    { id: 'web-turn', text: 'browser-only', status: 'done', reply: turn.text },
  ]);
  assert.deepEqual(await history(web, tester), []);
  assert.equal((await request(web, '/api/turns', owner, 'POST', { id: 'web-turn', text: 'wrong replay' }, mutation)).status, 409);

  const event = { to: 'canary', text: 'For review only' };
  const idem = { 'idempotency-key': 'sample-1' };
  assert.equal((await request(web, '/v1/inbox', bearer(env.PRIMARY_TOKEN), 'POST', event)).status, 401);
  assert.equal((await request(internal, '/v1/inbox', bearer(env.CANARY_TOKEN), 'POST', { to: 'primary', text: 'Denied reverse edge' })).status, 403);
  assert.equal((await request(internal, '/v1/inbox', bearer(env.PRIMARY_TOKEN), 'POST', { ...event, from: 'tester' })).status, 400);
  const inbox = async body => request(internal, '/v1/inbox', bearer(env.PRIMARY_TOKEN), 'POST', body, idem);
  assert.equal((await inbox(event)).status, 200);
  assert.equal((await inbox(event)).status, 200);
  assert.equal((await inbox({ ...event, text: 'different' })).status, 409);
  const messages = (await (await request(web, '/api/inbox', tester)).json()).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, 'primary');
  assert.equal(messages[0].text, event.text);
  assert.deepEqual(await (await request(web, '/api/inbox', owner)).json(), { messages: [] });

  const spec = { title: 'Test Dashboard', widgets: [{ kind: 'note', text: 'Notes only' }] };
  async function runTool(id, name, args) {
    const text = `fixture-tool:${JSON.stringify({ name, args })}`;
    await request(web, '/api/turns', owner, 'POST', { id, text }, mutation);
    const outcome = await until(async () => {
      const payload = await (await request(web, `/api/turns/${id}`, owner)).json();
      return ['done', 'failed'].includes(payload.status) && payload;
    }, 'worker executes a tool through Pi Durable');
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.text, 'Fixture tool succeeded');
    assert.equal(outcome.tools?.[0]?.name, name);
    assert.equal(outcome.tools[0].status, 'ok');
    return outcome;
  }
  await runTool('inbox-tool', 'send_inbox', { ...event, text: 'Actual worker draft request for review' });
  assert.ok((await (await request(web, '/api/inbox', tester)).json()).messages.some(msg => msg.text === 'Actual worker draft request for review' && msg.from === 'primary'));
  await runTool('draft-tool', 'write_dashboard_draft', spec);
  const withTools = (await history(web, owner)).find(({ id }) => id === 'draft-tool');
  assert.deepEqual(withTools.tools.map(({ name }) => name), ['write_dashboard_draft']);
  const { draft } = await (await request(web, '/api/dashboard', owner)).json();
  assert.deepEqual(draft.spec, spec);
  assert.equal((await (await request(web, '/api/dashboard', tester)).json()).draft, null);
  // A tool that returns an image stores it once, keeps it out of the transcript JSON, and serves it to its owner only.
  await writeFile(join(root, 'primary', 'workspace', 'pixel.bmp'), bmp2x2());
  await runTool('image-tool', 'read', { path: 'pixel.bmp' });
  const imageTurn = await (await request(web, '/api/turns/image-tool', owner)).json();
  assert.deepEqual(imageTurn.tools[0].images, [{ mimeType: 'image/png', index: 0 }]);
  const served = await request(web, '/api/turn-image/image-tool/0', owner);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual([...Buffer.from(await served.arrayBuffer()).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal((await request(web, '/api/turn-image/image-tool/0', tester)).status, 404);
  assert.equal((await request(web, '/api/turn-image/image-tool/0', {})).status, 401);
  assert.equal((await request(web, '/api/turn-image/image-tool/9', owner)).status, 404);
  // Live progress reaches the browser while the tool still runs, and is gone once the turn ends.
  const liveInput = `fixture-tool:${JSON.stringify({ name: 'bash', args: { command: 'printf relay-live-marker; sleep 2' } })}`;
  await request(web, '/api/turns', owner, 'POST', { id: 'live-turn', text: liveInput }, mutation);
  const streaming = await until(async () => {
    const payload = await (await request(web, '/api/turns/live-turn', owner)).json();
    return payload.live?.tools?.[0]?.output?.includes('relay-live-marker') ? payload : null;
  }, 'relay streams live tool output');
  assert.equal(streaming.status, 'pending');
  assert.equal(streaming.live.tools[0].name, 'bash');
  assert.equal(streaming.live.tools[0].status, 'running');
  const completedLive = await until(async () => {
    const payload = await (await request(web, '/api/turns/live-turn', owner)).json();
    return payload.status === 'done' ? payload : null;
  }, 'live turn completes');
  assert.equal(completedLive.live, undefined);
  assert.equal(completedLive.tools[0].status, 'ok');
  const publication = await (await request(web, '/api/dashboard/publish', owner, 'POST', { revision: draft.revision }, mutation)).json();
  assert.deepEqual(publication.current.spec, spec);
  assert.deepEqual(sent.map(m => m.chat_id).sort(), ['101', '202'], 'browser and inbox do not trigger Telegram delivery');

  // Leave a durable browser turn parked behind an unavailable canary, kill the relay before
  // the worker accepts it, then restart. The caller never resubmits POST.
  await relay.end();
  const canaryUrl = conf.agents.canary.url;
  conf.agents.canary.url = addr(2);
  await writeFile(configPath, JSON.stringify(conf));
  const parked = launchRelay(relayInternalPort);
  const parkedWeb = addr(await parked.port(/web listening on .*:(\d+)/));
  const queued = await request(parkedWeb, '/api/turns', tester, 'POST', { id: 'parked', text: 'durable browser request' }, mutation);
  assert.deepEqual(await queued.json(), { status: 'pending', activity: 'queued' });
  assert.deepEqual((await history(parkedWeb, tester)).map(({ id, status }) => [id, status]), [['parked', 'pending']]);
  await parked.end('SIGKILL');
  conf.agents.canary.url = canaryUrl;
  await writeFile(configPath, JSON.stringify(conf));
  const recovered = launchRelay(relayInternalPort);
  const recoveredWeb = addr(await recovered.port(/web listening on .*:(\d+)/));
  const canaryHistory = await until(async () => {
    const h = await history(recoveredWeb, tester);
    return h[0]?.status === 'done' && h;
  }, 'browser turn completes after relay restart');
  assert.match(canaryHistory[0].reply, /durable browser request/);
  const persisted = await history(recoveredWeb, owner);
  assert.equal(persisted.length, 5);
  assert.deepEqual(persisted.find(({ id }) => id === 'draft-tool')?.tools?.map(({ name }) => name), ['write_dashboard_draft']);
  assert.equal((await request(recoveredWeb, '/api/turns/parked', owner)).status, 404);
  assert.equal(discordSent.length, 2, 'replayed gateway events do not send a second reply');
});

test('slow accepted turns show activity without sending a holding message', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-activity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let ready = false;
  const typing = [];
  const replies = [];
  const mock = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = body && JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/v1/turns/')) {
      res.statusCode = ready ? 200 : 202;
      res.end(JSON.stringify(ready ? { status: 'done', text: 'Final answer' } : { status: 'pending' }));
    } else if (req.url.endsWith('/getUpdates')) {
      res.end(JSON.stringify({ ok: true, result: payload.offset === 0
        ? [update(1, 101, 'Allowed'), update(2, 999, 'Denied')]
        : [] }));
    } else if (req.url.endsWith('/sendChatAction')) {
      typing.push(payload);
      res.end(JSON.stringify({ ok: true, result: true }));
    } else if (req.url.endsWith('/sendMessage')) {
      replies.push(payload);
      res.end(JSON.stringify({ ok: true, result: { message_id: 123 } }));
    } else {
      res.writeHead(404).end();
    }
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => mock.close());
  const base = addr(mock.address().port);
  const env = { PRIMARY_TOKEN: secret(), OWNER_PASSWORD: secret() };
  const config = join(root, 'relay.json');
  await writeFile(config, JSON.stringify({
    agents: { primary: { url: base, tokenEnv: 'PRIMARY_TOKEN' } },
    owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' } },
    routes: [{ transport: 'telegram', userId: '101', chatId: '101', agent: 'primary' }], inbox: [],
  }));
  const relay = start(t, 'relay', { ...env, MANOLO_RELAY_CONFIG: config, MANOLO_DATA_DIR: root,
    MANOLO_TELEGRAM_TOKEN: '123456:fixture-key-not-real', MANOLO_TELEGRAM_BASE_URL: base,
    PORT: '0', MANOLO_INTERNAL_PORT: '0' });
  const web = addr(await relay.port(/web listening on .*:(\d+)/));
  const auth = basic('owner', env.OWNER_PASSWORD);
  const submission = await request(web, '/api/turns', auth, 'POST', { id: 'web-activity', text: 'Slow' }, { 'x-manolo-request': '1' });
  assert.deepEqual(await submission.json(), { status: 'pending', activity: 'queued' });
  await until(async () => (await (await request(web, '/api/turns/web-activity', auth)).json()).activity === 'running', 'worker accepted');
  const history = await (await request(web, '/api/turns', auth)).json();
  assert.equal(history.turns[0].activity, 'running');
  await until(() => typing.length > 0, 'typing while work is running');
  assert.deepEqual(typing[0], { chat_id: '101', action: 'typing' });
  assert.deepEqual(replies, []);
  ready = true;
  await until(() => replies.length > 0, 'only the final chat reply');
  assert.deepEqual(replies.map(r => [r.chat_id, r.text]), [['101', 'Final answer']]);
  assert.ok(typing.every(r => r.chat_id === '101'));
  const result = await until(async () => {
    const data = await (await request(web, '/api/turns/web-activity', auth)).json();
    return data.status === 'done' && data;
  }, 'final web reply');
  assert.deepEqual(result, { status: 'done', text: 'Final answer' });
});
