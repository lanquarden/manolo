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
  return { end, async port(re) {
    return until(() => {
      assert.equal(child.exitCode, null, log);
      return Number(re.exec(log)?.[1]) || null;
    }, `waiting for ${filename} listener`);
  } };
}

const update = (id, user, text, type = 'private') => ({ update_id: id, message: { from: { id: user, is_bot: false }, chat: { id: user, type }, text } });

test('real relay and Pi worker processes: Telegram recovery, private routing, web and inbox boundaries', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-relay-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const updates = [update(21, 101, 'primary-route-unique'), update(22, 999, 'denied-user'), update(23, 202, 'canary-route-unique'), update(24, 101, 'denied-group', 'group')];
  const sent = [];
  const offsets = [];
  const mock = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    let result;
    if (req.url.endsWith('/getUpdates')) {
      offsets.push(data.offset);
      result = updates.filter(update => update.update_id >= data.offset);
    } else {
      sent.push(data);
      result = { message_id: sent.length };
    }
    res.end(JSON.stringify({ ok: true, result }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => mock.close());

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
    ],
    inbox: [{ from: 'primary', to: 'canary' }],
  };
  const configPath = join(root, 'relay.json');
  await writeFile(configPath, JSON.stringify(conf));
  const launchRelay = (port = 0) => start(t, 'relay', {
    ...env, MANOLO_RELAY_CONFIG: configPath, MANOLO_DATA_DIR: join(root, 'relay'),
    MANOLO_TELEGRAM_TOKEN: '123456:fixture-key-not-real', MANOLO_TELEGRAM_BASE_URL: addr(mock.address().port),
    PORT: '0', MANOLO_INTERNAL_PORT: String(port),
  });
  const first = launchRelay();
  await first.port(/web listening on .*:(\d+)/);
  const relayInternalPort = await first.port(/internal listening on .*:(\d+)/);
  await until(() => offsets.includes(25), 'relay acknowledges four persisted updates before any worker is available');
  assert.deepEqual(sent, []);
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
    assert.deepEqual(outcome, { status: 'done', text: 'Fixture tool succeeded' });
  }
  await runTool('inbox-tool', 'send_inbox', { ...event, text: 'Actual worker draft request for review' });
  assert.ok((await (await request(web, '/api/inbox', tester)).json()).messages.some(msg => msg.text === 'Actual worker draft request for review' && msg.from === 'primary'));
  await runTool('draft-tool', 'write_dashboard_draft', spec);
  const { draft } = await (await request(web, '/api/dashboard', owner)).json();
  assert.deepEqual(draft.spec, spec);
  assert.equal((await (await request(web, '/api/dashboard', tester)).json()).draft, null);
  const publication = await (await request(web, '/api/dashboard/publish', owner, 'POST', { revision: draft.revision }, mutation)).json();
  assert.deepEqual(publication.current.spec, spec);
  assert.deepEqual(sent.map(m => m.chat_id).sort(), ['101', '202'], 'browser and inbox do not trigger Telegram delivery');
});
