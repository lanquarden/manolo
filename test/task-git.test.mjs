import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

test('cleanup preserves a worktree that moved to another named branch at the initial head', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const taskId = id();
  const prepared = await taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  // Unpublished Task work: a commit exists only on the recorded Task branch, not on the handoff remote.
  await writeFile(join(prepared.path, 'work.txt'), 'unpublished\n');
  await git(prepared.path, 'add', 'work.txt');
  await git(prepared.path, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'unpublished task work');
  const taskCommit = await git(prepared.path, 'rev-parse', 'HEAD');
  assert.notEqual(taskCommit, repo.baseSha);
  // Park a different named branch at the initial expected HEAD: the tree is clean and HEAD equals expectedHead,
  // so only the branch mismatch distinguishes this from an untouched workspace.
  await git(prepared.path, 'checkout', '-b', 'elsewhere', repo.baseSha);
  assert.equal(await git(prepared.path, 'rev-parse', 'HEAD'), repo.baseSha);
  assert.equal(await git(prepared.path, 'symbolic-ref', '--short', 'HEAD'), 'elsewhere');
  assert.equal(await git(prepared.path, 'status', '--porcelain=v1', '--untracked-files=all'), '');

  // Even a relay-confirmed success must not remove a workspace that was switched to another branch.
  const result = await taskGit.cleanup(taskId, { terminal: true, successful: true });
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'detached_or_switched_branch');
  assert.equal(result.preservedHead, repo.baseSha);
  assert.equal(result.preservedBranch, 'elsewhere');
  assert.equal(result.taskBranch, `task/${taskId}`);
  assert.equal(result.taskCommit, taskCommit);
  assert.equal(existsSync(prepared.path), true);

  const preserved = await taskGit.readMeta(taskId);
  assert.equal(preserved.kind, 'preserved');
  assert.equal(preserved.preserveReason, 'detached_or_switched_branch');
  assert.equal(preserved.branch, `task/${taskId}`);
  assert.equal(preserved.taskCommit, taskCommit);
  await assert.rejects(taskGit.assertWorkspace(taskId), error => error.code === 'worktree_missing');

  // The recorded Task branch still holds the unpublished commit, so recovery has a named ref and an exact SHA.
  assert.equal(await git(prepared.mirror, 'rev-parse', `refs/heads/task/${taskId}`), taskCommit);
});

