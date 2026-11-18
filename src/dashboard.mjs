const MAX_HISTORY = 20;
const MAX_WIDGETS = 20;
const MAX_TITLE = 120;
const MAX_TEXT = 2_000;
const MAX_SPEC_BYTES = 16_384;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MARKUP = /<\s*(?:\/?[a-z][\w:-]*(?=[\s/>])|[!?])/iu;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/|\/\/[a-z\d[]|\bwww\.\S|\b(?:https?|ftp|javascript|vbscript|data|file|blob|mailto|tel|sms|urn):\S/iu;

function statusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function validateAgent(agentId) {
  if (typeof agentId !== 'string' || agentId.length > 200 || !agentId.trim()
    || /[\u0000-\u001f\u007f]/u.test(agentId)) {
    throw statusError(400, 'Invalid agent ID.');
  }
}

function validateRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw statusError(400, 'Revision must be a positive integer.');
  }
}

function ownData(object, key) {
  return Object.getOwnPropertyDescriptor(object, key)?.value;
}

function hasExactFields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isPlainText(value, max) {
  return typeof value === 'string' && value.length <= max && value.trim().length > 0
    && !CONTROL.test(value) && !MARKUP.test(value) && !URL_PATTERN.test(value);
}

function validateSpec(spec) {
  if (!hasExactFields(spec, ['title', 'widgets'])) {
    throw statusError(400, 'Dashboard must contain only title and widgets.');
  }
  const title = ownData(spec, 'title');
  const widgets = ownData(spec, 'widgets');
  if (!isPlainText(title, MAX_TITLE)) {
    throw statusError(400, `Title must be plain text (1–${MAX_TITLE} characters, no URLs or HTML).`);
  }
  if (!Array.isArray(widgets) || widgets.length > MAX_WIDGETS
    || Reflect.ownKeys(widgets).length !== widgets.length + 1) {
    throw statusError(400, `Widgets must be an array of up to ${MAX_WIDGETS} items.`);
  }

  const clean = [];
  for (let i = 0; i < widgets.length; i++) {
    const widget = ownData(widgets, i);
    if (!hasExactFields(widget, ['kind', 'text'])) {
      throw statusError(400, 'Widgets must contain only kind and text.');
    }
    const kind = ownData(widget, 'kind');
    const text = ownData(widget, 'text');
    if ((kind !== 'note' && kind !== 'heading') || !isPlainText(text, MAX_TEXT)) {
      throw statusError(400, `Widgets must be notes or headings with plain text (1–${MAX_TEXT} characters, no URLs or HTML).`);
    }
    clean.push({ kind, text });
  }
  const json = JSON.stringify({ title, widgets: clean });
  if (Buffer.byteLength(json, 'utf8') > MAX_SPEC_BYTES) {
    throw statusError(400, 'Dashboard specification is too large.');
  }
  return json;
}

export function createDashboard(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manolo_dashboard_agents (
      agent_id TEXT PRIMARY KEY NOT NULL,
      last_revision INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS manolo_dashboard_revisions (
      agent_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      spec TEXT NOT NULL,
      published_order INTEGER,
      PRIMARY KEY (agent_id, revision),
      UNIQUE (agent_id, published_order)
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS manolo_dashboard_one_draft
      ON manolo_dashboard_revisions (agent_id)
      WHERE published_order IS NULL;
  `);

  const list = db.prepare(`
    SELECT revision, spec, published_order
    FROM manolo_dashboard_revisions WHERE agent_id = ?
    ORDER BY published_order DESC
  `);
  const allocate = db.prepare(`
    INSERT INTO manolo_dashboard_agents (agent_id, last_revision) VALUES (?, 1)
    ON CONFLICT (agent_id) DO UPDATE SET last_revision = last_revision + 1
    RETURNING last_revision
  `);
  const dropDraft = db.prepare(`
    DELETE FROM manolo_dashboard_revisions WHERE agent_id = ? AND published_order IS NULL
  `);
  const insert = db.prepare(`
    INSERT INTO manolo_dashboard_revisions (agent_id, revision, spec, published_order)
    VALUES (?, ?, ?, ?)
  `);
  const nextPublication = db.prepare(`
    SELECT COALESCE(MAX(published_order), 0) + 1 AS next
    FROM manolo_dashboard_revisions WHERE agent_id = ?
  `);
  const promoteDraft = db.prepare(`
    UPDATE manolo_dashboard_revisions SET published_order = ?
    WHERE agent_id = ? AND revision = ? AND published_order IS NULL
  `);
  const lookupPublication = db.prepare(`
    SELECT spec, published_order FROM manolo_dashboard_revisions
    WHERE agent_id = ? AND revision = ? AND published_order IS NOT NULL
  `);
  const prune = db.prepare(`
    DELETE FROM manolo_dashboard_revisions WHERE agent_id = ? AND published_order <= ?
  `);

  function readState(agentId) {
    const state = { current: null, draft: null, history: [] };
    for (const row of list.all(agentId)) {
      const version = { revision: row.revision, spec: JSON.parse(row.spec) };
      if (row.published_order === null) state.draft = version;
      else if (state.current === null) state.current = version;
      else state.history.push(version);
    }
    return state;
  }

  function change(agentId, write) {
    let started = false;
    try {
      // Serialize writers even when different connections share the same database.
      db.exec('BEGIN IMMEDIATE');
      started = true;
      write();
      const state = readState(agentId);
      db.exec('COMMIT');
      return state;
    } catch (error) {
      if (started && db.isTransaction) db.exec('ROLLBACK');
      const sqliteCode = error.errcode & 0xff;
      if (sqliteCode === 5 || sqliteCode === 6) { // SQLITE_BUSY or SQLITE_LOCKED
        throw statusError(409, 'Dashboard database is busy; refresh and retry.');
      }
      throw error;
    }
  }

  return {
    state(agentId) {
      validateAgent(agentId);
      return readState(agentId);
    },

    draft(agentId, spec) {
      validateAgent(agentId);
      const json = validateSpec(spec);
      return change(agentId, () => {
        const { last_revision: revision } = allocate.get(agentId);
        dropDraft.run(agentId);
        insert.run(agentId, revision, json, null);
      });
    },

    publish(agentId, revision) {
      validateAgent(agentId);
      validateRevision(revision);
      return change(agentId, () => {
        const { next } = nextPublication.get(agentId);
        if (promoteDraft.run(next, agentId, revision).changes !== 1) {
          throw statusError(409, 'That revision is no longer the draft.');
        }
        prune.run(agentId, next - MAX_HISTORY - 1);
      });
    },

    rollback(agentId, revision) {
      validateAgent(agentId);
      validateRevision(revision);
      return change(agentId, () => {
        const target = lookupPublication.get(agentId, revision);
        if (!target) throw statusError(404, 'Published revision not found.');
        const { next } = nextPublication.get(agentId);
        if (target.published_order === next - 1) {
          throw statusError(409, 'That revision is already current.');
        }
        // Restore by publication, not deletion. Leave any in-progress draft intact.
        const { last_revision: restored } = allocate.get(agentId);
        insert.run(agentId, restored, target.spec, next);
        prune.run(agentId, next - MAX_HISTORY - 1);
      });
    },
  };
}
