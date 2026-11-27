import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

test('repository Tasks get independent worktrees, reuse them after a restart, and refuse dirty finishes', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const a = id();
  const b = id();
  const config = { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote };
  const [first, second] = await Promise.all([taskGit.prepare(a, config), taskGit.prepare(b, config)]);
  assert.notEqual(first.path, second.path);
  assert.equal(first.baseSha, repo.baseSha);
  assert.equal(second.baseSha, repo.baseSha);
  assert.equal(first.branch, `task/${a}`);
  assert.equal(second.branch, `task/${b}`);
  assert.equal(await readFile(join(first.path, 'README.md'), 'utf8'), 'base\n');

  // A second service instance opens the same Task's worktree, with no fetch or re-creation.
  const restarted = openTaskGit({ dataDir: repo.dataDir });
  const again = await restarted.prepare(a, config);
  assert.equal(again.path, first.path);
  assert.equal(again.baseSha, repo.baseSha);

  // Read-only work can finish without a handoff.
  assert.deepEqual(await taskGit.checkFinish(a), { ok: true, commit: repo.baseSha, unchanged: true });

  // Untracked work is dirty too.
  await writeFile(join(first.path, 'notes.txt'), 'local\n');
  const dirty = await taskGit.checkFinish(a);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.code, 'dirty_worktree');
  assert.match(dirty.message, /notes\.txt/);
  assert.deepEqual(await taskGit.cleanup(a, { terminal: true }), { removed: false, reason: 'dirty_worktree', files: ['?? notes.txt'] });

  // A commit beyond base needs a verifiable handoff branch; the check never pushes.
  await run('git', ['add', 'notes.txt'], { cwd: first.path });
  await run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'task work'], { cwd: first.path });
  const head = await git(first.path, 'rev-parse', 'HEAD');
  assert.notEqual(head, repo.baseSha);
  const missing = await taskGit.checkFinish(a);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'handoff_missing');
  assert.match(missing.message, new RegExp(`task/${a}`));

  await git(first.path, 'push', repo.remote, `HEAD:refs/heads/task/${a}`);
  const verified = await taskGit.checkFinish(a);
  assert.equal(verified.ok, true);
  assert.equal(verified.commit, head);
  assert.equal(await git(repo.remote, 'rev-parse', `refs/heads/task/${a}`), head);

  // A different commit on the handoff branch is refused.
  await writeFile(join(first.path, 'notes.txt'), 'changed\n');
  await run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-am', 'change'], { cwd: first.path });
  const mismatch = await taskGit.checkFinish(a);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'handoff_mismatch');

  // Clean terminal cleanup removes only the clean worktree and leaves a tombstone instead of recreating it later.
  await git(first.path, 'push', repo.remote, `HEAD:refs/heads/task/${a}`);
  assert.deepEqual(await taskGit.cleanup(a, { terminal: true }), { removed: true });
  await assert.rejects(restarted.prepare(a, config), error => error.code === 'worktree_missing');
  assert.match(await git(repo.remote, 'rev-parse', `refs/heads/task/${a}`), /^[0-9a-f]{40,64}$/);
});

test('a missing worktree is reported and never recreated, and scratch workspaces preserve local files', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const taskId = id();
  const prepared = await taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main' });
  await rm(prepared.path, { recursive: true, force: true });
  await assert.rejects(taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main' }),
    error => error.code === 'worktree_missing' && /missing/.test(error.message));

  const scratchId = id();
  const scratch = await taskGit.prepareScratch(scratchId);
  await writeFile(join(scratch.path, 'only-copy.txt'), 'keep\n');
  assert.deepEqual(await taskGit.cleanup(scratchId, { terminal: true }), { removed: false, reason: 'local_work_preserved' });
  assert.equal(await readFile(join(scratch.path, 'only-copy.txt'), 'utf8'), 'keep\n');
  await rm(join(scratch.path, 'only-copy.txt'));
  assert.deepEqual(await taskGit.cleanup(scratchId, { terminal: true }), { removed: true });
  await assert.rejects(taskGit.prepareScratch(scratchId), error => error.code === 'worktree_missing');
});
