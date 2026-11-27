import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GITHUB_OPERATING_POLICY, githubRepository, validateGitHubDestination, validateHandoffRemote,
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
