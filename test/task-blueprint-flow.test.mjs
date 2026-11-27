import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

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
    `git push ${remote} HEAD:refs/heads/$(git rev-parse --abbrev-ref HEAD)`,
  ].join(' && ');
  await createTask('repo-one', { title: 'Repo task', task: fixtureTool('bash', { command }), blueprint: 'repo' });
  const repoTask = await settled('Repo task');
  assert.equal(repoTask.status, 'done');
  const head = (await exec('git', ['--git-dir', remote, 'rev-parse', `refs/heads/task/${repoTask.id}`])).stdout.trim();
  assert.match(head, /^[0-9a-f]{40,64}$/);
  const files = (await exec('git', ['--git-dir', remote, 'ls-tree', '--name-only', `task/${repoTask.id}`])).stdout;
  assert.match(files, /work\.txt/);
  // Terminal cleanup removed the clean worktree but kept the branch and a tombstone.
  const meta = await until(async () => {
    const value = JSON.parse(await readFile(join(workerData, 'task-worktrees', `${repoTask.id}.json`), 'utf8'));
    return value.kind === 'cleaned' && value;
  }, 'repository worktree cleanup');
  assert.equal(repoTask.handoff.commit, head);
  assert.equal(repoTask.handoff.branch, `task/${repoTask.id}`);
  assert.match(repoTask.handoff.handoff, /remote\.git$/);

  // A review Task binds the exact handed-off commit and base, in its own worktree, and exposes that evidence.
  await createTask('review-one', { title: 'Review task', task: 'fixture:finish', blueprint: 'repo', reviewOf: repoTask.id });
  const reviewTask = await settled('Review task');
  assert.equal(reviewTask.review.commit, head);
  assert.equal(reviewTask.review.baseSha, repoTask.handoff.base);
  assert.equal(reviewTask.review.sourceTaskId, repoTask.id);
  assert.equal(reviewTask.handoff.commit, head);
  assert.equal(reviewTask.handoff.base, repoTask.handoff.base);
  const reviewMeta = await until(async () => {
    const value = JSON.parse(await readFile(join(workerData, 'task-worktrees', `${reviewTask.id}.json`), 'utf8'));
    return value.kind === 'cleaned' && value;
  }, 'review worktree cleanup');
  assert.equal(reviewMeta.previousHead, head);

  // A configured bundle is not an ungoverned delegate_work child.
  assert.equal((await request(web, '/api/turns', auth, 'POST', {
    id: 'delegate-new-bundle', text: fixtureTool('delegate_work', { title: 'Ungoverned', task: 'Do it.', blueprint: 'general' }),
  }, mutation)).status, 200);
  const delegated = await until(async () => {
    const row = await (await request(web, '/api/turns/delegate-new-bundle', auth)).json();
    return row.status === 'done' && row;
  }, 'delegate_work turn');
  assert.equal(delegated.text, 'Fixture tool failed');
  assert.equal(delegated.tools.find(tool => tool.name === 'delegate_work')?.status, 'error');

  // A lost worktree blocks on resume rather than terminal-failing or recreating a workspace.
  await createTask('repo-wait', {
    title: 'Worktree loss', task: fixtureTool('post_inbox', { kind: 'question', prompt: 'Continue?' }), blueprint: 'repo',
  });
  const waiting = await until(async () => {
    const row = (await tasksOf()).find(entry => entry.title === 'Worktree loss');
    return row?.status === 'waiting' && row;
  }, 'repository Task waits in Inbox');
  const inbox = await (await request(web, '/api/inbox', auth)).json();
  const item = inbox.taskItems.find(entry => entry.taskId === waiting.id);
  await rm(join(workerData, 'task-worktrees', waiting.id), { recursive: true, force: true });
  const responded = await request(web, `/api/tasks/${waiting.id}/inbox/${item.id}/respond`, auth, 'POST', { answer: 'yes' }, mutation);
  assert.equal(responded.status, 200, await responded.clone().text());
  const blocked = await until(async () => {
    const row = (await tasksOf()).find(entry => entry.id === waiting.id);
    return row?.blocked && row;
  }, 'lost worktree blocks recoverably');
  assert.equal(blocked.status, 'running');
  assert.match(blocked.blocked, /worktree|workspace/i);

  // An active repository workspace that disappears mid-run blocks recoverably: the execution is not failed and its one
  // corrective turn is not spent. Restoring the exact recorded path continues the same Task and execution.
  await createTask('repo-active-loss', {
    title: 'Active worktree loss', task: fixtureTool('bash', { command: 'mv "$PWD" "$PWD.lost"' }), blueprint: 'repo',
  });
  const active = await until(async () => {
    const row = (await tasksOf()).find(entry => entry.title === 'Active worktree loss');
    return row?.blocked && row;
  }, 'active worktree loss blocks recoverably');
  assert.equal(active.status, 'running');
  assert.match(active.blocked, /worktree|workspace/i);
  const activePath = join(workerData, 'task-worktrees', active.id);
  await rename(`${activePath}.lost`, activePath);
  const relayDb = new DatabaseSync(join(relayData, 'relay.sqlite'));
  relayDb.prepare('UPDATE tasks SET next_at=0 WHERE id=?').run(active.id);
  relayDb.close();
  const continued = await until(async () => {
    const row = (await tasksOf()).find(entry => entry.id === active.id);
    return row?.status === 'done' && row;
  }, 'restored workspace continues the same Task');
  assert.equal(continued.id, active.id);
  assert.equal(continued.failure, undefined);
  assert.equal(continued.blocked, undefined, 'the healthy continuation clears the block');
  assert.equal(continued.outcome, 'corrective finish', 'the block did not consume the corrective turn');

  // A required pull request fails closed without structured evidence and succeeds with a URL bound to the exact commit.  // A required pull request fails closed without structured evidence and succeeds with a URL bound to the exact commit.
  await createTask('review-pr', {
    title: 'Review PR task', task: 'fixture:finish-pr', blueprint: 'repo', reviewOf: repoTask.id, requiresPullRequest: true,
  });
  const prTask = await settled('Review PR task');
  assert.equal(prTask.handoff.pullRequest.commit, head);
  assert.match(prTask.handoff.pullRequest.url, /^https:\/\/github\.com\/lanquarden\/manolo\/pull\/1$/);
  await createTask('review-pr-missing', {
    title: 'Missing PR proof', task: 'fixture:finish', blueprint: 'repo', reviewOf: repoTask.id, requiresPullRequest: true,
  });
  const missingPr = await settled('Missing PR proof', 'failed');
  assert.match(missingPr.failure, /finish tool after one corrective turn/);
  assert.equal(missingPr.handoff, undefined);

  await relay.end();
  await worker.end();
  assert.doesNotMatch(worker.log(), /Task request failed|Unhandled|AssertionError/);
});

