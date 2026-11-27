import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GITHUB_OPERATING_POLICY, githubRepository, validateGitHubDestination, validateHandoffRemote,
  validatePullRequestEvidence,
} from '../src/github-policy.mjs';

test('owned repositories and local handoff remotes are allowed; third-party GitHub handoffs are refused', () => {
  assert.equal(githubRepository('https://github.com/lanquarden/manolo.git').owner, 'lanquarden');
  assert.equal(githubRepository('git@github.com:manolo-mistalibio/manolo.git').repo, 'manolo');
  assert.equal(githubRepository('https://github.com/lanquarden/manolo.git').owned, true);
  assert.equal(githubRepository('https://github.com/someone/fork.git').owned, false);
  assert.equal(githubRepository('/srv/git/sample.git'), undefined);

  assert.deepEqual(validateHandoffRemote('/srv/git/sample.git'), { kind: 'local', remote: '/srv/git/sample.git' });
  assert.equal(validateHandoffRemote('https://github.com/lanquarden/manolo.git').owned, true);
  assert.throws(() => validateHandoffRemote('https://github.com/someone/fork.git'), /not an owned account/);
  assert.throws(() => validateHandoffRemote('https://gitlab.com/lanquarden/manolo.git'), /GitHub/);

  assert.deepEqual(validateGitHubDestination({ owner: 'manolo-mistalibio' }), { owner: 'manolo-mistalibio', owned: true });
  assert.throws(() => validateGitHubDestination({ owner: 'someone' }), /explicit owner request/);
  assert.deepEqual(validateGitHubDestination({ owner: 'someone', explicitlyRequested: true }), { owner: 'someone', owned: false });
  assert.match(GITHUB_OPERATING_POLICY, /never push to main/i);
  assert.match(GITHUB_OPERATING_POLICY, /not a sandbox/);
});

test('pull-request evidence is structural, canonical, and bound to one commit and destination', () => {
  const commit = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  assert.deepEqual(
    validatePullRequestEvidence({ url: 'https://github.com/lanquarden/manolo/pull/7', commit, expectedCommit: commit }),
    { url: 'https://github.com/lanquarden/manolo/pull/7', owner: 'lanquarden', repo: 'manolo', number: 7, commit },
  );
  // Destination binding is case-insensitive but exact on owner/repository.
  assert.ok(validatePullRequestEvidence({
    url: 'https://github.com/Manolo-Mistalibio/Manolo/pull/1', commit,
    destination: { owner: 'manolo-mistalibio', repo: 'manolo' },
  }));
  // A URL that only looks like a pull request after URL normalization is refused, not accepted as canonical.
  for (const url of [
    'https://github.com/./../pull/1',
    'https://github.com/lanquarden/../pull/1',
    'https://github.com/lanquarden/manolo/pull/1/',
    'https://github.com//lanquarden/manolo/pull/1',
    'https://github.com/lanquarden/manolo.git/pull/1',
    'http://github.com/lanquarden/manolo/pull/1',
    'https://github.com/lanquarden/manolo/pull/0',
    'https://github.com/lanquarden/manolo/pull/1?diff=split',
    'https://github.com/lanquarden/manolo/pull/1#discussion',
  ]) {
    assert.throws(() => validatePullRequestEvidence({ url, commit }), /pull-request URL|Pull-request|repository/);
  }
  assert.throws(() => validatePullRequestEvidence({ url: 'https://github.com/lanquarden/manolo/pull/1', commit: other, expectedCommit: commit }),
    /accepted Task commit/);
  assert.throws(() => validatePullRequestEvidence({ url: 'https://github.com/lanquarden/other/pull/1', commit,
    destination: { owner: 'lanquarden', repo: 'manolo' } }), /must target lanquarden\/manolo/);
  assert.throws(() => validatePullRequestEvidence({ url: 'https://github.com/lanquarden/manolo/pull/1', commit: 'not-a-sha' }),
    /accepted commit/);
});
