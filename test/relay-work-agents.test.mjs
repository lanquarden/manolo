import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const cwd = new URL('../', import.meta.url);
const secret = () => randomBytes(24).toString('hex');
const addr = port => `http://127.0.0.1:${port}`;
const basic = (user, pw) => ({ authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}` });
const request = (url, path, auth, method = 'GET', body, extra = {}) => fetch(`${url}${path}`, {
  method, redirect: 'manual',
  headers: { ...auth, ...(body && { 'content-type': 'application/json' }), ...extra },
  body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000),
});

async function until(check, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function start(t, filename, env) {
  const child = spawn(process.execPath, [`src/${filename}.mjs`], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return {
    log: () => log,
    async port(re) {
      return until(() => {
        assert.equal(child.exitCode, null, log);
        return Number(re.exec(log)?.[1]) || null;
      }, `listener for ${filename}`);
    },
  };
}

test('a comma-separated work-session list enables each listed agent and nothing else', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-multi-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PRIMARY_TOKEN: secret(), CANARY_TOKEN: secret(), OWNER_PASSWORD: secret(), TESTER_PASSWORD: secret() };
  const worker = start(t, 'worker', {
    MANOLO_AGENT_ID: 'primary', MANOLO_AGENT_TOKEN: env.PRIMARY_TOKEN, MANOLO_DATA_DIR: join(root, 'worker'),
    MANOLO_MODE: 'fixture', MANOLO_FIXTURE_TOOLS: '1', MANOLO_RELAY_URL: 'http://127.0.0.1:1', PORT: '0',
  });
  const workerUrl = addr(await worker.port(/worker listening on (\d+)/));
  const config = join(root, 'relay.json');
  await writeFile(config, JSON.stringify({
    agents: { primary: { url: workerUrl, tokenEnv: 'PRIMARY_TOKEN' }, canary: { url: 'http://127.0.0.1:2', tokenEnv: 'CANARY_TOKEN' } },
    owners: { owner: { agent: 'primary', passwordEnv: 'OWNER_PASSWORD' }, tester: { agent: 'canary', passwordEnv: 'TESTER_PASSWORD' } },
    routes: [], inbox: [],
  }));
  const relay = start(t, 'relay', {
    ...env, MANOLO_RELAY_CONFIG: config, MANOLO_DATA_DIR: join(root, 'relay'),
    MANOLO_WORK_SESSION_AGENT: 'primary,canary', PORT: '0', MANOLO_INTERNAL_PORT: '0',
  });
  const web = addr(await relay.port(/web listening on .*:(\d+)/));
  const owner = basic('owner', env.OWNER_PASSWORD);
  const tester = basic('tester', env.TESTER_PASSWORD);

  // The owner's agent is listed, so the browser gets the Sessions and Inbox question surfaces.
  assert.equal((await request(web, '/api/sessions', owner)).status, 200);
  assert.ok(Array.isArray((await (await request(web, '/api/inbox', owner)).json()).questions));
  assert.equal((await request(web, '/api/sessions', tester)).status, 503, 'a listed agent whose worker is unreachable reports a failure, not 404');
  assert.equal((await request(web, '/api/sessions', {})).status, 401);

  // A turn from a listed agent is admitted with the work-session profile.
  const id = 'owner-turn';
  const text = `fixture-tool:${JSON.stringify({ name: 'inspect_manolo', args: {} })}`;
  assert.equal((await request(web, '/api/turns', owner, 'POST', { id, text }, { 'x-manolo-request': '1' })).status, 200);
  const turn = await until(async () => {
    const payload = await (await request(web, `/api/turns/${id}`, owner)).json();
    return payload.status === 'done' && payload;
  }, 'owner turn completes');
  const inspect = turn.tools?.find(tool => tool.name === 'inspect_manolo');
  assert.equal(inspect?.status, 'ok', JSON.stringify(inspect));
  assert.ok(JSON.parse(inspect.output).capabilities.workSessions, 'the owner agent now has the orchestration tools');
});
