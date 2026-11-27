import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const TASK_ID = /^[0-9a-f]{32}$/;
const BRANCH = /^(?:task|review)\/[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{40,64}$/;
const BASE = /^[A-Za-z0-9._/-]{1,128}$/;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

const failure = (code, message) => Object.assign(new Error(message), { code, taskGit: true });

// A configured remote is a value, never a shell string: every git call passes argv directly and disables prompts.
async function git(args, cwd) {
  try {
    const { stdout } = await exec('git', args, {
      cwd, maxBuffer: MAX_GIT_OUTPUT, timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' },
    });
    return stdout;
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? '').trim().split('\n').slice(-1)[0];
    throw failure('git_failed', detail ? `git ${args[0]} failed: ${detail}` : `git ${args[0]} failed.`);
  }
}

const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * Per-Task Git state. Repositories are operator-managed: a Blueprint pins a repository configuration snapshot, never a
 * model-supplied URL or cwd. Short admin operations (fetch, worktree add/remove) serialize; Task runs never do.
 *
 * The shared bare mirror is only an object store. No named push remote is stored there: two Tasks in one repository
 * must not be able to rewrite each other's handoff destination. The handoff remote travels in each Task's metadata and
 * instructions, and finish verifies it read-only.
 */
export function openTaskGit({ dataDir }) {
  const root = resolve(dataDir);
  const reposDir = join(root, 'task-repos');
  const worktreesDir = join(root, 'task-worktrees');
  const scratchDir = join(root, 'task-workspaces');
  let queue = Promise.resolve();

  function withLock(run) {
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  const metaPath = taskId => join(worktreesDir, `${taskId}.json`);
  const worktreePath = taskId => join(worktreesDir, taskId);
  const scratchPath = taskId => join(scratchDir, taskId);

  async function readMeta(taskId) {
    try { return JSON.parse(await readFile(metaPath(taskId), 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw failure('invalid_task_git_state', 'The Task workspace record is unreadable.');
    }
  }

  async function writeMeta(taskId, value) {
    await mkdir(dirname(metaPath(taskId)), { recursive: true, mode: 0o700 });
    const temporary = `${metaPath(taskId)}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, metaPath(taskId));
  }

  // Upgrade a workspace record written by the first candidate without changing its worktree. The old record had no
  // mirror/expectedHead binding; derive them from the persisted remote and base once, then keep the stronger form.
  async function normalizeMeta(meta) {
    if (!meta || meta.kind !== 'worktree' || (meta.version === 2 && meta.mirror && meta.remoteHash && meta.expectedHead)) return meta;
    if (typeof meta.remote !== 'string' || typeof meta.baseSha !== 'string') {
      throw failure('invalid_task_git_state', 'The Task worktree record cannot be upgraded safely.');
    }
    const next = {
      ...meta, version: 2, mirror: meta.mirror ?? mirrorPath({ remote: meta.remote }),
      remoteHash: meta.remoteHash ?? hash(meta.remote), expectedHead: meta.expectedHead ?? meta.baseSha,
    };
    if (next.path !== meta.path || next.branch !== meta.branch) throw failure('invalid_task_git_state', 'The Task worktree record is inconsistent.');
    await writeMeta(meta.taskId, next);
    return next;
  }

  function validateRepo(repository) {
    if (!repository || typeof repository !== 'object' || typeof repository.remote !== 'string' ||
        typeof repository.base !== 'string' || !BASE.test(repository.base) || repository.base.includes('..') ||
        (repository.handoff !== undefined && typeof repository.handoff !== 'string')) {
      throw failure('invalid_repository', 'The Blueprint repository configuration is invalid.');
    }
    return repository;
  }

  function mirrorPath(repository) {
    return join(reposDir, `${hash(repository.remote).slice(0, 16)}.git`);
  }

  async function mirrorFor(repository) {
    const path = mirrorPath(repository);
    await mkdir(reposDir, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) await git(['clone', '--bare', '--', repository.remote, path], reposDir);
    // Fetch into remote-tracking refs only. Task branches live in refs/heads and are never pruned by a fetch.
    await git(['fetch', '--force', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], path);
    const sha = (await git(['rev-parse', '--verify', `refs/remotes/origin/${repository.base}^{commit}`], path)).trim();
    if (!SHA.test(sha)) throw failure('repository_base_missing', `The base branch ${repository.base} has no commit.`);
    return { path, sha };
  }

  // A worktree proves its identity, not just its path: the recorded mirror, branch and toplevel must all agree. A
  // replacement empty directory, another repository's worktree, or a switched branch is a recoverable loss.
  async function verifyWorktree(meta) {
    if (!meta || meta.kind !== 'worktree') throw failure('worktree_missing', 'The Task workspace record is missing.');
    const path = resolve(meta.path);
    if (!existsSync(path)) throw failure('worktree_missing', 'The Task worktree is missing. Its work cannot be recovered automatically.');
    let top;
    let common;
    let branch;
    try {
      top = (await git(['rev-parse', '--show-toplevel'], path)).trim();
      common = (await git(['rev-parse', '--git-common-dir'], path)).trim();
      branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], path)).trim();
    } catch {
      throw failure('worktree_missing', 'The Task path exists but is not the recorded Git worktree.');
    }
    const commonPath = isAbsolute(common) ? resolve(common) : resolve(path, common);
    if (resolve(top) !== path || resolve(commonPath) !== resolve(meta.mirror) || branch !== meta.branch ||
        meta.remoteHash !== hash(meta.remote)) {
      throw failure('worktree_missing', 'The Task worktree identity does not match the recorded worktree.');
    }
    return meta;
  }

  async function prepare(taskId, repository) {
    if (!TASK_ID.test(taskId)) throw failure('invalid_task', 'Invalid Task ID.');
    repository = validateRepo(repository);
    return withLock(async () => {
      const existing = await readMeta(taskId);
      if (existing) {
        if (existing.kind !== 'worktree') {
          throw failure('worktree_missing', 'The Task workspace is preserved or cleaned and cannot be reused automatically.');
        }
        return verifyWorktree(await normalizeMeta(existing));
      }
      const path = worktreePath(taskId);
      if (existsSync(path)) {
        throw failure('worktree_missing', 'A Task worktree exists without its record. It was left untouched for recovery.');
      }
      const mirror = await mirrorFor(repository);
      const branch = `task/${taskId}`;
      await mkdir(worktreesDir, { recursive: true, mode: 0o700 });
      await git(['worktree', 'add', '-B', branch, path, mirror.sha], mirror.path);
      const meta = {
        version: 2, kind: 'worktree', taskId, path, branch, baseSha: mirror.sha, expectedHead: mirror.sha,
        mirror: mirror.path, remote: repository.remote, remoteHash: hash(repository.remote), base: repository.base,
        ...(repository.handoff && { handoff: repository.handoff }),
        repository: repository.name,
        createdAt: new Date().toISOString(),
      };
      await writeMeta(taskId, meta);
      return verifyWorktree(meta);
    });
  }

  // A review Task gets its own worktree at the exact handed-off commit. It never checks out a mutable branch tip.
  async function prepareReview(taskId, repository, review) {
    if (!TASK_ID.test(taskId)) throw failure('invalid_task', 'Invalid Task ID.');
    repository = validateRepo(repository);
    if (!review || typeof review !== 'object' || !SHA.test(review.commit ?? '') || !SHA.test(review.baseSha ?? '') ||
        typeof review.sourceTaskId !== 'string' || !TASK_ID.test(review.sourceTaskId)) {
      throw failure('invalid_review', 'The review binding needs a Task, exact commit, and comparison base.');
    }
    return withLock(async () => {
      const existing = await readMeta(taskId);
      if (existing) {
        if (existing.kind !== 'worktree') throw failure('worktree_missing', 'The Task workspace is preserved or cleaned and cannot be reused automatically.');
        return verifyWorktree(await normalizeMeta(existing));
      }
      const path = worktreePath(taskId);
      if (existsSync(path)) throw failure('worktree_missing', 'A Task worktree exists without its record. It was left untouched for recovery.');
      const mirror = await mirrorFor(repository);
      try {
        await git(['cat-file', '-e', `${review.commit}^{commit}`], mirror.path);
      } catch {
        if (!repository.handoff) throw failure('review_commit_missing', 'The review commit is not in the mirror and no handoff remote is configured.');
        await git(['fetch', '--force', repository.handoff, '+refs/heads/*:refs/remotes/handoff/*'], mirror.path);
        try { await git(['cat-file', '-e', `${review.commit}^{commit}`], mirror.path); } catch {
          throw failure('review_commit_missing', 'The exact review commit is not available from the configured handoff remote.');
        }
      }
      const branch = `review/${taskId}`;
      await mkdir(worktreesDir, { recursive: true, mode: 0o700 });
      await git(['worktree', 'add', '-B', branch, path, review.commit], mirror.path);
      const meta = {
        version: 2, kind: 'worktree', taskId, path, branch, baseSha: review.baseSha, expectedHead: review.commit,
        mirror: mirror.path, remote: repository.remote, remoteHash: hash(repository.remote), base: repository.base,
        ...(repository.handoff && { handoff: repository.handoff }),
        repository: repository.name,
        review: { sourceTaskId: review.sourceTaskId, commit: review.commit, baseSha: review.baseSha },
        createdAt: new Date().toISOString(),
      };
      await writeMeta(taskId, meta);
      return verifyWorktree(meta);
    });
  }

  async function prepareScratch(taskId) {
    if (!TASK_ID.test(taskId)) throw failure('invalid_task', 'Invalid Task ID.');
    return withLock(async () => {
      const existing = await readMeta(taskId);
      const path = scratchPath(taskId);
      if (existing) {
        if (existing.kind !== 'scratch') throw failure('worktree_missing', 'The Task workspace is preserved or cleaned and cannot be reused automatically.');
        if (!existsSync(existing.path)) throw failure('worktree_missing', 'The Task workspace is missing. It was not recreated.');
        return existing;
      }
      if (existsSync(path)) throw failure('worktree_missing', 'A Task workspace exists without its record. It was left untouched for recovery.');
      await mkdir(path, { recursive: true, mode: 0o700 });
      const meta = { version: 2, kind: 'scratch', taskId, path, createdAt: new Date().toISOString() };
      await writeMeta(taskId, meta);
      return meta;
    });
  }

  // Resume/retry and every Task tool: the workspace must still be the recorded one. It is never recreated here.
  async function assertWorkspace(taskId) {
    const meta = await readMeta(taskId);
    if (!meta) throw failure('worktree_missing', 'The Task workspace record is missing; its work cannot be recovered automatically.');
    if (meta.kind === 'cleaned') throw failure('worktree_missing', 'This Task workspace was cleaned after a terminal outcome.');
    if (meta.kind === 'preserved') throw failure('worktree_missing', `This Task workspace was preserved for recovery: ${meta.preserveReason ?? 'local work'}.`);
    if (meta.kind === 'scratch') {
      if (!existsSync(meta.path)) throw failure('worktree_missing', 'The Task workspace is missing; it was not recreated.');
      return meta;
    }
    return verifyWorktree(await normalizeMeta(meta));
  }

  async function status(meta) {
    if (meta.kind !== 'worktree') return { dirty: false, files: [] };
    const output = await git(['status', '--porcelain=v1', '--untracked-files=all'], meta.path);
    const files = output.split('\n').map(line => line.trim()).filter(Boolean);
    return { dirty: files.length > 0, files: files.slice(0, 20) };
  }

  async function remoteHandoff(meta, head) {
    if (!meta.handoff || !BRANCH.test(meta.branch)) return false;
    try {
      const remote = (await git(['ls-remote', '--exit-code', meta.handoff, `refs/heads/${meta.branch}`], meta.path)).trim();
      return remote.split(/\s+/)[0] === head;
    } catch {
      return false;
    }
  }

  // Read-only. Never commits, pushes, resets, or removes anything.
  async function checkFinish(taskId) {
    const meta = await assertWorkspace(taskId);
    if (meta.kind !== 'worktree') return { ok: true, base: null };
    const state = await status(meta);
    if (state.dirty) {
      return {
        ok: false, code: 'dirty_worktree',
        message: `The worktree has uncommitted or untracked work (${state.files.join(', ')}). Commit or remove it, then call finish again.`,
      };
    }
    const head = (await git(['rev-parse', 'HEAD'], meta.path)).trim();
    if (head === meta.expectedHead) {
      return { ok: true, commit: head, base: meta.baseSha, expectedHead: meta.expectedHead, unchanged: true, ...(meta.review && { review: meta.review }) };
    }
    if (!meta.handoff) {
      return {
        ok: false, code: 'handoff_required',
        message: `This Task has commits beyond ${meta.expectedHead.slice(0, 12)} but its repository has no handoff remote. Push the commit to a configured handoff remote on branch ${meta.branch}, then call finish again.`,
      };
    }
    if (!BRANCH.test(meta.branch)) throw failure('invalid_branch', 'The Task branch is not a scoped Task branch.');
    let remote;
    try {
      remote = (await git(['ls-remote', '--exit-code', meta.handoff, `refs/heads/${meta.branch}`], meta.path)).trim();
    } catch {
      return {
        ok: false, code: 'handoff_missing',
        message: `Branch ${meta.branch} is not on the handoff remote. Push ${head} to ${meta.handoff}, then call finish again.`,
      };
    }
    const sha = remote.split(/\s+/)[0];
    if (sha !== head) {
      return {
        ok: false, code: 'handoff_mismatch',
        message: `The handoff branch ${meta.branch} points at ${sha?.slice(0, 12) ?? 'nothing'}, not ${head.slice(0, 12)}. Push the exact commit, then call finish again.`,
      };
    }
    return {
      ok: true, commit: head, base: meta.baseSha, expectedHead: meta.expectedHead,
      branch: meta.branch, handoff: meta.handoff, ...(meta.review && { review: meta.review }),
    };
  }

  // Called only after relay-confirmed terminal state. Dirty, detached, or unhanded work is preserved with recovery data.
  // `successful` means the relay confirmed a finished Task; even then, only a verified handoff or untouched tree is removed.
  async function cleanup(taskId, { terminal = false, successful = false } = {}) {
    if (!terminal) return { removed: false, reason: 'not_terminal' };
    return withLock(async () => {
      let meta = await readMeta(taskId);
      if (!meta) return { removed: false, reason: 'no_workspace' };
      if (meta.kind === 'worktree') meta = await normalizeMeta(meta);
      const preserve = (reason, extra = {}) => writeMeta(taskId, {
        ...meta, kind: 'preserved', preserveReason: reason, preservedAt: new Date().toISOString(), ...extra,
      }).then(() => ({ removed: false, reason, ...extra }));
      if (meta.kind === 'scratch') {
        if (!existsSync(meta.path)) {
          await writeMeta(taskId, { ...meta, kind: 'cleaned', previousKind: 'scratch', at: new Date().toISOString() });
          return { removed: true, reason: 'already_missing' };
        }
        if ((await readdir(meta.path)).length > 0) return { removed: false, reason: 'local_work_preserved' };
        await rmdir(meta.path);
        await writeMeta(taskId, { ...meta, kind: 'cleaned', previousKind: 'scratch', at: new Date().toISOString() });
        return { removed: true };
      }
      if (meta.kind === 'cleaned' || meta.kind === 'preserved') return { removed: false, reason: meta.preserveReason ?? meta.kind };
      if (!existsSync(meta.path)) return preserve('worktree_missing', { preservedHead: null });
      let common;
      try {
        common = (await git(['rev-parse', '--git-common-dir'], meta.path)).trim();
      } catch {
        return preserve('identity_mismatch', { preservedHead: null });
      }
      const commonPath = isAbsolute(common) ? resolve(common) : resolve(meta.path, common);
      if (resolve(commonPath) !== resolve(meta.mirror)) return preserve('identity_mismatch', { preservedHead: null });
      let head;
      try {
        head = (await git(['rev-parse', 'HEAD'], meta.path)).trim();
      } catch {
        return preserve('identity_mismatch', { preservedHead: null });
      }
      let branch;
      try {
        branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], meta.path)).trim();
      } catch {
        return preserve('detached_or_switched_branch', { preservedHead: head, preservedBranch: null, handoff: meta.handoff ?? null });
      }
      const state = await status(meta);
      if (state.dirty) return preserve('dirty_worktree', { preservedHead: head, preservedBranch: branch, files: state.files });
      const handedOff = await remoteHandoff(meta, head).catch(() => false);
      const safe = head === meta.expectedHead || (successful && handedOff);
      if (!safe) {
        const reason = branch !== meta.branch ? 'detached_or_switched_branch' : 'unhanded_work';
        return preserve(reason, { preservedHead: head, preservedBranch: branch, handoff: meta.handoff ?? null });
      }
      const mirror = meta.mirror;
      if (existsSync(mirror)) await git(['worktree', 'remove', meta.path], mirror);
      else await rm(meta.path, { recursive: true, force: false });
      await writeMeta(taskId, {
        ...meta, kind: 'cleaned', previousKind: 'worktree', previousHead: head, previousBranch: branch,
        successful, at: new Date().toISOString(),
      });
      return { removed: true };
    });
  }

  return { prepare, prepareReview, prepareScratch, assertWorkspace, checkFinish, cleanup, status, readMeta, verifyWorktree };
}
