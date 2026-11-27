import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  blueprintSnapshot, loadWorkBlueprints, sealBlueprintSnapshot, verifyBlueprintSnapshot, verifyProfileSnapshot,
} from '../src/work-blueprints.mjs';

async function bundle(t) {
  const root = await mkdtemp(join(tmpdir(), 'manolo-blueprints-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'IDENTITY.md'), 'You are the repository Task agent.\n');
  await writeFile(join(root, 'AGENTS.md'), 'Prefer small commits.\n');
  await writeFile(join(root, 'CONVERSATION.md'), 'You are the main Manolo conversation.\n');
  const manifest = {
    version: 1,
    profiles: {
      deep: { description: 'Deep work', model: 'fixture-deep', thinkingLevel: 'high' },
      fast: { description: 'Cheap work', model: 'fixture-fast', thinkingLevel: 'low' },
    },
    repositories: {
      sample: { remote: '/srv/git/sample.git', base: 'main', handoff: '/srv/git/sample.git' },
    },
    blueprints: {
      general: {
        description: 'Generic repository Task', role: 'task', profile: 'deep', repository: 'sample',
        files: ['IDENTITY.md', 'AGENTS.md'],
        tools: ['read', 'bash', 'report_progress', 'post_inbox', 'finish'],
      },
      main: { description: 'Main conversation', role: 'conversation', files: ['CONVERSATION.md'], tools: [] },
    },
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  return { root, manifest };
}

test('a Blueprint bundle pins explicit text, tools, profile, and repository, content-addressed', async t => {
  const { root } = await bundle(t);
  const loaded = loadWorkBlueprints(undefined, { dir: root });
  const general = loaded.blueprints.get('general');
  assert.equal(general.role, 'task');
  assert.equal(general.profile.id, 'deep');
  assert.deepEqual(general.tools, ['read', 'bash', 'report_progress', 'post_inbox', 'finish']);
  assert.match(general.instructions, /You are the repository Task agent/);
  assert.match(general.instructions, /AGENTS\.md/);
  assert.match(general.instructions, /guidance only/);
  assert.equal(general.repositoryConfig.handoff, '/srv/git/sample.git');
  assert.match(general.revision, /^[0-9a-f]{64}$/);
  assert.equal(loaded.conversation.id, 'main');

  const snapshot = blueprintSnapshot(general);
  assert.equal(verifyBlueprintSnapshot(snapshot).revision, general.revision);
  assert.throws(() => blueprintSnapshot(loaded.conversation), /task Blueprint/);
  assert.throws(() => verifyBlueprintSnapshot({ ...snapshot, tools: ['read', 'bash', 'report_progress', 'post_inbox', 'finish', 'create_task'] }),
    /revision does not match/);
  assert.throws(() => verifyBlueprintSnapshot({ ...snapshot, instructions: 'tampered' }), /revision does not match/);

  // Editing the repository file is a new revision; the old pinned snapshot still verifies and keeps its text.
  await writeFile(join(root, 'IDENTITY.md'), 'You are a changed agent.\n');
  const changed = loadWorkBlueprints(undefined, { dir: root }).blueprints.get('general');
  assert.notEqual(changed.revision, general.revision);
  assert.match(verifyBlueprintSnapshot(snapshot).instructions, /repository Task agent/);

  // Overriding a profile seals a new snapshot with the exact profile values.
  const profile = loaded.profiles.get('fast');
  const pinned = sealBlueprintSnapshot({ ...snapshot, profile: { id: profile.id, description: profile.description, model: profile.model, thinkingLevel: profile.thinkingLevel } });
  assert.equal(verifyBlueprintSnapshot(pinned).profile.id, 'fast');
  assert.notEqual(pinned.revision, snapshot.revision);
  assert.equal(verifyProfileSnapshot(pinned.profile).thinkingLevel, 'low');
});

test('invalid bundles fail closed: lifecycle tools, profiles, paths, and non-owned GitHub handoffs', async t => {
  const { root, manifest } = await bundle(t);
  const write = async value => writeFile(join(root, 'manifest.json'), JSON.stringify(value));
  const invalid = async (mutate, pattern) => {
    const value = structuredClone(manifest);
    mutate(value);
    await write(value);
    assert.throws(() => loadWorkBlueprints(undefined, { dir: root }), pattern);
  };
  await invalid(value => { value.blueprints.general.tools = ['read', 'bash']; }, /lifecycle tool/);
  await invalid(value => { value.blueprints.general.profile = 'missing'; }, /unknown profile/);
  await invalid(value => { value.blueprints.general.files = ['../outside.md']; }, /relative path/);
  await invalid(value => { value.blueprints.general.repository = 'missing'; }, /unknown repository/);
  await invalid(value => { value.repositories.sample.handoff = 'https://github.com/someone-else/fork.git'; }, /not an owned account/);
  await invalid(value => { value.blueprints.general.tools.push('read'); }, /repeats a tool/);

  await symlink('/etc/hostname', join(root, 'LINK.md'));
  await invalid(value => { value.blueprints.general.files = ['LINK.md']; }, /regular file|stay inside/);

  // The legacy map still loads beside a bundle directory, and duplicate ids are refused.
  await write(manifest);
  const legacy = JSON.stringify({ review: { description: 'Review', instructions: 'Short.' } });
  assert.equal(loadWorkBlueprints(legacy, { dir: root }).blueprints.get('review').tools, null);
  const duplicate = structuredClone(manifest);
  duplicate.blueprints.review = { description: 'Duplicate', role: 'task', files: ['IDENTITY.md'], tools: ['finish', 'post_inbox', 'report_progress'] };
  await write(duplicate);
  assert.throws(() => loadWorkBlueprints(legacy, { dir: root }), /defined twice/);
});