test('a tag named like the Task branch does not break identity or a safe cleanup', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const taskId = id();
  const prepared = await taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  // refs/tags/task/<id> next to refs/heads/task/<id> makes the short form ambiguous: Git then prints heads/task/<id>.
  await git(prepared.path, 'tag', `task/${taskId}`);
  assert.equal(await git(prepared.path, 'symbolic-ref', '--short', 'HEAD'), `heads/task/${taskId}`);
  assert.equal(await git(prepared.path, 'symbolic-ref', 'HEAD'), `refs/heads/task/${taskId}`);

  // An untouched workspace still verifies, reuses, and finishes, then is removed as clean.
  assert.equal((await taskGit.assertWorkspace(taskId)).branch, `task/${taskId}`);
  assert.equal((await taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote })).path, prepared.path);
  assert.equal((await taskGit.checkFinish(taskId)).unchanged, true);
  assert.deepEqual(await taskGit.cleanup(taskId, { terminal: true, successful: true }), { removed: true });
  assert.equal(existsSync(prepared.path), false);

  // Handed-off work under the same shadowing tag is still the recorded branch, not a switched one.
  const handedId = id();
  const handed = await taskGit.prepare(handedId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  await git(handed.path, 'tag', `task/${handedId}`);
  await writeFile(join(handed.path, 'work.txt'), 'handed off\n');
  await git(handed.path, 'add', 'work.txt');
  await git(handed.path, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'task work');
  const head = await git(handed.path, 'rev-parse', 'HEAD');
  await git(handed.path, 'push', repo.remote, `HEAD:refs/heads/task/${handedId}`);
  assert.equal((await taskGit.checkFinish(handedId)).commit, head);
  assert.deepEqual(await taskGit.cleanup(handedId, { terminal: true, successful: true }), { removed: true });
  assert.equal(existsSync(handed.path), false);
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

test('two Tasks in one repository get independent Git common dirs, stashes, checkouts, and config', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const a = id();
  const b = id();
  const [first, second] = await Promise.all([
    taskGit.prepare(a, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote }),
    taskGit.prepare(b, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote }),
  ]);
  // A Task's Git common dir is its own clone, not the shared seed store.
  assert.notEqual(first.mirror, second.mirror);
  assert.notEqual(first.mirror, first.seed);
  assert.equal(await git(first.path, 'rev-parse', '--git-common-dir'), first.mirror);
  assert.equal(await git(second.path, 'rev-parse', '--git-common-dir'), second.mirror);

  // Ordinary stash operations stay inside the Task that ran them.
  await writeFile(join(first.path, 'stashed-a.txt'), 'only in task A\n');
  await git(first.path, 'stash', 'push', '--include-untracked', '-m', 'a-stash');
  assert.match(await git(first.path, 'stash', 'list'), /a-stash/);
  assert.equal(await git(second.path, 'stash', 'list'), '');
  await writeFile(join(second.path, 'stashed-b.txt'), 'only in task B\n');
  await git(second.path, 'stash', 'push', '--include-untracked', '-m', 'b-stash');
  assert.match(await git(second.path, 'stash', 'list'), /b-stash/);
  assert.doesNotMatch(await git(first.path, 'stash', 'list'), /b-stash/);
  assert.notEqual(await git(first.path, 'rev-parse', 'refs/stash'), await git(second.path, 'rev-parse', 'refs/stash'));

  // Config written by one Task is invisible to the other.
  await git(first.path, 'config', 'manolo.marker', 'task-a');
  await assert.rejects(git(second.path, 'config', '--get', 'manolo.marker'), /Command failed/);
  assert.equal(await git(second.path, 'config', '--get', 'manolo.marker').catch(() => ''), '');

  // Same-repository work runs concurrently without sharing a branch, index, or push destination.
  await writeFile(join(first.path, 'a.txt'), 'a\n');
  await writeFile(join(second.path, 'b.txt'), 'b\n');
  await Promise.all([first.path, second.path].map(async path => {
    const name = path === first.path ? 'a' : 'b';
    await git(path, 'add', `${name}.txt`);
    await git(path, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', `${name} work`);
  }));
  const firstHead = await git(first.path, 'rev-parse', 'HEAD');
  const secondHead = await git(second.path, 'rev-parse', 'HEAD');
  assert.notEqual(firstHead, secondHead);
  assert.equal(await git(first.path, 'symbolic-ref', '--short', 'HEAD'), `task/${a}`);
  assert.equal(await git(second.path, 'symbolic-ref', '--short', 'HEAD'), `task/${b}`);
  assert.equal(await git(first.path, 'rev-parse', `refs/heads/task/${b}`).catch(() => 'absent'), 'absent');
  assert.equal(await git(second.path, 'rev-parse', `refs/heads/task/${a}`).catch(() => 'absent'), 'absent');
});

