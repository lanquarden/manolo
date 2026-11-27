import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isSafeBranch } from './work-blueprints.mjs';

const exec = promisify(execFile);
const TASK_ID = /^[0-9a-f]{32}$/;
const BRANCH = /^(?:task|review)\/[0-9a-f]{32}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
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
// `symbolic-ref --short` cannot shorten a branch that shares its name with a tag and then reports `heads/task/<id>`.
// Identity is therefore compared on the full ref; the shortened form is only kept as human recovery metadata.
const branchRef = branch => `refs/heads/${branch}`;
const shortRef = ref => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref.replace(/^refs\//, ''));

/**
 * Per-Task Git state. Repositories are operator-managed: a Blueprint pins a repository configuration snapshot, never a
 * model-supplied URL or cwd. Short admin operations (fetch, worktree add/remove) serialize; Task runs never do.
 *
 * There are two kinds of Git directory here. The shared seed mirror (`<remote hash>.git`) is a read-only object store:
 * it is fetched, never checked out, and carries no Task remote. Every Task then gets its own persistent bare store under
 * `task-<task id>.git`, seeded with objects and only the refs this service fetched from the configured remote (under a
 * private namespace), never with a clone that would inherit another Task's branches or a writable `origin`. The Task
 * worktree is attached to its own store, so `git stash`, refs, hooks, and config are per Task: two Tasks in one
 * repository cannot read or rewrite each other's stash entries or push destination. A record written before per-Task
 * stores keeps its original shared mirror and worktree in place; it is adopted only after that mirror registration is
 * proven, and never moved or rewritten to gain isolation, because that would lose data.
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

  // Upgrade a workspace record written by an earlier candidate without changing its worktree. The legacy layout attached
  // every worktree to the shared, service-owned mirror for its remote, so that mirror is derived from the recorded remote
  // and then proven: the path's Git common dir must be exactly it, the worktree must be registered in it at the recorded
  // path, and HEAD must still be the recorded branch. Nothing is observed-and-adopted and nothing is written until all of
  // that holds, so a replacement clone that happens to sit at the old path fails closed with the old record untouched.
  async function normalizeMeta(meta) {
    if (!meta || meta.kind !== 'worktree' || (meta.version === 3 && meta.mirror && meta.remoteHash && meta.expectedHead)) return meta;
    if (typeof meta.remote !== 'string' || typeof meta.baseSha !== 'string' || !SHA.test(meta.baseSha) ||
        typeof meta.path !== 'string' || typeof meta.branch !== 'string' || !isSafeBranch(meta.branch)) {
      throw failure('invalid_task_git_state', 'The Task worktree record cannot be upgraded safely.');
    }
    const next = {
      ...meta, version: 3,
      mirror: meta.mirror ?? seedPath({ remote: meta.remote }),
      remoteHash: hash(meta.remote),
      expectedHead: meta.expectedHead ?? meta.baseSha,
      // The legacy layout's seed is the same shared mirror the worktree is attached to.
      seed: meta.seed ?? meta.mirror ?? seedPath({ remote: meta.remote }),
    };
    if (next.path !== meta.path || next.branch !== meta.branch || next.remoteHash !== hash(next.remote)) {
      throw failure('invalid_task_git_state', 'The Task worktree record is inconsistent.');
    }
    if (typeof next.mirror !== 'string' || !inside(resolve(next.mirror), reposDir) ||
        typeof next.seed !== 'string' || !inside(resolve(next.seed), reposDir)) {
      throw failure('invalid_task_git_state', 'The Task worktree record names a Git store outside this service.');
    }
    await proveSharedMirrorWorktree(next);
    await writeMeta(meta.taskId, next);
    return next;
  }

  // A pre-seed worktree is proven by its registration in the shared mirror the service itself created for that remote.
  async function proveSharedMirrorWorktree(meta) {
    const mirror = resolve(meta.mirror);
    if (!existsSync(mirror) || !existsSync(meta.path)) {
      throw failure('worktree_missing', 'The recorded Task worktree or its shared mirror is missing; it was not recreated.');
    }
    let top;
    let common;
    let ref;
    try {
      top = (await git(['rev-parse', '--show-toplevel'], meta.path)).trim();
      common = (await git(['rev-parse', '--git-common-dir'], meta.path)).trim();
      ref = (await git(['symbolic-ref', '--quiet', 'HEAD'], meta.path)).trim();
    } catch {
      throw failure('worktree_missing', 'The Task path exists but is not the recorded Git worktree.');
    }
    const commonPath = isAbsolute(common) ? resolve(common) : resolve(meta.path, common);
    if (resolve(top) !== resolve(meta.path) || commonPath !== mirror || ref !== branchRef(meta.branch)) {
      throw failure('worktree_missing', 'The Task worktree is not the worktree the recorded shared mirror owns.');
    }
    // Compare against the toplevel Git itself reports (already canonicalized) so a symlinked ancestor cannot make a
    // genuine record look foreign.
    const listing = await git(['worktree', 'list', '--porcelain'], mirror);
    const registered = listing.split('\n').some(line => line === `worktree ${resolve(top)}`);
    if (!registered) throw failure('worktree_missing', 'The Task worktree is not registered in its recorded shared mirror.');
    return meta;
  }

  function validateRepo(repository) {
    if (!repository || typeof repository !== 'object' || typeof repository.remote !== 'string' ||
        !isSafeBranch(repository.base) ||
        (repository.handoff !== undefined && typeof repository.handoff !== 'string')) {
      throw failure('invalid_repository', 'The Blueprint repository configuration is invalid.');
    }
    return repository;
  }

  function seedPath(repository) {
    return join(reposDir, `${hash(repository.remote).slice(0, 16)}.git`);
  }

  const taskMirrorPath = taskId => join(reposDir, `task-${taskId}.git`);

  // Object IDs are not interchangeable between hashes, and a fetch refuses to cross formats. A Task's own store therefore
  // inherits the object format of the seed it is built from rather than defaulting to SHA-1 and failing every fetch from a
  // SHA-256 repository.
  async function objectFormat(path) {
    const format = (await git(['rev-parse', '--show-object-format'], path)).trim();
    if (format !== 'sha1' && format !== 'sha256') {
      throw failure('git_failed', 'The Task repository uses an unsupported object format.');
    }
    return format;
  }

  // The shared store is fetched only through remote-tracking refs. Task branches live in each Task's own store, so a
  // fetch in one Task can never prune or rewrite another Task's branch, stash, or config.
  async function seedFor(repository, { tolerant = false } = {}) {
    const path = seedPath(repository);
    await mkdir(reposDir, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      await git(['clone', '--bare', '--', repository.remote, path], reposDir);
      // A fresh bare clone maps the remote's own branches to local heads. Record exactly those as the proven
      // remote-tracking set, so a Task seed still has a defined source if the first fetch is refused or deferred.
      await seedProvenRefs(path);
    }
    try {
      await git(['fetch', '--force', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], path);
    } catch (error) {
      // A review is bound to exact commits that may already be present locally; an unreachable upstream is not fatal
      // there. A new Task still needs its base branch, so it fails as before.
      if (!tolerant) throw error;
    }
    return path;
  }

  // `refs/remotes/origin/*` is the only ref namespace a shared store proves: it is what this service fetched from the
  // configured remote. Anything else the directory holds (an old Task branch pushed into a previous shared mirror, a tag,
  // a stash) is not content the remote vouched for and is never used to seed another Task.
  const SEED_REFS = '+refs/remotes/origin/*:refs/manolo/seed/origin/*';

  async function seedProvenRefs(path) {
    const output = await git(['for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/heads/'], path);
    for (const line of output.split('\n')) {
      const [name, sha] = line.trim().split(' ');
      if (!name || !SHA.test(sha ?? '')) continue;
      await git(['update-ref', `refs/remotes/origin/${name}`, sha], path);
    }
  }

  async function seedBase(path, base) {
    const sha = (await git(['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`], path)).trim();
    if (!SHA.test(sha)) throw failure('repository_base_missing', `The base branch ${base} has no commit.`);
    return sha;
  }

  async function hasCommit(path, sha) {
    try { await git(['cat-file', '-e', `${sha}^{commit}`], path); return true; } catch { return false; }
  }

  /**
   * Seed a Task's own Git store from the shared object store: objects only, plus the proven remote-tracking refs under a
   * private namespace. There is deliberately no `git clone`: a bare clone of a shared mirror would inherit every local
   * branch that mirror holds (other Tasks' unpublished work) and would leave `origin` pointing at a writable shared
   * directory, so a routine `git push --all` could publish another Task's refs. The new store has no remote at all, and
   * only refs this service fetched from the configured remote become reachable. Immutable pack files are hardlinked so
   * seeding stays cheap; a missing or unlinkable pack is copied, and the fetch transfers anything not already present.
   */
  async function taskMirror(taskId, seed, { tolerant = false } = {}) {
    const path = taskMirrorPath(taskId);
    if (existsSync(path)) return path;
    await mkdir(reposDir, { recursive: true, mode: 0o700 });
    await git(['init', '--bare', '--quiet', `--object-format=${await objectFormat(seed)}`, '--', path], reposDir);
    await linkSeedPacks(seed, path);
    try {
      await git(['fetch', '--no-tags', '--force', '--', seed, SEED_REFS], path);
    } catch (error) {
      // A review can still be opened from objects that are already local, and a missing pinned object is reported by the
      // caller instead of being replaced by a tip. A new Task needs its base branch and fails as before.
      if (!tolerant) throw error;
    }
    return path;
  }

  // Immutable object packs only: hardlink when possible, copy otherwise. No ref, hook, stash, or config is inherited.
  async function linkSeedPacks(seed, path) {
    const from = join(seed, 'objects', 'pack');
    const to = join(path, 'objects', 'pack');
    let entries;
    try { entries = await readdir(from, { withFileTypes: true }); } catch { return; }
    await mkdir(to, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      // A `.keep` protects a pack from repacking and a `.promisor` marks objects a partial clone would fetch later; a Task
      // store has no remote to fetch from, so neither travels with the seeded objects.
      if (!entry.isFile() || entry.name.endsWith('.keep') || entry.name.endsWith('.promisor')) continue;
      const target = join(to, entry.name);
      try {
        await link(join(from, entry.name), target);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        // A different filesystem cannot share an inode; copying the immutable pack keeps the store self-contained.
        await copyFile(join(from, entry.name), target).catch(() => {});
      }
    }
  }

  /**
   * Bring one exact commit into a Task's store. The sources are proven object stores or the configured handoff, and the
   * object travels under a private ref name: no branch is copied and a tip is never substituted, so a source that cannot
   * serve the exact object is a refusal.
   */
  async function transferCommit(path, sources, sha) {
    if (!SHA.test(sha ?? '')) return false;
    if (await hasCommit(path, sha)) return true;
    for (const source of sources) {
      if (typeof source !== 'string' || source === '') continue;
      try {
        await git(['fetch', '--no-tags', '--force', '--', source, `+${sha}:refs/manolo/pinned/${sha}`], path);
      } catch {
        continue;
      }
      if (await hasCommit(path, sha)) return true;
    }
    return false;
  }

  /**
   * The source Task a review pins, resolved from trusted recorded metadata: its own workspace record in this data
   * directory. The record must still describe the same configured remote and handoff, and its store must be a real Git
   * directory inside this service. It is used as an object source only, so a review of a handed-off commit still opens
   * after the remote branch was rewound or deleted and the shared store no longer advertises it.
   */
  async function reviewSource(review, repository) {
    if (!TASK_ID.test(review.sourceTaskId ?? '')) return undefined;
    let meta;
    try { meta = await readMeta(review.sourceTaskId); } catch { return undefined; }
    if (!meta || meta.taskId !== review.sourceTaskId || typeof meta.remote !== 'string' ||
        meta.remote !== repository.remote) return undefined;
    const remoteHash = meta.remoteHash ?? hash(meta.remote);
    if (remoteHash !== hash(meta.remote)) return undefined;
    if (review.handoff !== undefined && meta.handoff !== review.handoff) return undefined;
    const stores = [];
    for (const candidate of [meta.mirror, meta.seed]) {
      if (typeof candidate !== 'string' || !inside(resolve(candidate), reposDir) || !existsSync(candidate)) continue;
      try { await git(['rev-parse', '--git-dir'], candidate); } catch { continue; }
      stores.push(resolve(candidate));
    }
    if (stores.length === 0) return undefined;
    return { mirror: stores[0], seed: stores[1] };
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
      const seed = await seedFor(repository);
      const baseSha = await seedBase(seed, repository.base);
      const mirror = await taskMirror(taskId, seed);
      const branch = `task/${taskId}`;
      if (!await transferCommit(mirror, [seed], baseSha)) {
        throw failure('repository_base_missing', 'The base commit is not available in the Task mirror.');
      }
      await mkdir(worktreesDir, { recursive: true, mode: 0o700 });
      await git(['worktree', 'add', '-B', branch, path, baseSha], mirror);
      const meta = {
        version: 3, kind: 'worktree', taskId, path, branch, baseSha, expectedHead: baseSha,
        mirror, seed, remote: repository.remote, remoteHash: hash(repository.remote), base: repository.base,
        ...(repository.handoff && { handoff: repository.handoff }),
        repository: repository.name,
        createdAt: new Date().toISOString(),
      };
      await writeMeta(taskId, meta);
      return verifyWorktree(meta);
    });
  }

  // A review Task gets its own worktree at the exact handed-off commit. It never checks out a mutable branch tip, and it
  // does not depend on the current upstream branch: the pinned commit and base are objects, not names. When the remote
  // is unreachable or has moved on, an object already in the store still opens the review.
  async function prepareReview(taskId, repository, review) {
    if (!TASK_ID.test(taskId)) throw failure('invalid_task', 'Invalid Task ID.');
    repository = validateRepo(repository);
    if (!review || typeof review !== 'object' || !SHA.test(review.commit ?? '') || !SHA.test(review.baseSha ?? '') ||
        typeof review.sourceTaskId !== 'string' || !TASK_ID.test(review.sourceTaskId) ||
        (review.branch !== undefined && !isSafeBranch(review.branch)) ||
        (review.handoff !== undefined && typeof review.handoff !== 'string')) {
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
      const seed = await seedFor(repository, { tolerant: true });
      const mirror = await taskMirror(taskId, seed, { tolerant: true });
      // Proven object sources, in order: the source Task's own retained store, its shared store, this repository's seed,
      // then the configured handoff. Only the exact commit and base move, by private ref, so a rewound or deleted remote
      // branch cannot replace the handed-off commit with a newer tip.
      const source = await reviewSource(review, repository);
      const sources = [source?.mirror, source?.seed, seed, review.handoff].filter(store => typeof store === 'string');
      if (!await transferCommit(mirror, sources, review.commit)) {
        throw failure('review_commit_missing', 'The exact review commit is not available from the configured remotes.');
      }
      if (!await transferCommit(mirror, sources, review.baseSha)) {
        throw failure('review_base_missing', 'The review comparison base is not available from the configured remotes.');
      }
      const branch = `review/${taskId}`;
      await mkdir(worktreesDir, { recursive: true, mode: 0o700 });
      await git(['worktree', 'add', '-B', branch, path, review.commit], mirror);
      const meta = {
        version: 3, kind: 'worktree', taskId, path, branch, baseSha: review.baseSha, expectedHead: review.commit,
        mirror, seed, remote: repository.remote, remoteHash: hash(repository.remote), base: repository.base,
        ...(repository.handoff && { handoff: repository.handoff }),
        repository: repository.name,
        review: {
          sourceTaskId: review.sourceTaskId, commit: review.commit, baseSha: review.baseSha,
          ...(review.branch && { sourceBranch: review.branch }),
          ...(review.handoff && { sourceHandoff: review.handoff }),
        },
        createdAt: new Date().toISOString(),
      };
      await writeMeta(taskId, meta);
      return verifyWorktree(meta);
    });
  }

  // A worktree proves its identity, not just its path: the recorded mirror, branch and toplevel must all agree. A
  // replacement empty directory, another repository's worktree, or a switched branch is a recoverable loss.
  async function verifyWorktree(meta) {
    if (!meta || meta.kind !== 'worktree') throw failure('worktree_missing', 'The Task workspace record is missing.');
    const path = resolve(meta.path);
    if (!existsSync(path)) throw failure('worktree_missing', 'The Task worktree is missing. Its work cannot be recovered automatically.');
    let top;
    let common;
    let ref;
    try {
      top = (await git(['rev-parse', '--show-toplevel'], path)).trim();
      common = (await git(['rev-parse', '--git-common-dir'], path)).trim();
      ref = (await git(['symbolic-ref', '--quiet', 'HEAD'], path)).trim();
    } catch {
      throw failure('worktree_missing', 'The Task path exists but is not the recorded Git worktree.');
    }
    const commonPath = isAbsolute(common) ? resolve(common) : resolve(path, common);
    if (resolve(top) !== path || resolve(commonPath) !== resolve(meta.mirror) || ref !== branchRef(meta.branch) ||
        meta.remoteHash !== hash(meta.remote)) {
      throw failure('worktree_missing', 'The Task worktree identity does not match the recorded worktree.');
    }
    return meta;
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

  // `--ignored=matching` is deliberate: a plain porcelain status omits ignored files, so a Task that ran a build (or
  // added a nested `.gitignore`) could look clean and its ignored output would be deleted with the worktree. They are
  // reported, never deleted or moved here.
  async function status(meta) {
    if (meta.kind !== 'worktree') return { dirty: false, files: [], ignored: [], ignoredCount: 0 };
    const output = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], meta.path);
    const files = [];
    const ignored = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith('!! ')) ignored.push(line.slice(3).trim());
      else files.push(line.trim());
    }
    return { dirty: files.length > 0, files: files.slice(0, 20), ignored: ignored.slice(0, 20), ignoredCount: ignored.length };
  }

  // Read-only recovery hint: the recorded Task branch may still hold unpublished commits after the worktree moved away.
  async function taskBranchHead(meta) {
    if (!BRANCH.test(meta.branch ?? '') || !meta.mirror || !existsSync(meta.mirror)) return null;
    try {
      const sha = (await git(['rev-parse', '--verify', `refs/heads/${meta.branch}^{commit}`], meta.mirror)).trim();
      return SHA.test(sha) ? sha : null;
    } catch {
      return null;
    }
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

  /**
   * A review binding recorded by an earlier candidate names the source Task, commit, and base but not the source branch
   * and handoff, so its finish evidence would silently omit them. Backfill only from dispatch evidence that names the
   * same exact commit and base: it can add provenance, never redirect the checkout or the bound commits.
   */
  function reviewEvidence(meta, dispatch) {
    if (!meta.review) return undefined;
    const review = meta.review;
    const candidate = dispatch && typeof dispatch === 'object' ? dispatch : undefined;
    const proven = candidate && candidate.commit === review.commit && candidate.baseSha === review.baseSha &&
      (candidate.sourceTaskId === undefined || candidate.sourceTaskId === review.sourceTaskId)
      ? candidate : undefined;
    return {
      ...review,
      ...(review.sourceBranch === undefined && typeof proven?.branch === 'string' && isSafeBranch(proven.branch) &&
        { sourceBranch: proven.branch }),
      ...(review.sourceHandoff === undefined && typeof proven?.handoff === 'string' && proven.handoff !== '' &&
        { sourceHandoff: proven.handoff }),
    };
  }

  // Read-only with respect to the worktree. Never commits, pushes, resets, or removes anything.
  async function checkFinish(taskId, { review: dispatchReview } = {}) {
    let meta = await assertWorkspace(taskId);
    if (meta.kind !== 'worktree') return { ok: true, base: null };
    const review = reviewEvidence(meta, dispatchReview);
    if (review && JSON.stringify(review) !== JSON.stringify(meta.review)) {
      meta = { ...meta, review };
      await writeMeta(taskId, meta);
    }
    const state = await status(meta);
    if (state.dirty) {
      return {
        ok: false, code: 'dirty_worktree',
        message: `The worktree has uncommitted or untracked work (${state.files.join(', ')}). Commit or remove it, then call finish again.`,
      };
    }
    // Ignored output (build artifacts, a nested `.gitignore` and what it covers) would be deleted with the worktree.
    // finish never deletes, so it asks for an explicit decision first.
    if (state.ignoredCount > 0) {
      return {
        ok: false, code: 'ignored_worktree_files',
        message: `The worktree has ${state.ignoredCount} ignored file${state.ignoredCount === 1 ? '' : 's'} (${state.ignored.join(', ')}). finish does not delete them; move or remove what you no longer need (for example \`git clean -fdX\` after checking), then call finish again.`,
      };
    }
    const head = (await git(['rev-parse', 'HEAD'], meta.path)).trim();
    if (head === meta.expectedHead) {
      return { ok: true, commit: head, base: meta.baseSha, expectedHead: meta.expectedHead, unchanged: true, ...(review && { review }) };
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
      branch: meta.branch, handoff: meta.handoff, ...(review && { review }),
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
      let ref;
      // Recovery data for a workspace that is no longer on its recorded Task branch: name both branches and, read-only,
      // the commit the Task branch still holds so the unpublished work is findable by ref and SHA.
      const switched = async actual => ({
        preservedHead: head, preservedBranch: actual, taskBranch: meta.branch, taskCommit: await taskBranchHead(meta),
        handoff: meta.handoff ?? null,
      });
      try {
        ref = (await git(['symbolic-ref', '--quiet', 'HEAD'], meta.path)).trim();
      } catch {
        return preserve('detached_or_switched_branch', await switched(null));
      }
      const branch = shortRef(ref);
      const state = await status(meta);
      if (state.dirty) return preserve('dirty_worktree', { preservedHead: head, preservedBranch: branch, files: state.files });
      // Completing or failing never removes ignored work: it is not in Git, so removing the worktree would lose it.
      if (state.ignoredCount > 0) {
        return preserve('ignored_worktree_files', { preservedHead: head, preservedBranch: branch, ignored: state.ignored });
      }
      // A named branch other than the recorded one is not the Task workspace, whatever HEAD happens to be: the Task's own
      // branch may still carry unpublished commits. Checked before `safe`, so an expected HEAD cannot authorize removal.
      if (ref !== branchRef(meta.branch)) return preserve('detached_or_switched_branch', await switched(branch));
      const handedOff = await remoteHandoff(meta, head).catch(() => false);
      const safe = head === meta.expectedHead || (successful && handedOff);
      if (!safe) {
        return preserve('unhanded_work', { preservedHead: head, preservedBranch: branch, taskBranch: meta.branch, handoff: meta.handoff ?? null });
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
