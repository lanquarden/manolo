import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const TASK_ID = /^[0-9a-f]{32}$/;
const BRANCH = /^task\/[0-9a-f]{32}$/;
const BASE = /^[A-Za-z0-9._/-]{1,128}$/;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

const failure = (code, message) => Object.assign(new Error(message), { code, taskGit: true });

// A configured remote is a value, never a shell string: every git call passes argv directly and disables prompts. A
// Task branch is always task/<task id>, so a Task can never be told to push to main or to another Task's branch.
async function git(args, cwd) {
  try {
    const { stdout, stderr } = await exec('git', args, {
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

/**
 * Per-Task Git state. Repositories are operator-managed: a Blueprint pins a repository configuration snapshot, never a
 * model-supplied URL or cwd. Short admin operations (fetch, worktree add/remove) serialize; Task runs never do.
 */
export function openTaskGit({ dataDir }) {
  const root = resolve(dataDir);
  const reposDir = join(root, 'task-repos');
  const worktreesDir = join(root, 'task-worktrees');
  const scratchDir = join(root, 'task-workspaces');
  let queue = Promise.resolve();

  // Serialize only this process's short repository administration, so two Tasks in one repository cannot interleave
  // fetch/worktree-add. A Task's model, shell and tests run outside this lock.
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

  function validateRepo(repository) {
    if (!repository || typeof repository !== 'object' || typeof repository.remote !== 'string' ||
        typeof repository.base !== 'string' || !BASE.test(repository.base) || repository.base.includes('..') ||
        (repository.handoff !== undefined && typeof repository.handoff !== 'string')) {
      throw failure('invalid_repository', 'The Blueprint repository configuration is invalid.');
    }
    return repository;
  }

  async function mirrorFor(repository) {
    const name = hash(repository.remote).slice(0, 16);
    const path = join(reposDir, `${name}.git`);
    await mkdir(reposDir, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      await git(['clone', '--bare', '--', repository.remote, path], reposDir);
    }
    // Fetch into remote-tracking refs only. A Task branch lives in refs/heads and is never pruned by a fetch.
    await git(['fetch', '--force', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], path);
    const sha = (await git(['rev-parse', '--verify', `refs/remotes/origin/${repository.base}^{commit}`], path)).trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw failure('repository_base_missing', `The base branch ${repository.base} has no commit.`);
    return { path, sha };
  }

  async function prepare(taskId, repository) {
    if (!TASK_ID.test(taskId)) throw failure('invalid_task', 'Invalid Task ID.');
    repository = validateRepo(repository);
    return withLock(async () => {
      const existing = await readMeta(taskId);
      if (existing) {
        if (existing.kind === 'cleaned') throw failure('worktree_missing', 'This Task worktree was cleaned after a terminal outcome. It is not recreated.');
        if (existing.kind !== 'worktree') throw failure('worktree_missing', 'The Task workspace record is not a repository worktree.');
        if (!existsSync(existing.path)) {
          // Never recreate it: that could discard local-only work the owner still needs to recover.
          throw failure('worktree_missing', 'The Task worktree is missing. Its work cannot be recovered automatically.');
        }
        return existing;
      }
      const path = worktreePath(taskId);
      if (existsSync(path)) {
        // A directory without a record is ambiguous. Preserve it and ask for recovery instead of deleting work.
        throw failure('worktree_missing', 'A Task worktree exists without its record. It was left untouched for recovery.');
      }
      const mirror = await mirrorFor(repository);
      const branch = `task/${taskId}`;
      await mkdir(worktreesDir, { recursive: true, mode: 0o700 });
      await git(['worktree', 'add', '-B', branch, path, mirror.sha], mirror.path);
      // A named handoff remote (validated as owned at bundle load) lets the child push its scoped branch without
      // inventing a URL or touching the source remote.
      if (repository.handoff) {
        const remotes = (await git(['remote'], mirror.path)).split('\n').map(name => name.trim());
        if (remotes.includes('handoff')) await git(['remote', 'set-url', 'handoff', repository.handoff], mirror.path);
        else await git(['remote', 'add', 'handoff', repository.handoff], mirror.path);
      }
      const meta = {
        kind: 'worktree', taskId, path, branch, baseSha: mirror.sha,
        remote: repository.remote, base: repository.base,
        ...(repository.handoff && { handoff: repository.handoff }),
        repository: repository.name,
        createdAt: new Date().toISOString(),
      };
      await writeMeta(taskId, meta);
      return meta;
    });
  }

  // A Task without a repository still gets its own directory: file and shell tools never fall back to the shared worker
  // workspace, so two Tasks cannot read or overwrite each other's files by accident.
  async function prepareScratch(taskId) {
    if (!TASK_ID.test(taskId)) throw failure('invalid_task', 'Invalid Task ID.');
    return withLock(async () => {
      const existing = await readMeta(taskId);
      const path = scratchPath(taskId);
      if (existing) {
        if (existing.kind === 'cleaned') throw failure('worktree_missing', 'This Task workspace was cleaned after a terminal outcome. It is not recreated.');
        if (existing.kind !== 'scratch') throw failure('worktree_missing', 'The Task workspace record is not a scratch workspace.');
        if (!existsSync(existing.path)) throw failure('worktree_missing', 'The Task workspace is missing. It was not recreated.');
        return existing;
      }
      if (existsSync(path)) throw failure('worktree_missing', 'A Task workspace exists without its record. It was left untouched for recovery.');
      await mkdir(path, { recursive: true, mode: 0o700 });
      const meta = { kind: 'scratch', taskId, path, createdAt: new Date().toISOString() };
      await writeMeta(taskId, meta);
      return meta;
    });
  }

  // Resume/retry: the workspace must still be the one this execution recorded. It is never recreated here.
  async function assertWorkspace(taskId) {
    const meta = await readMeta(taskId);
    if (!meta || meta.kind === 'cleaned' || !existsSync(meta.path)) {
      throw failure('worktree_missing', 'The Task workspace is missing; its work cannot be recovered automatically.');
    }
    return meta;
  }

  async function status(meta) {
    if (meta.kind !== 'worktree') return { dirty: false, files: [] };
    const output = await git(['status', '--porcelain=v1', '--untracked-files=all'], meta.path);
    const files = output.split('\n').map(line => line.trim()).filter(Boolean);
    return { dirty: files.length > 0, files: files.slice(0, 20) };
  }

  // Read-only. A dirty worktree, an unverified commit, or a missing handoff is an actionable refusal for the model; the
  // check never commits, pushes, resets, or removes anything.
  async function checkFinish(taskId) {
    const meta = await readMeta(taskId);
    if (!meta) throw failure('worktree_missing', 'This Task has no workspace record. Finish is blocked until it is recovered.');
    if (meta.kind === 'cleaned') throw failure('worktree_missing', 'This Task workspace was cleaned after a terminal outcome.');
    if (meta.kind !== 'worktree') return { ok: true };
    const state = await status(meta);
    if (state.dirty) {
      return {
        ok: false, code: 'dirty_worktree',
        message: `The worktree has uncommitted or untracked work (${state.files.join(', ')}). Commit or remove it, then call finish again.`,
      };
    }
    const head = (await git(['rev-parse', 'HEAD'], meta.path)).trim();
    if (head === meta.baseSha) return { ok: true, commit: head, unchanged: true };
    if (!meta.handoff) {
      return {
        ok: false, code: 'handoff_required',
        message: `This Task has commits beyond ${meta.baseSha.slice(0, 12)} but its repository has no handoff remote. Push the commit to a configured handoff remote on branch ${meta.branch}, then call finish again.`,
      };
    }
    if (!BRANCH.test(meta.branch)) throw failure('invalid_branch', 'The Task branch is not a scoped Task branch.');
    let remote;
    try {
      remote = (await git(['ls-remote', '--exit-code', meta.handoff, `refs/heads/${meta.branch}`], meta.path)).trim();
    } catch {
      return {
        ok: false, code: 'handoff_missing',
        message: `Branch ${meta.branch} is not on the handoff remote. Push ${head} there from this worktree, then call finish again.`,
      };
    }
    const sha = remote.split(/\s+/)[0];
    if (sha !== head) {
      return {
        ok: false, code: 'handoff_mismatch',
        message: `The handoff branch ${meta.branch} points at ${sha?.slice(0, 12) ?? 'nothing'}, not ${head.slice(0, 12)}. Push the exact commit, then call finish again.`,
      };
    }
    return { ok: true, commit: head, branch: meta.branch, handoff: meta.handoff };
  }

  // Called only after a Task is terminal. Dirty or local-only work is preserved; a paused or running Task is never
  // cleaned. Removing a clean worktree leaves its Task branch in the mirror repository for recovery.
  async function cleanup(taskId, { terminal = false } = {}) {
    if (!terminal) return { removed: false, reason: 'not_terminal' };
    return withLock(async () => {
      const meta = await readMeta(taskId);
      if (!meta) return { removed: false, reason: 'no_workspace' };
      if (meta.kind === 'scratch') {
        // A scratch Task has no Git history, so any file may be the only copy of local work. Remove only an empty
        // directory; anything else is preserved for the owner.
        if (!existsSync(meta.path)) {
          await writeMeta(taskId, { kind: 'cleaned', taskId, previousKind: 'scratch', at: new Date().toISOString() });
          return { removed: true, reason: 'already_missing' };
        }
        if ((await readdir(meta.path)).length > 0) return { removed: false, reason: 'local_work_preserved' };
        await rmdir(meta.path);
        await writeMeta(taskId, { kind: 'cleaned', taskId, previousKind: 'scratch', at: new Date().toISOString() });
        return { removed: true };
      }
      const state = await status(meta);
      if (state.dirty) return { removed: false, reason: 'dirty_worktree', files: state.files };
      const mirrorName = hash(meta.remote).slice(0, 16);
      const mirror = join(reposDir, `${mirrorName}.git`);
      if (existsSync(mirror)) await git(['worktree', 'remove', meta.path], mirror);
      else await rm(meta.path, { recursive: true, force: false });
      await writeMeta(taskId, { kind: 'cleaned', taskId, previousKind: 'worktree', branch: meta.branch,
        baseSha: meta.baseSha, at: new Date().toISOString() });
      return { removed: true };
    });
  }

  return { prepare, prepareScratch, assertWorkspace, checkFinish, cleanup, status, readMeta };
}