test('ignored and nested ignored additions are detected, blocked at finish, and preserved at cleanup', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const taskId = id();
  const prepared = await taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  // The Task commits its own ignore rules, then produces ignored output in a nested directory.
  await writeFile(join(prepared.path, '.gitignore'), 'out/\n');
  await mkdir(join(prepared.path, 'sub'), { recursive: true });
  await writeFile(join(prepared.path, 'sub', '.gitignore'), 'nested.log\n');
  await git(prepared.path, 'add', '.gitignore', 'sub/.gitignore');
  await git(prepared.path, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'ignore rules');
  const head = await git(prepared.path, 'rev-parse', 'HEAD');
  await mkdir(join(prepared.path, 'out'), { recursive: true });
  await writeFile(join(prepared.path, 'out', 'artifact.bin'), 'build output\n');
  await mkdir(join(prepared.path, 'sub', 'cache'), { recursive: true });
  await writeFile(join(prepared.path, 'sub', 'cache', 'nested.log'), 'nested output\n');
  // Plain status would call this clean; finish refuses to lose it silently.
  assert.equal(await git(prepared.path, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  const refused = await taskGit.checkFinish(taskId);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ignored_worktree_files');
  assert.match(refused.message, /out\/|nested\.log/);
  // Cleanup keeps the whole worktree and both ignored files, even for a relay-confirmed success.
  const preserved = await taskGit.cleanup(taskId, { terminal: true, successful: true });
  assert.equal(preserved.removed, false);
  assert.equal(preserved.reason, 'ignored_worktree_files');
  assert.equal(existsSync(prepared.path), true);
  assert.equal(await readFile(join(prepared.path, 'out', 'artifact.bin'), 'utf8'), 'build output\n');
  assert.equal(await readFile(join(prepared.path, 'sub', 'cache', 'nested.log'), 'utf8'), 'nested output\n');
  const meta = await taskGit.readMeta(taskId);
  assert.equal(meta.kind, 'preserved');
  assert.equal(meta.preservedHead, head);
});

test('a review opens its exact pinned commit and base even after the upstream base ref is renamed or deleted', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const sourceId = id();
  const source = await taskGit.prepare(sourceId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  await writeFile(join(source.path, 'reviewed.txt'), 'reviewed change\n');
  await git(source.path, 'add', 'reviewed.txt');
  await git(source.path, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'reviewed work');
  const commit = await git(source.path, 'rev-parse', 'HEAD');
  await git(source.path, 'push', repo.remote, `HEAD:refs/heads/task/${sourceId}`);
  // The upstream branch moves on, is renamed, and its old name disappears: none of that changes the bound SHAs.
  await git(repo.root, 'clone', repo.remote, join(repo.root, 'advance'));
  const advance = join(repo.root, 'advance');
  await git(advance, 'config', 'user.email', 'test@example.invalid');
  await git(advance, 'config', 'user.name', 'Test');
  await writeFile(join(advance, 'later.txt'), 'later\n');
  await git(advance, 'add', 'later.txt');
  await git(advance, 'commit', '-m', 'later upstream work');
  const later = await git(advance, 'rev-parse', 'HEAD');
  await git(advance, 'push', repo.remote, `HEAD:refs/heads/main`);
  await git(advance, 'push', repo.remote, `HEAD:refs/heads/trunk`);
  await git(repo.remote, 'update-ref', '-d', 'refs/heads/main');

  const reviewId = id();
  const review = await taskGit.prepareReview(reviewId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote }, {
    sourceTaskId: sourceId, commit, baseSha: repo.baseSha, branch: `task/${sourceId}`, handoff: repo.remote,
  });
  assert.equal(await git(review.path, 'rev-parse', 'HEAD'), commit);
  assert.notEqual(await git(review.path, 'rev-parse', 'HEAD'), later, 'a review never checks out a moving tip');
  assert.equal(review.baseSha, repo.baseSha);
  assert.equal(review.review.sourceBranch, `task/${sourceId}`);
  assert.equal(review.review.sourceHandoff, repo.remote);
  const finished = await taskGit.checkFinish(reviewId);
  assert.equal(finished.ok, true);
  assert.equal(finished.commit, commit);
  assert.equal(finished.base, repo.baseSha);
  assert.deepEqual(finished.review, review.review);

  // A commit that is not in any configured remote fails closed; it is not replaced by the current tip.
  await assert.rejects(taskGit.prepareReview(id(), { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote }, {
    sourceTaskId: sourceId, commit: 'f'.repeat(40), baseSha: repo.baseSha, branch: `task/${sourceId}`, handoff: repo.remote,
  }), error => error.code === 'review_commit_missing');
});

// The pre-per-Task layout the service itself created: one shared bare mirror per remote, the worktree attached to it, and
// a record with no version, mirror, or expected-head binding. `unpublished` adds an older Task's branch and a tag that
// live only in that shared directory.
function seedPathOf(remote, dataDir) {
  return join(dataDir, 'task-repos', `${createHash('sha256').update(remote).digest('hex').slice(0, 16)}.git`);
}

