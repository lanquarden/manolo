import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDashboard } from '../src/dashboard.mjs';

const spec = (title) => ({
  title,
  widgets: [{ kind: 'heading', text: 'Updates' }, { kind: 'note', text: 'Ready.' }],
});

function openDashboard(t, path = ':memory:') {
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  return { db, dashboard: createDashboard(db) };
}

test('only the latest draft revision can be published, including across connections', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'manolo-dashboard-'));
  const path = join(dir, 'test.sqlite');
  const { dashboard: first } = openDashboard(t, path);
  const { dashboard: second } = openDashboard(t, path);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const empty = { current: null, draft: null, history: [] };
  assert.deepEqual(first.state('manolo'), empty);
  const { draft: preview } = first.draft('manolo', spec('First preview'));
  const { draft: latest } = second.draft('manolo', spec('Newer preview'));
  assert.ok(latest.revision > preview.revision);
  assert.throws(() => first.publish('manolo', preview.revision), { statusCode: 409 });
  assert.deepEqual(first.state('manolo'), { ...empty, draft: latest });
  assert.deepEqual(first.publish('manolo', latest.revision), { ...empty, current: latest });
  assert.throws(() => second.publish('manolo', latest.revision), { statusCode: 409 });
  assert.deepEqual(second.state('manolo'), { ...empty, current: latest });
});

test('a competing transaction cannot partially publish a draft', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'manolo-dashboard-'));
  const path = join(dir, 'test.sqlite');
  const { db, dashboard: first } = openDashboard(t, path);
  const { dashboard: second } = openDashboard(t, path);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = first.draft('manolo', spec('Ready for publication'));

  db.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => second.publish('manolo', saved.draft.revision), { statusCode: 409 });
    assert.deepEqual(second.state('manolo'), saved);
  } finally {
    db.exec('ROLLBACK');
  }
  assert.deepEqual(second.publish('manolo', saved.draft.revision).current, saved.draft);
});

test('agents have independent drafts, current revisions, and history', (t) => {
  const { dashboard } = openDashboard(t);
  const { draft: a } = dashboard.draft('manolo', spec('Manolo'));
  const { draft: b } = dashboard.draft('other', spec('Other'));
  assert.deepEqual(dashboard.publish('manolo', a.revision).current, a);
  assert.deepEqual(dashboard.state('other'), { current: null, draft: b, history: [] });
  assert.throws(() => dashboard.rollback('other', a.revision), { statusCode: 404 });

  const { draft: next } = dashboard.draft('manolo', spec('Manolo next'));
  assert.deepEqual(dashboard.publish('manolo', next.revision).history, [a]);
  assert.deepEqual(dashboard.publish('other', b.revision).current, b);
  assert.deepEqual(dashboard.state('other').history, []);
});

test('rollback republishes a retained revision without discarding the pending draft', (t) => {
  const { dashboard } = openDashboard(t);
  const publish = (title) => {
    const { draft } = dashboard.draft('manolo', spec(title));
    return dashboard.publish('manolo', draft.revision).current;
  };
  const first = publish('First');
  const second = publish('Second');
  const { draft } = dashboard.draft('manolo', spec('Still editing'));

  assert.throws(() => dashboard.rollback('manolo', draft.revision), { statusCode: 404 });
  assert.throws(() => dashboard.rollback('manolo', second.revision), { statusCode: 409 });
  const restored = dashboard.rollback('manolo', first.revision);
  assert.ok(restored.current.revision > draft.revision);
  assert.deepEqual(restored, {
    current: { revision: restored.current.revision, spec: first.spec },
    draft,
    history: [second, first],
  });

  // History tracks publication order, even when an older pending draft is published.
  assert.deepEqual(dashboard.publish('manolo', draft.revision), {
    current: draft,
    draft: null,
    history: [restored.current, second, first],
  });
  assert.deepEqual(dashboard.rollback('manolo', second.revision).current.spec, second.spec);
});

