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
  assert.equal(upgraded.version, 3);
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
