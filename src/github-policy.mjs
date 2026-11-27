// Trusted GitHub operating policy. The app has shell access, not a GitHub credential broker, so this module cannot
// enforce what `git` or `gh` does from a shell. It encodes the policy the model is told, and validates the structured
// remote destinations this service itself uses (a Task handoff). A shell command remains the shell's responsibility.

export const OWNED_GITHUB_ACCOUNTS = new Set(['lanquarden', 'manolo-mistalibio']);

export const GITHUB_OPERATING_POLICY =
  'GitHub policy: lanquarden (personal) and manolo-mistalibio (agent) are owned accounts. You may fork a third-party repository and push scoped task branches to a configured owned fork, regardless of the upstream owner. Issues and pull requests to those two owners are allowed by default; a third-party destination requires an explicit request and an owned fork as the source is not permission. Never push to main, merge, or deploy unless the owner explicitly asks. This pod has shell-level GitHub access, so this policy is instruction and structured-remote validation, not a sandbox.';

const GITHUB = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;
const LOCAL = /^(?:\/|file:\/\/)/;

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