async function legacyMirror(repo, taskId, { unpublished = false, branch = `task/${taskId}` } = {}) {
  const mirror = seedPathOf(repo.remote, repo.dataDir);
  await mkdir(join(repo.dataDir, 'task-repos'), { recursive: true });
  if (!existsSync(mirror)) await run('git', ['clone', '--bare', repo.remote, mirror]);
  await run('git', ['-C', mirror, 'fetch', '--force', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  if (unpublished) {
    await run('git', ['-C', mirror, 'update-ref', 'refs/heads/task/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', repo.baseSha]);
    await run('git', ['-C', mirror, 'tag', 'older-task-tag', repo.baseSha]);
  }
  const path = join(repo.dataDir, 'task-worktrees', taskId);
  await mkdir(join(repo.dataDir, 'task-worktrees'), { recursive: true });
  await run('git', ['-C', mirror, 'worktree', 'add', '-B', branch, path, repo.baseSha]);
  const meta = {
    kind: 'worktree', taskId, path, branch, baseSha: repo.baseSha,
    remote: repo.remote, base: 'main', handoff: repo.remote, repository: 'sample',
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(repo.dataDir, 'task-worktrees', `${taskId}.json`), JSON.stringify(meta));
  return { mirror, path, meta };
}

const refsOf = async path => (await git(path, 'for-each-ref', '--format=%(refname) %(objectname)')).split('\n').sort().join('\n');

test('a legacy shared-mirror record is upgraded only when its mirror registration is proven', async t => {
  const repo = await repository(t);
  const taskId = id();
  const legacy = await legacyMirror(repo, taskId);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  // A genuine record: the recorded remote names exactly the shared mirror the worktree is registered in.
  const upgraded = await taskGit.assertWorkspace(taskId);
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.mirror, legacy.mirror);
  assert.equal(upgraded.seed, legacy.mirror);
  assert.equal(upgraded.expectedHead, repo.baseSha);
  assert.equal(await git(legacy.path, 'rev-parse', '--git-common-dir'), legacy.mirror);

  // A replacement clone at the same filesystem path with the same branch name is not this Task's worktree. Its observed
  // common dir is never adopted, nothing is rewritten, and the original v1 record is left exactly as it was.
  await rm(legacy.path, { recursive: true, force: true });
  await run('git', ['-C', legacy.mirror, 'worktree', 'prune']);
  const replacement = join(repo.root, 'replacement');
  await run('git', ['clone', repo.remote, replacement]);
  await run('git', ['-C', replacement, 'checkout', '-B', `task/${taskId}`]);
  await run('git', ['-C', replacement, 'config', 'user.email', 'test@example.invalid']);
  await run('git', ['-C', replacement, 'config', 'user.name', 'Test']);
  await rename(replacement, legacy.path);
  await writeFile(join(repo.dataDir, 'task-worktrees', `${taskId}.json`), JSON.stringify(legacy.meta));
  await assert.rejects(taskGit.assertWorkspace(taskId), error => error.code === 'worktree_missing' || error.code === 'invalid_task_git_state');
  const untouched = JSON.parse(await readFile(join(repo.dataDir, 'task-worktrees', `${taskId}.json`), 'utf8'));
  assert.equal(untouched.version, undefined, 'a rejected migration writes nothing');
  assert.equal(untouched.mirror, undefined);
});

test('a Task store is seeded with objects and proven refs only, with no inherited Task branch and no pushable seed', async t => {
  const repo = await repository(t);
  // The old layout's shared mirror, including an older Task's branch and tag that exist only in that directory.
  const seed = seedPathOf(repo.remote, repo.dataDir);
  await mkdir(join(repo.dataDir, 'task-repos'), { recursive: true });
  await run('git', ['clone', '--bare', repo.remote, seed]);
  await run('git', ['-C', seed, 'fetch', '--force', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  await run('git', ['-C', seed, 'update-ref', 'refs/heads/task/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', repo.baseSha]);
  await run('git', ['-C', seed, 'tag', 'older-task-tag', repo.baseSha]);
  const seedBefore = await refsOf(seed);

  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const taskId = id();
  const prepared = await taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  assert.equal(prepared.seed, seed);
  assert.notEqual(prepared.mirror, seed);
  // The worktree starts at the pinned base and holds only this Task's branch: nothing inherited from the shared mirror.
  assert.equal(await git(prepared.path, 'rev-parse', 'HEAD'), repo.baseSha);
  assert.equal(await git(prepared.path, 'for-each-ref', '--format=%(refname)', 'refs/heads/'), `refs/heads/task/${taskId}`);
  assert.doesNotMatch(await refsOf(prepared.mirror), /task\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|older-task-tag/);
  assert.equal(await git(prepared.path, 'remote'), '', 'the Task store has no remote at all');
  await assert.rejects(git(prepared.path, 'push', '--all'), /No configured push destination|fatal/i);

  // Even after the child configures a deliberate handoff destination, a routine `git push --all` publishes only its own
  // branch: the older Task's ref and tag are not in this store to be published.
  await writeFile(join(prepared.path, 'work.txt'), 'task work\n');
  await git(prepared.path, 'add', 'work.txt');
  await git(prepared.path, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'task work');
  await git(prepared.path, 'push', '--all', repo.remote);
  const published = await git(repo.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/tags/');
  assert.match(published, new RegExp(`refs/heads/task/${taskId}`));
  assert.doesNotMatch(published, /task\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|older-task-tag/);
  assert.equal(await refsOf(seed), seedBefore, 'nothing in the shared store was written');
});

test('a review opens the exact handed-off commit from the source Task store after the remote branch rewinds', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const sourceId = id();
  const source = await taskGit.prepare(sourceId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  await writeFile(join(source.path, 'handed.txt'), 'handed off\n');
  await git(source.path, 'add', 'handed.txt');
  await git(source.path, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'handed work');
  const commit = await git(source.path, 'rev-parse', 'HEAD');
  await git(source.path, 'push', repo.remote, `HEAD:refs/heads/task/${sourceId}`);
  assert.equal((await taskGit.checkFinish(sourceId)).commit, commit);
  // The relay confirms the Task, so terminal cleanup removes the clean, handed-off worktree and leaves its store and
  // branch behind.
  assert.deepEqual(await taskGit.cleanup(sourceId, { terminal: true, successful: true }), { removed: true });
  // The handoff remote then loses the branch: neither the remote nor the shared store can advertise the handed-off commit
  // any more, and the retained source store is the only place that still holds it.
  await git(repo.remote, 'update-ref', '-d', `refs/heads/task/${sourceId}`);
  await assert.rejects(git(repo.remote, 'rev-parse', `refs/heads/task/${sourceId}`));
  const seed = seedPathOf(repo.remote, repo.dataDir);
  await assert.rejects(git(seed, 'cat-file', '-e', `${commit}^{commit}`));

  const reviewId = id();
  const review = await taskGit.prepareReview(reviewId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote }, {
    sourceTaskId: sourceId, commit, baseSha: repo.baseSha, branch: `task/${sourceId}`, handoff: repo.remote,
  });
  assert.equal(await git(review.path, 'rev-parse', 'HEAD'), commit, 'the exact handed-off commit, never a new tip');
  assert.equal(review.review.commit, commit);
  assert.equal(review.review.sourceBranch, `task/${sourceId}`);
  assert.equal(review.review.sourceHandoff, repo.remote);
  // The transfer used a private ref: no source or Task branch was copied into the review store.
  assert.equal(await git(review.mirror, 'for-each-ref', '--format=%(refname)', `refs/heads/task/${sourceId}`), '');
  assert.equal(await git(review.mirror, 'for-each-ref', '--format=%(refname)', `refs/manolo/pinned/${commit}`), `refs/manolo/pinned/${commit}`);
  assert.equal((await taskGit.checkFinish(reviewId)).review.sourceBranch, `task/${sourceId}`);
});

test('a review record written without source provenance is completed from its validated dispatch evidence', async t => {
  const repo = await repository(t);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const sourceId = id();
  const source = await taskGit.prepare(sourceId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  await writeFile(join(source.path, 'reviewed.txt'), 'reviewed change\n');
  await git(source.path, 'add', 'reviewed.txt');
  await git(source.path, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'reviewed work');
  const commit = await git(source.path, 'rev-parse', 'HEAD');
  await git(source.path, 'push', repo.remote, `HEAD:refs/heads/task/${sourceId}`);
  const reviewId = id();
  const prepared = await taskGit.prepareReview(reviewId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote }, {
    sourceTaskId: sourceId, commit, baseSha: repo.baseSha, branch: `task/${sourceId}`, handoff: repo.remote,
  });
  // A record written by the previous candidate binds the same exact commits but has no source provenance.
  const metaPath = join(repo.dataDir, 'task-worktrees', `${reviewId}.json`);
  const record = JSON.parse(await readFile(metaPath, 'utf8'));
  const { sourceBranch, sourceHandoff, ...legacyReview } = record.review;
  assert.equal(sourceBranch, `task/${sourceId}`);
  await writeFile(metaPath, JSON.stringify({ ...record, review: legacyReview }));

  // Evidence that names different commits or another source Task can add nothing: it never redirects the binding.
  const mismatched = await taskGit.checkFinish(reviewId, {
    review: { sourceTaskId: id(), commit: 'f'.repeat(40), baseSha: repo.baseSha, branch: `task/${sourceId}`, handoff: repo.remote },
  });
  assert.equal(mismatched.review.sourceBranch, undefined);
  assert.equal((await taskGit.readMeta(reviewId)).review.sourceBranch, undefined);

  // The recorded dispatch evidence names the same exact commit and base, so the missing provenance is completed and kept.
  const checked = await taskGit.checkFinish(reviewId, {
    review: { sourceTaskId: sourceId, commit, baseSha: repo.baseSha, branch: `task/${sourceId}`, handoff: repo.remote },
  });
  assert.equal(checked.review.commit, commit);
  assert.equal(checked.review.sourceBranch, `task/${sourceId}`);
  assert.equal(checked.review.sourceHandoff, repo.remote);
  const persisted = JSON.parse(await readFile(metaPath, 'utf8'));
  assert.equal(persisted.review.sourceBranch, `task/${sourceId}`);
  assert.equal(persisted.review.commit, commit);
  assert.equal(await git(prepared.path, 'rev-parse', 'HEAD'), commit, 'the checkout never moved');
});

async function sha256Repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'manolo-task-git-sha256-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await git(source, 'init', '--object-format=sha256', '-b', 'main');
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

test('a Task store inherits a SHA-256 source and validates exact 40- or 64-character object ids', async t => {
  const repo = await sha256Repository(t);
  assert.equal(repo.baseSha.length, 64);
  const taskGit = openTaskGit({ dataDir: repo.dataDir });
  const taskId = id();
  const workspace = await taskGit.prepare(taskId, { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote });
  assert.equal(workspace.baseSha, repo.baseSha);
  assert.equal(workspace.expectedHead, repo.baseSha);
  // The Task's own store and worktree use the source's object format; a SHA-1 store could never fetch these objects.
  assert.equal(await git(workspace.path, 'rev-parse', '--show-object-format'), 'sha256');
  assert.equal(await git(workspace.path, 'rev-parse', 'HEAD'), repo.baseSha);
  assert.deepEqual(await taskGit.checkFinish(taskId), {
    ok: true, commit: repo.baseSha, base: repo.baseSha, expectedHead: repo.baseSha, unchanged: true,
  });

  // A commit on the Task branch is handed off and verified by exact 64-character id.
  await writeFile(join(workspace.path, 'notes.txt'), 'task work\n');
  await run('git', ['add', 'notes.txt'], { cwd: workspace.path });
  await run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'task work'], { cwd: workspace.path });
  const head = await git(workspace.path, 'rev-parse', 'HEAD');
  assert.equal(head.length, 64);
  const missing = await taskGit.checkFinish(taskId);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'handoff_missing');
  await git(workspace.path, 'push', repo.remote, `HEAD:refs/heads/task/${taskId}`);
  const verified = await taskGit.checkFinish(taskId);
  assert.equal(verified.ok, true);
  assert.equal(verified.commit, head);

  // A review of that exact commit opens in a SHA-256 store of its own.
  const reviewId = id();
  const review = await taskGit.prepareReview(reviewId,
    { name: 'sample', remote: repo.remote, base: 'main', handoff: repo.remote },
    { sourceTaskId: taskId, commit: head, baseSha: repo.baseSha, branch: `task/${taskId}`, handoff: repo.remote });
  assert.equal(review.expectedHead, head);
  assert.equal(await git(review.path, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(review.path, 'rev-parse', '--show-object-format'), 'sha256');
  assert.deepEqual(await taskGit.checkFinish(reviewId, { review: { commit: head, baseSha: repo.baseSha, sourceTaskId: taskId } }), {
    ok: true, commit: head, base: repo.baseSha, expectedHead: head, unchanged: true,
    review: { sourceTaskId: taskId, commit: head, baseSha: repo.baseSha, sourceBranch: `task/${taskId}`, sourceHandoff: repo.remote },
  });

  // Only a whole SHA-1 or SHA-256 object id is accepted: a 41-character prefix is not an object id.
  for (const commit of ['a'.repeat(41), 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(80)]) {
    await assert.rejects(
      taskGit.prepareReview(id(), { name: 'sample', remote: repo.remote, base: 'main' },
        { sourceTaskId: taskId, commit, baseSha: repo.baseSha }),
      error => error.code === 'invalid_review',
      `commit ${commit.length} characters`,
    );
  }
  assert.equal(await git(workspace.mirror, 'rev-parse', '--show-object-format'), 'sha256');
  // The private seed namespace is unchanged: the store holds only this Task's branch, seeded refs under refs/manolo, and
  // no writable remote.
  assert.deepEqual((await git(workspace.mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).split('\n').filter(Boolean),
    [`refs/heads/task/${taskId}`]);
  assert.match(await git(workspace.mirror, 'for-each-ref', '--format=%(refname)', 'refs/manolo/'), /refs\/manolo\/seed\/origin\/main/);
  await assert.rejects(git(workspace.mirror, 'remote', 'get-url', 'origin'), /No such remote/);
});
