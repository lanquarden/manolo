import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';

const cwd = new URL('../', import.meta.url);
const exec = promisify(execFile);
const secret = () => randomBytes(24).toString('hex');
const addr = port => `http://127.0.0.1:${port}`;
const basic = (user, pw) => ({ authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}` });
const mutation = { 'x-manolo-request': '1' };
const fixtureTool = (name, args) => `fixture-tool:${JSON.stringify({ name, args })}`;
const request = (url, path, auth, method = 'GET', body, extra = {}) => fetch(`${url}${path}`, {
  method, headers: { ...auth, ...(body && { 'content-type': 'application/json' }), ...extra },
  body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000),
});

async function until(check, label) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function start(t, filename, env) {
  const child = spawn(process.execPath, [`src/${filename}.mjs`], {
    cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const closed = once(child, 'exit');
  return {
    log: () => log,
    async port(re) {
      return until(() => {
        assert.equal(child.exitCode, null, log);
        return Number(re.exec(log)?.[1]) || null;
      }, `listener for ${filename}`);
    },
    async end(signal = 'SIGKILL') {
      child.kill(signal);
      await closed;
    },
  };
}

async function seedRemote(root) {
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await exec('git', ['init', '-b', 'main'], { cwd: source });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: source });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: source });
  await writeFile(join(source, 'README.md'), 'base\n');
  await exec('git', ['add', 'README.md'], { cwd: source });
  await exec('git', ['commit', '-m', 'base'], { cwd: source });
  const remote = join(root, 'remote.git');
  await exec('git', ['clone', '--bare', source, remote]);
  return remote;
}

test('Blueprint snapshots pin profiles and tools; model/reasoning reach the request; bare finals get one corrective turn', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-blueprint-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = await seedRemote(root);
  const bundles = join(root, 'bundles');
  await mkdir(bundles, { recursive: true });
  await writeFile(join(bundles, 'IDENTITY.md'), 'You are a Task agent for this repository.\n');
  await writeFile(join(bundles, 'AGENTS.md'), 'Keep commits small.\n');
  await writeFile(join(bundles, 'manifest.json'), JSON.stringify({
    version: 1,
    profiles: {
      deep: { description: 'Deep reasoning', model: 'fixture-deep', thinkingLevel: 'high' },
      fast: { description: 'Fast reasoning', model: 'fixture-fast', thinkingLevel: 'low' },
    },
    repositories: { sample: { remote, base: 'main', handoff: remote } },
    blueprints: {
      general: { description: 'Generic Task', role: 'task', profile: 'deep', files: ['IDENTITY.md'], tools: ['finish', 'post_inbox', 'report_progress'] },
      repo: { description: 'Repository Task', role: 'task', profile: 'deep', repository: 'sample',
        files: ['IDENTITY.md', 'AGENTS.md'], tools: ['bash', 'read', 'write', 'edit', 'finish', 'post_inbox', 'report_progress'] },
    },
  }));

  const token = secret();
  const password = secret();
  const workerData = join(root, 'worker');
  const relayData = join(root, 'relay');
  const configPath = join(root, 'relay.json');
  // The worker starts before the relay is configured, so it reaches the relay's internal listener through a stable
  // local forwarder whose target is filled in once the relay is up.
  let internal = 'http://127.0.0.1:1';
  const proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const response = await fetch(internal + req.url, {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers)
          .filter(([name]) => ['authorization', 'content-type', 'idempotency-key'].includes(name))),
        body: Buffer.concat(chunks),
      });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(await response.text());
    } catch {
      res.writeHead(503).end();
    }
  }).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  const worker = start(t, 'worker', {
    MANOLO_AGENT_ID: 'canary', MANOLO_AGENT_TOKEN: token, MANOLO_DATA_DIR: workerData,
    MANOLO_MODE: 'fixture', MANOLO_CODING_TOOLS: '1', MANOLO_FIXTURE_TOOLS: '1', PORT: '0',
    MANOLO_BLUEPRINTS_DIR: bundles, MANOLO_RELAY_URL: addr(proxy.address().port),
  });
  const workerUrl = addr(await worker.port(/worker listening on (\d+)/));
  await writeFile(configPath, JSON.stringify({
    agents: { canary: { url: workerUrl, tokenEnv: 'CANARY_TOKEN' } },
    owners: { owner: { agent: 'canary', passwordEnv: 'OWNER_PASSWORD' } }, routes: [], inbox: [],
  }));
  const relay = start(t, 'relay', {
    CANARY_TOKEN: token, OWNER_PASSWORD: password, MANOLO_RELAY_CONFIG: configPath,
    MANOLO_DATA_DIR: relayData, MANOLO_WORK_SESSION_AGENT: 'canary', PORT: '0', MANOLO_INTERNAL_PORT: '0',
  });
  const web = addr(await relay.port(/web listening on .*:(\d+)/));
  internal = addr(await relay.port(/internal listening on .*:(\d+)/));
  const auth = basic('owner', password);
  const tasksOf = async () => {
    const response = await request(web, '/api/tasks', auth);
    assert.equal(response.status, 200, await response.clone().text());
    const payload = await response.json();
    return [...payload.active, ...payload.history];
  };
  const createTask = async (id, args) => {
    const response = await request(web, '/api/turns', auth, 'POST', { id, text: fixtureTool('create_task', args) }, mutation);
    assert.equal(response.status, 200, await response.clone().text());
  };
  const settled = async (title, status = 'done') => until(async () => {
    const row = (await tasksOf()).find(entry => entry.title === title);
    return row?.status === status && row;
  }, `${title} ${status}`);

  // The profile is applied to the actual model request, not just recorded as metadata.
  await createTask('profile-one', { title: 'Profile probe', task: 'fixture:finish', blueprint: 'general' });
  const profiled = await settled('Profile probe');
  assert.equal(profiled.outcome, 'selected:fixture-deep:high');
  assert.equal(profiled.blueprint.id, 'general');

  // A profile can be pinned without a Blueprint.
  await createTask('profile-two', { title: 'Profile only', task: 'fixture:finish', profile: 'fast' });
  const fast = await settled('Profile only');
  assert.equal(fast.outcome, 'selected:fixture-fast:low');
  assert.deepEqual(fast.profile, { id: 'fast', model: 'fixture-fast', thinkingLevel: 'low' });

  // One bare final turn is corrected in the same Task and session.
  await createTask('bare-one', { title: 'Bare then finish', task: 'fixture:bare', blueprint: 'general' });
  const corrected = await settled('Bare then finish');
  assert.equal(corrected.outcome, 'corrective finish');

  // A second bare final fails the Task instead of restarting it.
  await createTask('bare-two', { title: 'Bare forever', task: 'fixture:bare-forever', blueprint: 'general' });
  const failed = await settled('Bare forever', 'failed');
  assert.match(failed.failure, /without calling its finish tool after one corrective turn/);

  // A repository Task runs in its own worktree and hands off a verified branch before finish is accepted.
  const command = [
    'git config user.email test@example.invalid',
    'git config user.name Test',
    'echo work > work.txt',
    'git add work.txt',
    'git commit -m task-work',
    `git push handoff HEAD:refs/heads/$(git rev-parse --abbrev-ref HEAD)`,
  ].join(' && ');
  await createTask('repo-one', { title: 'Repo task', task: fixtureTool('bash', { command }), blueprint: 'repo' });
  const repoTask = await settled('Repo task');
  assert.equal(repoTask.status, 'done');
  const head = (await exec('git', ['--git-dir', remote, 'rev-parse', `refs/heads/task/${repoTask.id}`])).stdout.trim();
  assert.match(head, /^[0-9a-f]{40,64}$/);
  const files = (await exec('git', ['--git-dir', remote, 'ls-tree', '--name-only', `task/${repoTask.id}`])).stdout;
  assert.match(files, /work\.txt/);
  // Terminal cleanup removed the clean worktree but kept the branch and a tombstone.
  const meta = JSON.parse(await readFile(join(workerData, 'task-worktrees', `${repoTask.id}.json`), 'utf8'));
  assert.equal(meta.kind, 'cleaned');

  await relay.end();
  await worker.end();
  assert.doesNotMatch(worker.log(), /Task request failed|Unhandled|AssertionError/);
});
