// Trusted GitHub operating policy. The app has shell access, not a GitHub credential broker, so this module cannot
// enforce what `git` or `gh` does from a shell. It encodes the policy the model is told, and validates the structured
// remote destinations this service itself uses (a Task handoff). A shell command remains the shell's responsibility.

export const OWNED_GITHUB_ACCOUNTS = new Set(['lanquarden', 'manolo-mistalibio']);

export const GITHUB_OPERATING_POLICY =
  'GitHub policy: lanquarden (personal) and manolo-mistalibio (agent) are owned accounts. You may fork a third-party repository and push scoped task branches to a configured owned fork, regardless of the upstream owner. Issues and pull requests to those two owners are allowed by default; a third-party destination requires an explicit request and an owned fork as the source is not permission. Never push to main, merge, or deploy unless the owner explicitly asks. This pod has shell-level GitHub access, so this policy is instruction and structured-remote validation, not a sandbox.';

const GITHUB = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;
const LOCAL = /^(?:\/|file:\/\/)/;
const PULL_REQUEST = /^https:\/\/github\.com\/([A-Za-z0-9_-][A-Za-z0-9._-]*)\/([A-Za-z0-9_-][A-Za-z0-9._-]*)\/pull\/([1-9][0-9]{0,9})$/;

/**
 * Structural pull-request evidence: one canonical `https://github.com/<owner>/<repository>/pull/<number>` URL bound to
 * the accepted Task commit. This is not a live GitHub check - no request is made - but it is strict about the shape:
 * `new URL` normalizes `.` and `..` segments, so a URL such as `https://github.com/./../pull/1` must be refused rather
 * than accepted as something that only looks like a pull request after normalization. When the Task's repository has a
 * known GitHub destination, the URL must name exactly that owner/repository, so evidence from another repository cannot
 * stand in for this Task's handoff.
 */
export function validatePullRequestEvidence({ url, commit, expectedCommit, destination } = {}) {
  if (typeof url !== 'string' || url.length > 2048) throw new Error('A pull-request URL is required.');
  const match = PULL_REQUEST.exec(url);
  if (!match) throw new Error('A pull-request URL must be https://github.com/<owner>/<repository>/pull/<number>.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('A pull-request URL must be a valid URL.'); }
  const [, owner, repo, number] = match;
  // A canonical pull-request URL has the bare repository name: `.git`, a dot segment, or a trailing dot is a different
  // string that only normalization would hide.
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..' || owner.includes('..') || repo.includes('..') ||
      repo.endsWith('.git') || repo.endsWith('.') || owner.endsWith('.') ||
      parsed.origin !== 'https://github.com' || parsed.pathname !== `/${owner}/${repo}/pull/${number}` ||
      parsed.search !== '' || parsed.hash !== '' || parsed.href !== url) {
    throw new Error('A pull-request URL must be exactly https://github.com/<owner>/<repository>/pull/<number>.');
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error('Pull-request evidence must name the accepted commit.');
  }
  if (expectedCommit !== undefined && commit !== expectedCommit) {
    throw new Error('Pull-request evidence must name the accepted Task commit.');
  }
  if (destination !== undefined) {
    if (destination.owner.toLowerCase() !== owner.toLowerCase() || destination.repo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error(`The pull request must target ${destination.owner}/${destination.repo}.`);
    }
  }
  return { url, owner, repo, number: Number(number), commit };
}

export function githubRepository(remote) {
  if (typeof remote !== 'string') return undefined;
  const match = GITHUB.exec(remote);
  if (!match) return undefined;
  const [, owner, repo] = match;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return undefined;
  return { owner, repo, owned: OWNED_GITHUB_ACCOUNTS.has(owner) };
}

/**
 * A Task handoff may only target an owned account (or a local, operator-managed fixture remote). The source remote is
 * unconstrained: forking a third-party repository is allowed. The branch name is checked separately by the Task Git
 * layer, always `task/<task id>`.
 */
export function validateHandoffRemote(remote) {
  if (typeof remote !== 'string' || remote.length === 0) throw new Error('A handoff remote must be a remote or path.');
  if (LOCAL.test(remote)) return { kind: 'local', remote };
  const repository = githubRepository(remote);
  if (!repository) throw new Error('A handoff remote must be a local path or a GitHub owner/repository remote.');
  if (!repository.owned) {
    throw new Error(`GitHub handoff destination ${repository.owner}/${repository.repo} is not an owned account.`);
  }
  return { kind: 'github', ...repository, remote };
}

/**
 * For a future structured issue/PR operation. Owned destinations need no extra grant; a third-party destination needs
 * the owner's explicit request. A pull request whose source is an owned fork does not grant that by itself.
 */
export function validateGitHubDestination({ owner, explicitlyRequested = false }) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(owner)) throw new Error('Invalid GitHub owner.');
  if (OWNED_GITHUB_ACCOUNTS.has(owner)) return { owner, owned: true };
  if (!explicitlyRequested) throw new Error(`GitHub destination ${owner} is third-party and needs an explicit owner request.`);
  return { owner, owned: false };
}