test('a workspace lost after the Inbox answer reached the child resumes the same execution, never an empty resume', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-post-answer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = await seedRemote(root);
  const bundles = join(root, 'bundles');
  await mkdir(bundles, { recursive: true });
  await writeFile(join(bundles, 'IDENTITY.md'), 'You are a Task agent for this repository.\n');
  await writeFile(join(bundles, 'manifest.json'), JSON.stringify({
    version: 1,
    repositories: { sample: { remote, base: 'main', handoff: remote } },
    blueprints: {
      repo: { description: 'Repository Task', role: 'task', repository: 'sample', files: ['IDENTITY.md'],
        tools: ['bash', 'read', 'write', 'edit', 'finish', 'post_inbox', 'report_progress'] },
    },
  }));

  const token = secret();
  const password = secret();
  const workerData = join(root, 'worker');
  const relayData = join(root, 'relay');
  const configPath = join(root, 'relay.json');
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

  // The delay gives the test the window a real child has: the answer is already delivered, the turn has not ended yet.
  const worker = start(t, 'worker', {
    MANOLO_AGENT_ID: 'canary', MANOLO_AGENT_TOKEN: token, MANOLO_DATA_DIR: workerData,
    MANOLO_MODE: 'fixture', MANOLO_CODING_TOOLS: '1', MANOLO_FIXTURE_TOOLS: '1', MANOLO_FIXTURE_DELAY_MS: '1200', PORT: '0',
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
  const detailOf = async id => (await (await request(web, `/api/tasks/${id}`, auth)).json()).task;
  const ledger = () => {
    const db = new DatabaseSync(join(relayData, 'relay.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT id, status, execution_id, execution_kind, resume_item_id, blocked_reason, failure FROM tasks').all(); }
    finally { db.close(); }
  };

  assert.equal((await request(web, '/api/turns', auth, 'POST', {
    id: 'post-answer', text: fixtureTool('create_task', {
      title: 'Post-answer loss', task: fixtureTool('post_inbox', { kind: 'question', prompt: 'Proceed?' }), blueprint: 'repo',
    }),
  }, mutation)).status, 200);
  const waiting = await until(async () => (await tasksOf()).find(row => row.title === 'Post-answer loss' && row.status === 'waiting'), 'repository Task waits in Inbox');
  const item = (await (await request(web, '/api/inbox', auth)).json()).taskItems.find(entry => entry.taskId === waiting.id);
  const firstExecution = ledger().find(row => row.id === waiting.id).execution_id;
  assert.match(firstExecution, /^[0-9a-f]{32}$/);

  // The owner answers. Once the response has reached the parked call, the workspace is invalidated while that same
  // execution is still live.
  assert.equal((await request(web, `/api/tasks/${waiting.id}/inbox/${item.id}/respond`, auth, 'POST', { answer: 'Yes' }, mutation)).status, 200);
  const delivered = await until(async () => {
    const task = await detailOf(waiting.id);
    return task.items[0]?.deliveredAt && task;
  }, 'the Inbox answer reaches the child');
  assert.equal(delivered.status, 'running');
  const path = join(workerData, 'task-worktrees', waiting.id);
  await rename(path, `${path}.lost`);
  const blocked = await until(async () => {
    const row = (await tasksOf()).find(entry => entry.id === waiting.id);
    return row?.blocked && row;
  }, 'the lost workspace blocks after delivery');
  assert.equal(blocked.status, 'running');
  assert.match(blocked.blocked, /worktree|workspace/i);
  const blockedRow = ledger().find(row => row.id === waiting.id);
  assert.equal(blockedRow.execution_id, firstExecution, 'the block keeps the delivery execution');
  assert.equal(blockedRow.execution_kind, 'start', 'a delivered answer leaves no resume obligation behind');
  assert.equal(blockedRow.resume_item_id, null);
  // Wait for the worker to record its own blocked state too, so the recovery below cannot race its watcher teardown.
  await until(async () => {
    const response = await fetch(`${workerUrl}/v1/tasks/${waiting.id}/transcript`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json();
    return body.state === 'blocked' && body;
  }, 'the worker records the blocked execution');

  // Restoring the exact recorded path continues the same Task and execution; it is never an empty resume and never fails.
  await rename(`${path}.lost`, path);
  const relayDb = new DatabaseSync(join(relayData, 'relay.sqlite'));
  relayDb.prepare('UPDATE tasks SET next_at=0 WHERE id=?').run(waiting.id);
  relayDb.close();
  const recovered = await until(async () => {
    const row = (await tasksOf()).find(entry => entry.id === waiting.id);
    return row?.status === 'done' && row;
  }, 'the restored workspace resumes the same execution');
  assert.equal(recovered.id, waiting.id);
  assert.equal(recovered.failure, undefined);
  assert.equal(recovered.blocked, undefined);
  const finalRow = ledger().find(row => row.id === waiting.id);
  assert.equal(finalRow.execution_id, firstExecution, 'the answer was never delivered to a replacement execution');
  assert.equal(finalRow.failure, null);
  const finalDetail = await detailOf(waiting.id);
  assert.ok(finalDetail.items[0].deliveredAt, 'the answer stays recorded as delivered');
  assert.equal(finalDetail.items.length, 1, 'the answer was not delivered again');

  await relay.end();
  await worker.end();
  assert.doesNotMatch(worker.log(), /Task request failed|Unhandled|AssertionError/);
});

test('a workspace lost during a live initial submission is observed by the start retry, then the same run answers Inbox once and finishes', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-live-loss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = await seedRemote(root);
  const bundles = join(root, 'bundles');
  await mkdir(bundles, { recursive: true });
  await writeFile(join(bundles, 'IDENTITY.md'), 'You are a Task agent for this repository.\n');
  await writeFile(join(bundles, 'manifest.json'), JSON.stringify({
    version: 1,
    repositories: { sample: { remote, base: 'main', handoff: remote } },
    blueprints: {
      repo: { description: 'Repository Task', role: 'task', repository: 'sample', files: ['IDENTITY.md'],
        tools: ['bash', 'read', 'write', 'edit', 'finish', 'post_inbox', 'report_progress'] },
    },
  }));

  const token = secret();
  const password = secret();
  const workerData = join(root, 'worker');
  const relayData = join(root, 'relay');
  const configPath = join(root, 'relay.json');
  const gate = join(root, 'release-the-child');
  const payload = `answer-${randomBytes(8).toString('hex')}`;

  // The worker reaches the relay's internal listener through a stable forwarder, and every report it makes is recorded:
  // the shape of the settle and the number of settles are evidence, not assumptions.
  const reported = [];
  let internal = 'http://127.0.0.1:1';
  const toRelay = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let parsed;
    try { parsed = body.length ? JSON.parse(body.toString('utf8')) : undefined; } catch { parsed = undefined; }
    reported.push({ path: req.url, body: parsed, key: req.headers['idempotency-key'] });
    try {
      const response = await fetch(internal + req.url, {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers)
          .filter(([name]) => ['authorization', 'content-type', 'idempotency-key'].includes(name))),
        body: body.length ? body : undefined,
      });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(await response.text());
    } catch {
      res.writeHead(503).end();
    }
  }).listen(0, '127.0.0.1');
  await once(toRelay, 'listening');
  t.after(() => { toRelay.closeAllConnections?.(); toRelay.close(); });

  // The relay reaches the worker through a forwarder too. The first execution POST is admitted by the real worker and
  // then its acknowledgement is lost, held open until the test has taken the workspace away. Holding the response keeps
  // the relay scheduler from opening a second dispatch obligation, so the ordering is driven, not timed.
  let workerUrl = 'http://127.0.0.1:1';
  let dropStartAck = true;
  const held = deferred();
  const releaseAck = deferred();
  const toWorker = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    try {
      const response = await fetch(workerUrl + req.url, {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers)
          .filter(([name]) => ['authorization', 'content-type', 'idempotency-key'].includes(name))),
        body: body.length ? body : undefined,
      });
      const text = await response.text();
      if (dropStartAck && req.method === 'POST' && /\/executions(?:\/v2)?$/.test(req.url)) {
        dropStartAck = false;
        held.resolve();
        await releaseAck.promise;
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"start acknowledgement lost"}');
        return;
      }
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(text);
    } catch {
      res.writeHead(503).end();
    }
  }).listen(0, '127.0.0.1');
  await once(toWorker, 'listening');
  t.after(() => { toWorker.closeAllConnections?.(); toWorker.close(); });
  const workerProxy = addr(toWorker.address().port);

  const worker = start(t, 'worker', {
    MANOLO_AGENT_ID: 'canary', MANOLO_AGENT_TOKEN: token, MANOLO_DATA_DIR: workerData,
    MANOLO_MODE: 'fixture', MANOLO_CODING_TOOLS: '1', MANOLO_FIXTURE_TOOLS: '1', PORT: '0',
    MANOLO_BLUEPRINTS_DIR: bundles, MANOLO_RELAY_URL: addr(toRelay.address().port),
  });
  workerUrl = addr(await worker.port(/worker listening on (\d+)/));
  await writeFile(configPath, JSON.stringify({
    agents: { canary: { url: workerProxy, tokenEnv: 'CANARY_TOKEN' } },
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
  const rowOf = id => {
    const db = new DatabaseSync(join(relayData, 'relay.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
    finally { db.close(); }
  };
  const workerTranscript = async id => {
    const response = await fetch(`${workerUrl}/v1/tasks/${id}/transcript`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };

  // The child waits at a fixture gate: it has been admitted and its workspace prepared, but it has not posted yet.
  assert.equal((await request(web, '/api/turns', auth, 'POST', {
    id: 'live-loss', text: fixtureTool('create_task', {
      title: 'Live initial loss',
      task: [`fixture:gate:${gate}`, fixtureTool('post_inbox', { kind: 'question', prompt: 'May I finish?' }), 'fixture:finish-echo'].join('\n'),
      blueprint: 'repo',
    }),
  }, mutation)).status, 200);
  const task = await until(async () => (await tasksOf()).find(entry => entry.title === 'Live initial loss' && entry.executionId), 'the Task is dispatched');
  const executionId = rowOf(task.id).execution_id;
  assert.match(executionId, /^[0-9a-f]{32}$/);

  // The first start acknowledgement is already lost: the relay is still waiting on it while the child is admitted.
  await held.promise;
  const admitted = await until(async () => {
    const body = await workerTranscript(task.id);
    return body.state === 'running' && body.transcript?.[0]?.text?.includes(gate) && body;
  }, 'the initial submission is admitted and waiting at its gate');
  assert.equal(admitted.state, 'running');
  assert.equal(rowOf(task.id).execution_id, executionId, 'the acknowledgement loss did not mint another execution');

  // The real checkout is taken away while that same submission is still live.
  const path = join(workerData, 'task-worktrees', task.id);
  await rename(path, `${path}.lost`);
  releaseAck.resolve();

  // The retry that the lost acknowledgement owes arrives while the checkout is gone. It must observe a temporary
  // condition, not retire the live admission: the fence stays at run 1 and the execution keeps its run.
  const retried = await until(() => {
    const row = rowOf(task.id);
    return row?.dispatch_pending === 1 && row.dispatch_attempts >= 1 && row;
  }, 'the lost acknowledgement leaves a retry obligation');
  assert.equal(retried.execution_id, executionId);
  const relayDb = new DatabaseSync(join(relayData, 'relay.sqlite'));
  relayDb.prepare('UPDATE tasks SET next_at=0 WHERE id=?').run(task.id);
  relayDb.close();
  const observed = await until(() => {
    const row = rowOf(task.id);
    return row?.blocked_reason && row;
  }, 'the retry reports an unavailable workspace');
  assert.match(observed.blocked_reason, /worktree|workspace/i);
  assert.equal(observed.status, 'running');
  assert.equal(observed.execution_id, executionId, 'an observation never replaces the execution');
  assert.equal(observed.run_fence, 1, 'an observation leaves the live admission its authority');
  assert.equal(observed.admission_contract, 2);
  assert.equal(observed.finish_accepted_at, null);
  assert.equal(observed.dispatch_pending, 1, 'the block schedules the recovery retry');
  assert.equal((await workerTranscript(task.id)).state, 'running', 'the live submission is not blocked locally');
  assert.equal(reported.filter(entry => entry.path === `/v1/tasks/${task.id}/block`).length, 0, 'no block was retired for a live run');

  // Restoring the exact checkout and releasing the child lets the original submission post its one Inbox question.
  await rename(`${path}.lost`, path);
  await writeFile(gate, 'restored\n');
  const waiting = await until(async () => {
    const row = (await tasksOf()).find(entry => entry.id === task.id);
    return row?.status === 'waiting' && row;
  }, 'the original submission posts its Inbox question');
  // The observation stays visible while the Task waits: it is cleared only by the acknowledgement that matches the
  // current obligation, which is the resume of the restored execution, not by parking over it.
  assert.match(waiting.blocked ?? '', /worktree|workspace/i);
  const parkedRow = rowOf(task.id);
  assert.match(parkedRow.blocked_reason ?? '', /worktree|workspace/i);
  assert.equal(parkedRow.dispatch_pending, 0, 'parking releases the observation retry');
  assert.equal(parkedRow.execution_id, executionId);
  const inbox = await (await request(web, '/api/inbox', auth)).json();
  const items = inbox.taskItems.filter(entry => entry.taskId === task.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].prompt, 'May I finish?');

  // The answer resumes that same durable submission exactly once, and the original run finishes with its own admission.
  assert.equal((await request(web, `/api/tasks/${task.id}/inbox/${items[0].id}/respond`, auth, 'POST', { answer: payload }, mutation)).status, 200);
  const done = await until(async () => {
    const row = (await tasksOf()).find(entry => entry.id === task.id);
    return row?.status === 'done' && row;
  }, 'the original run finishes after the answer');
  assert.equal(done.id, task.id);
  assert.equal(done.failure, undefined);
  assert.equal(done.blocked, undefined);

  const finalRow = rowOf(task.id);
  assert.equal(finalRow.execution_id, executionId, 'the answer reached the original execution, never a replacement');
  assert.equal(finalRow.execution_kind, 'start');
  assert.equal(finalRow.resume_item_id, null);
  assert.equal(finalRow.run_fence, 1, 'the original admission settled its own Task');
  assert.equal(finalRow.admission_contract, 2);
  assert.notEqual(finalRow.finish_accepted_at, null);

  // The answer payload is visible in the outcome and in the child transcript, and the answer is recorded on exactly one item.
  assert.match(done.outcome, /"status":"answered"/);
  assert.ok(done.outcome.includes(payload), 'the finish summary carries the delivered answer');
  const detail = await (await request(web, `/api/tasks/${task.id}`, auth)).json();
  assert.equal(detail.task.items.length, 1, 'one Inbox item was opened and answered once');
  assert.equal(detail.task.items[0].response, payload);
  assert.ok(detail.task.items[0].deliveredAt, 'the answer was delivered to the child');
  assert.equal(detail.transcript.at(-1).role, 'assistant');
  assert.ok(detail.transcript.at(-1).text.includes(payload), 'the transcript carries the delivered answer');
  assert.equal(detail.transcript.some(entry => entry.role === 'user' && entry.text.includes('ended this Task')), false,
    'the original run never needed a corrective turn');

  const settles = reported.filter(entry => entry.path === `/v1/tasks/${task.id}/settle`);
  assert.equal(settles.length, 1, 'the original run settled exactly once');
  assert.equal(settles[0].body.run, 1);
  assert.equal(settles[0].body.outcome, 'done');
  const inboxCalls = reported.filter(entry => entry.path === `/v1/tasks/${task.id}/inbox`);
  assert.equal(new Set(inboxCalls.map(entry => JSON.stringify(entry.body))).size, 1, 'every Inbox call names the same one item');
  assert.equal(new Set(inboxCalls.map(entry => entry.key)).size, 1, 'a replayed call is the same operation, not a second question');
  assert.equal(inboxCalls.every(entry => entry.body.run === 1), true, 'the question belongs to the original admission');
  assert.equal((await (await request(web, '/api/inbox', auth)).json()).taskItems.filter(entry => entry.taskId === task.id).length, 0);

  await relay.end();
  await worker.end();
  assert.doesNotMatch(worker.log(), /Task request failed|Unhandled|AssertionError/);
});
