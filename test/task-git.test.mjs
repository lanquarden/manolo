import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { openTaskGit } from '../src/task-git.mjs';

const run = promisify(execFile);
const id = () => randomBytes(16).toString('hex');
const git = async (cwd, ...args) => (await run('git', args, { cwd })).stdout.trim();

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'user.email', 'test@example.invalid');
  await git(source, 'config', 'user.name', 'Test');
  await writeFile(join(source, 'README.md'), 'base\n');
  await git(source, 'add', 'README.md');
  await git(source, 'commit', '-m', 'base');
  const remote = join(root, 'remote.git');
  await run('git', ['clone', '--bare', source, remote]);
  const baseSha = await git(source, 'rev-parse', 'HEAD');
  return { root, remote, baseSha, dataDir: join(root, 'data') };
}

test('repository Tasks get independent worktrees, isolated handoffs, restart reuse, and safe cleanup', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const a = id();
  const b = id();
  const [first, second] = await Promise.all([
    taskGit.prepare(a, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote }),
    taskGit.prepare(b, { name: 'sample', remote: repo.remote, base: 'main', handoff: '/tmp/other-handoff.git' }),
  ]);
  assert.notEqual(first.path, second.path);
  assert.equal(first.baseSha, repo.baseSha);
  assert.equal(second.baseSha, repo.baseSha);
  assert.equal(first.branch, `task/${a}`);
  assert.equal(second.branch, `task/${b}`);
  assert.equal(first.handoff, repo.remote);
  assert.equal(second.handoff, '/tmp/other-handoff.git');
  // A shared mirror must not carry a mutable named handoff remote from either Task.
  await assert.rejects(git(first.path, 'remote', 'get-url', 'handoff'), /No such remote/);

  const restarted = openTaskGit({ dataDir: repo.dataDir });
  const again = await restarted.prepare(a, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  assert.equal(again.path, first.path);
  assert.equal((await restarted.assertWorkspace(a)).branch, `task/${a}`);
  // A workspace record from the first candidate is upgraded in place, not rejected or recreated.
  const oldRecord = JSON.parse(await readFile(join(repo.dataDir, 'task-worktrees', `${a}.json`), 'utf8'));
  const { version, mirror, remoteHash, expectedHead, ...legacyRecord } = oldRecord;
  await writeFile(join(repo.dataDir, 'task-worktrees', `${a}.json`), JSON.stringify(legacyRecord));
  const upgraded = await restarted.assertWorkspace(a);
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.expectedHead, repo.baseSha);

  // Read-only work can finish without a handoff.
  assert.deepEqual(await taskGit.checkFinish(a), {
    ok: true, commit: repo.baseSha, base: repo.baseSha, expectedHead: repo.baseSha, unchanged: true,
  });

  await writeFile(join(first.path, 'notes.txt'), 'local\n');
  const dirty = await taskGit.checkFinish(a);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.code, 'dirty_worktree');
  assert.match(dirty.message, /notes\.txt/);
  const dirtyId = id();
  const dirtyTree = await taskGit.prepare(dirtyId, { name: 'sample', remote: repo.remote, base: 'main' });
  await writeFile(join(dirtyTree.path, 'dirty.txt'), 'local\n');
  const preservedDirty = await taskGit.cleanup(dirtyId, { terminal: true, successful: false });
  assert.equal(preservedDirty.removed, false);
  assert.equal(preservedDirty.reason, 'dirty_worktree');
  assert.equal((await taskGit.readMeta(dirtyId)).kind, 'preserved');
  assert.equal(existsSync(dirtyTree.path), true);

  await run('git', ['add', 'notes.txt'], { cwd: first.path });
  await run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'task work'], { cwd: first.path });
  const head = await git(first.path, 'rev-parse', 'HEAD');
  const missing = await taskGit.checkFinish(a);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'handoff_missing');
  assert.match(missing.message, /Push/);

  await git(first.path, 'push', repo.remote, `HEAD:refs/heads/task/${a}`);
  const verified = await taskGit.checkFinish(a);
  assert.equal(verified.ok, true);
  assert.equal(verified.commit, head);
  assert.equal(verified.branch, `task/${a}`);
  assert.equal(await git(repo.remote, 'rev-parse', `refs/heads/task/${a}`), head);

  // A clean detached HEAD with a local-only commit must be preserved, not erased, on failure.
  const detachedId = id();
  const detached = await taskGit.prepare(detachedId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  await git(detached.path, 'checkout', '--detach');
  await git(detached.path, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'only local');
  const localHead = await git(detached.path, 'rev-parse', 'HEAD');
  const cleaned = await taskGit.cleanup(detachedId, { terminal: true, successful: false });
  assert.equal(cleaned.removed, false);
  assert.equal(cleaned.reason, 'detached_or_switched_branch');
  assert.equal(cleaned.preservedHead, localHead);
  assert.equal(existsSync(detached.path), true);
  const preserved = await taskGit.readMeta(detachedId);
  assert.equal(preserved.kind, 'preserved');
  assert.equal(preserved.preservedHead, localHead);
  await assert.rejects(taskGit.assertWorkspace(detachedId), error => error.code === 'worktree_missing');

  // Successful cleanup removes only a verified/untouched tree and leaves a tombstone.
  assert.deepEqual(await taskGit.cleanup(a, { terminal: true, successful: true }), { removed: true });
  await assert.rejects(restarted.prepare(a, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote }), error => error.code === 'worktree_missing');
});

test('a replaced or missing worktree is reported and never accepted as the recorded workspace', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const taskId = id();
  const prepared = await taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main' });
  await rm(prepared.path, { recursive: true, force: true });
  await assert.rejects(taskGit.assertWorkspace(taskId), error => error.code === 'worktree_missing');
  await assert.rejects(taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main' }), error => error.code === 'worktree_missing');
  // An empty replacement directory is not the recorded worktree.
  await mkdir(prepared.path, { recursive: true });
  await assert.rejects(taskGit.assertWorkspace(taskId), error => error.code === 'worktree_missing');
  await assert.rejects(taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main' }), error => error.code === 'worktree_missing');

  const scratchId = id();
  const scratch = await taskGit.prepareScratch(scratchId);
  await writeFile(join(scratch.path, 'only-copy.txt'), 'keep\n');
  assert.deepEqual(await taskGit.cleanup(scratchId, { terminal: true }), { removed: false, reason: 'local_work_preserved' });
  assert.equal(await readFile(join(scratch.path, 'only-copy.txt'), 'utf8'), 'keep\n');
  await rm(join(scratch.path, 'only-copy.txt'));
  assert.deepEqual(await taskGit.cleanup(scratchId, { terminal: true }), { removed: true });
  await assert.rejects(taskGit.prepareScratch(scratchId), error => error.code === 'worktree_missing');
});
