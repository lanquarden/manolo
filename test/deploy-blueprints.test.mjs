import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const chart = new URL('../deploy/helm/manolo', import.meta.url).pathname;
const helm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' });
const missingHelm = helm.error?.code === 'ENOENT';
const digest = letter => `example.com/manolo@sha256:${letter.repeat(64)}`;
const base = {
  relayImage: digest('a'),
  agents: {
    primary: { image: digest('b'), secret: 'manolo-primary', tokenEnv: 'MANOLO_PRIMARY_TOKEN', fixture: true },
    canary: { image: digest('c'), secret: 'manolo-canary', tokenEnv: 'MANOLO_CANARY_TOKEN', fixture: true },
  },
};

async function render(t, overrides) {
  const dir = await mkdtemp(join(tmpdir(), 'manolo-helm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const values = join(dir, 'values.json');
  await writeFile(values, JSON.stringify(overrides));
  const result = spawnSync('helm', ['template', 't', chart, '-f', values], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('the chart mounts an optional operator Blueprint bundle, wires the finish mode, and keeps safe defaults', {
  skip: missingHelm && 'helm unavailable', timeout: 60_000,
}, async t => {
  // Unconfigured is the safe default: no bundle path, no extra mount, no finish-mode override.
  const plain = await render(t, base);
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /MANOLO_BLUEPRINTS_DIR/);
  assert.doesNotMatch(plain.stdout, /name: blueprints/);
  assert.doesNotMatch(plain.stdout, /MANOLO_TASK_FINISH/);

  // A Git-managed directory already inside the container: environment only, no chart-managed volume.
  const inImage = await render(t, { ...base, agents: { ...base.agents, primary: { ...base.agents.primary, blueprintsDir: '/data/blueprints' } } });
  assert.equal(inImage.status, 0, inImage.stderr);
  assert.match(inImage.stdout, /- \{name: MANOLO_BLUEPRINTS_DIR, value: "\/data\/blueprints"\}/);
  assert.doesNotMatch(inImage.stdout, /name: blueprints/);

  // A ConfigMap rendered at /blueprints: environment plus a read-only volume and mount on that worker only.
  const mounted = await render(t, {
    ...base, agents: { ...base.agents, primary: { ...base.agents.primary, blueprintsMount: { configMap: 'manolo-blueprints' } } },
  });
  assert.equal(mounted.status, 0, mounted.stderr);
  assert.match(mounted.stdout, /MANOLO_BLUEPRINTS_DIR, value: "\/blueprints"/);
  assert.match(mounted.stdout, /- \{name: blueprints, mountPath: \/blueprints, readOnly: true\}/);
  assert.match(mounted.stdout, /- name: blueprints\n          configMap: \{name: "manolo-blueprints"\}/);
  assert.equal((mounted.stdout.match(/MANOLO_BLUEPRINTS_DIR/g) ?? []).length, 1, 'only the configured worker gets the bundle');

  // Exactly one source, absolute in-container paths, and Kubernetes object names.
  for (const [overrides, pattern] of [
    [{ blueprintsDir: '/x', blueprintsMount: { configMap: 'x' } }, /both blueprintsDir and blueprintsMount/],
    [{ blueprintsMount: { configMap: 'x', secret: 'y' } }, /one source, not both/],
    [{ blueprintsMount: { configMap: 'Not_A_Name' } }, /Kubernetes object name/],
    [{ blueprintsMount: { volume: 'x' } }, /not a supported source/],
    [{ blueprintsDir: 'relative/path' }, /absolute container path/],
  ]) {
    const result = await render(t, { ...base, agents: { ...base.agents, primary: { ...base.agents.primary, ...overrides } } });
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.match(result.stderr, pattern);
  }

  // The relay's finish mode is explicit and only valid during a mixed-version rollout with Tasks enabled.
  const legacy = await render(t, { ...base, workSessionAgent: 'primary', taskFinish: 'legacy' });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /- \{name: MANOLO_TASK_FINISH, value: "legacy"\}/);
  const required = await render(t, { ...base, workSessionAgent: 'primary', taskFinish: 'required' });
  assert.equal(required.status, 0, required.stderr);
  assert.match(required.stdout, /MANOLO_TASK_FINISH, value: "required"/);
  for (const [overrides, pattern] of [
    [{ taskFinish: 'off' }, /taskFinish must be required or legacy/],
    [{ taskFinish: 'legacy' }, /only meaningful with workSessionAgent/],
  ]) {
    const result = await render(t, { ...base, ...overrides });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  }
});