test('keeps only the most recent 20 historical publications per agent', (t) => {
  const { dashboard } = openDashboard(t);
  const publish = (agentId, title) => {
    const { draft } = dashboard.draft(agentId, spec(title));
    return dashboard.publish(agentId, draft.revision).current;
  };
  const other = publish('other', 'Other');
  const versions = Array.from({ length: 25 }, (_, i) => publish('manolo', `Version ${i}`));
  const state = dashboard.state('manolo');
  assert.deepEqual(state.current, versions[24]);
  assert.deepEqual(state.history, versions.slice(4, 24).reverse());
  assert.throws(() => dashboard.rollback('manolo', versions[3].revision), { statusCode: 404 });
  assert.deepEqual(dashboard.state('manolo'), state);
  assert.deepEqual(dashboard.state('other'), { current: other, draft: null, history: [] });
});

test('rejects invalid or oversized specs and revision arguments without changing state', (t) => {
  const { dashboard } = openDashboard(t);
  const saved = dashboard.draft('manolo', spec('Safe title'));
  for (const invalid of [
    null,
    [],
    { title: 'No widgets' },
    { ...spec('Extra field'), url: 'example.test' },
    { ...spec(''), title: { value: 'Wrong type' } },
    spec('   '),
    spec('a'.repeat(121)),
    { title: 'Too many widgets', widgets: Array(21).fill({ kind: 'note', text: 'ok' }) },
    { title: 'Sparse array', widgets: Array(1) },
    { title: 'Unknown kind', widgets: [{ kind: 'button', text: 'Click' }] },
    { title: 'Extra widget field', widgets: [{ kind: 'note', text: 'Click', action: {} }] },
    { title: 'Too long', widgets: [{ kind: 'note', text: 'x'.repeat(2001) }] },
    { title: 'Too many bytes', widgets: Array(3).fill({ kind: 'note', text: '界'.repeat(2000) }) },
    { title: 'Wrong type', widgets: [{ kind: 'note', text: 13 }] },
    { title: 'Markup', widgets: [{ kind: 'note', text: '<b>Hi</b>' }] },
    { title: 'URL', widgets: [{ kind: 'note', text: 'See https://example.test' }] },
    spec('See (//example.test)'),
    spec('See www.example.test'),
  ]) {
    assert.throws(() => dashboard.draft('manolo', invalid), { statusCode: 400 });
  }
  for (const invalid of [undefined, null, '1', 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => dashboard.publish('manolo', invalid), { statusCode: 400 });
    assert.throws(() => dashboard.rollback('manolo', invalid), { statusCode: 400 });
  }
  assert.throws(() => dashboard.state(''), { statusCode: 400 });
  assert.deepEqual(dashboard.state('manolo'), saved);
});

test('failed publication rolls back all writes and leaves the connection usable', (t) => {
  const { db, dashboard } = openDashboard(t);
  const { draft: first } = dashboard.draft('manolo', spec('First'));
  dashboard.publish('manolo', first.revision);
  const before = dashboard.draft('manolo', spec('Second'));
  db.exec(`
    CREATE TEMP TRIGGER fail_publication
    BEFORE DELETE ON manolo_dashboard_revisions
    WHEN OLD.published_order IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'history pruning failed');
    END;
  `);
  // Fail during pruning, after creating the rollback publication.
  for (let i = 0; i < 20; i++) {
    if (i === 0) {
      dashboard.publish('manolo', before.draft.revision);
    } else {
      const { draft } = dashboard.draft('manolo', spec(`Version ${i}`));
      dashboard.publish('manolo', draft.revision);
    }
  }
  const state = dashboard.state('manolo');
  assert.throws(() => dashboard.rollback('manolo', first.revision), /history pruning failed/);
  assert.deepEqual(dashboard.state('manolo'), state);
  db.exec('DROP TRIGGER fail_publication');
  const restored = dashboard.rollback('manolo', first.revision);
  assert.equal(restored.current.revision, state.current.revision + 1);
  assert.deepEqual(restored.current.spec, first.spec);
});
