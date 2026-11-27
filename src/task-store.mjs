import { randomBytes } from 'node:crypto';
import { githubRepository, validatePullRequestEvidence } from './github-policy.mjs';

// The durable Task ledger. The relay owns it: a Task keeps its identity through queuing, one execution at a time,
// pauses for a person, and a terminal outcome. The scheduler claims eligible rows here; the worker executes them and
// reports back with the execution ID it was given, which fences every late or stale update.
export const TASK_STATUSES = ['queued', 'running', 'waiting', 'done', 'failed', 'cancelled'];
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const MAX_TITLE = 120;
const MAX_INPUT = 4000;
const MAX_PROMPT = 2000;
const MAX_NOTE = 500;
const MAX_SUMMARY = 2500;
const MAX_CONTEXT = 4000;
const MAX_LIST = 100;
const MAX_ITEMS = 20;
const MAX_PROGRESS = 50;
const MAX_NOTICES = 8;
const MAX_DISPATCH_ATTEMPTS = 12;
const MAX_STOP_ATTEMPTS = 60;
const HISTORY_PAGE = 25;
const ACTIVE_LIMIT = 100;
const unsafe = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Bidi_Control}/gu;

const bad = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const newId = () => randomBytes(16).toString('hex');
const iso = ms => new Date(ms).toISOString();
const plain = (text, max) => {
  const cleaned = String(text).toWellFormed().replace(unsafe, '');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).toWellFormed()}…` : cleaned;
};
const delay = attempts => Math.min(2 ** Math.min(attempts, 8) * 1000, 120_000);
// The admission run a worker reports for one execution: the initial admission is 1 and every new child submission of the
// same execution is one higher. It is optional on every route, so a worker that predates it keeps writing unversioned
// reports; when it is present the ledger fences on it.
const admissionRun = run => Number.isSafeInteger(run) && run >= 1 ? run : undefined;

// A Task is "scheduled" while it is queued and its not-before time is still ahead. That is a view of one row, not a
// second state: the scheduler only ever claims `queued` rows whose time has come.
export function taskView(row, now = Date.now()) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    scheduled: row.status === 'queued' && row.not_before > now,
    notBefore: row.not_before > 0 ? iso(row.not_before) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.blueprint_id && { blueprint: { id: row.blueprint_id, revision: row.blueprint_revision } }),
    ...(row.profile_snapshot && { profile: (() => { const profile = JSON.parse(row.profile_snapshot); return { id: profile.id, model: profile.model, ...(profile.thinkingLevel && { thinkingLevel: profile.thinkingLevel }) }; })() }),
    ...(row.review_snapshot && { review: JSON.parse(row.review_snapshot) }),
    ...(row.handoff_evidence && { handoff: JSON.parse(row.handoff_evidence) }),
    ...(row.finish_accepted_at && { finish: { acceptedAt: row.finish_accepted_at, summary: row.finish_summary ?? null } }),
    ...(row.blocked_reason && { blocked: row.blocked_reason }),
    ...(row.requires_pr === 1 && { requiresPullRequest: true }),
    originTurnId: row.origin_turn_id,
    ...(row.outcome && { outcome: row.outcome }),
    ...(row.failure && { failure: row.failure }),
    ...(row.heartbeat_at && { heartbeatAt: iso(row.heartbeat_at) }),
    ...(row.status === 'running' && { executionId: row.execution_id }),
    // Cancelling is a ledger decision; stopping the worker is a separate, retried step.
    ...(row.status === 'cancelled' && { stopPending: row.stop_pending === 1 }),
    ...(row.stop_confirmed_at && { stopConfirmedAt: row.stop_confirmed_at }),
  };
}

const itemView = item => ({
  id: item.id, kind: item.kind, prompt: item.prompt, status: item.status,
  ...(item.response !== null && { response: item.response }),
  ...(item.responded_at && { respondedAt: item.responded_at }),
  ...(item.delivered_at && { deliveredAt: item.delivered_at }),
  createdAt: item.created_at,
});

function detailView(row, items, progress, now) {
  const views = items.map(itemView);
  // Items arrive newest first. The active item is the newest open one, so a Task that paused twice shows the item the
  // owner can still act on; otherwise it is the newest item, answered, declined or cancelled.
  const active = views.find(item => item.status === 'open') ?? views[0];
  return {
    ...taskView(row, now),
    input: row.input,
    items: views,
    ...(active && { activeItem: active }),
    progress: progress.map(note => ({ note: note.note, at: note.created_at })),
  };
}

export function openTaskStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL,
      owner TEXT NOT NULL,
      agent TEXT NOT NULL,
      origin_turn_id TEXT NOT NULL,
      title TEXT NOT NULL,
      input TEXT NOT NULL,
      blueprint_id TEXT,
      blueprint_revision TEXT,
      blueprint_snapshot TEXT,
      profile_snapshot TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','done','failed','cancelled')),
      finish_required INTEGER NOT NULL DEFAULT 1,
      finish_accepted_at TEXT,
      finish_summary TEXT,
      handoff_evidence TEXT,
      blocked_reason TEXT,
      review_snapshot TEXT,
      requires_pr INTEGER NOT NULL DEFAULT 0,
      not_before INTEGER NOT NULL DEFAULT 0,
      execution_id TEXT,
      execution_kind TEXT NOT NULL DEFAULT 'start' CHECK(execution_kind IN ('start','resume')),
      resume_item_id TEXT,
      context TEXT,
      claim_at INTEGER,
      heartbeat_at INTEGER,
      dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0,
      dispatch_pending INTEGER NOT NULL DEFAULT 0,
      dispatch_epoch INTEGER NOT NULL DEFAULT 0,
      run_fence INTEGER NOT NULL DEFAULT 0,
      stop_pending INTEGER NOT NULL DEFAULT 0,
      stop_attempts INTEGER NOT NULL DEFAULT 0,
      stop_next_at INTEGER NOT NULL DEFAULT 0,
      stop_confirmed_at TEXT,
      outcome TEXT,
      failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, not_before, next_at);
    CREATE INDEX IF NOT EXISTS tasks_scope ON tasks(scope, created_at);
    CREATE TABLE IF NOT EXISTS task_inbox_items (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('question','report')),
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','answered','declined','cancelled','fenced')),
      response TEXT,
      responded_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS task_inbox_open ON task_inbox_items(task_id) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS task_inbox_task ON task_inbox_items(task_id, created_at);
    CREATE TABLE IF NOT EXISTS task_progress (
      seq INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_progress_task ON task_progress(task_id, seq);
    CREATE TABLE IF NOT EXISTS task_operations (
      key TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      receipt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      seq INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      turn_id TEXT
    );
    CREATE INDEX IF NOT EXISTS task_events_scope ON task_events(scope, delivered_at, seq);
  `);

  // A relay database from the first slice keeps its Tasks: add the delivery and stop bookkeeping in place.
  const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [name, definition] of [
      ['blueprint_snapshot', 'TEXT'],
      ['profile_snapshot', 'TEXT'],
      ['dispatch_pending', 'INTEGER NOT NULL DEFAULT 0'],
      ['dispatch_epoch', 'INTEGER NOT NULL DEFAULT 0'],
      ['run_fence', 'INTEGER NOT NULL DEFAULT 0'],
      ['stop_pending', 'INTEGER NOT NULL DEFAULT 0'],
      ['stop_attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['stop_next_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['stop_confirmed_at', 'TEXT'],
      // Tasks created before the finish protocol are legacy rows: they may settle from a worker that never calls finish.
      ['finish_required', 'INTEGER NOT NULL DEFAULT 0'],
      ['finish_accepted_at', 'TEXT'],
      ['finish_summary', 'TEXT'],
      ['handoff_evidence', 'TEXT'],
      ['blocked_reason', 'TEXT'],
      ['review_snapshot', 'TEXT'],
      ['requires_pr', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!taskColumns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    }
    // A ledger written by an earlier candidate can hold a resume that was already delivered: the response reached the
    // child, the slot was cleared, but `execution_kind` stayed 'resume' with no item left to deliver. The scheduler would
    // read that as an empty resume and fail the Task. The recorded delivery on this Task's own item is the durable
    // evidence, so the row goes back to a plain start of the SAME execution instead. Nothing is invented for a row without
    // that evidence: it keeps its shape and is still reported as an unavailable resume.
    db.exec(`UPDATE tasks SET execution_kind='start', context=NULL,
      dispatch_pending = CASE WHEN status='running' THEN 1 ELSE dispatch_pending END,
      dispatch_attempts = CASE WHEN status='running' THEN 0 ELSE dispatch_attempts END,
      dispatch_epoch = CASE WHEN status='running' THEN dispatch_epoch + 1 ELSE dispatch_epoch END,
      next_at = CASE WHEN status='running' THEN 0 ELSE next_at END
      WHERE execution_kind='resume' AND resume_item_id IS NULL AND execution_id IS NOT NULL
        AND status IN ('queued','running')
        AND EXISTS (SELECT 1 FROM task_inbox_items i WHERE i.task_id = tasks.id AND i.delivered_at IS NOT NULL)`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const row = db.prepare('SELECT * FROM tasks WHERE id=?');
  const scoped = db.prepare('SELECT * FROM tasks WHERE id=? AND scope=?');
  const itemList = db.prepare('SELECT *, rowid AS seqrowid FROM task_inbox_items WHERE task_id=? ORDER BY rowid DESC LIMIT ?');
  const lastProgress = db.prepare('SELECT note FROM task_progress WHERE task_id=? ORDER BY seq DESC LIMIT 1');
  const lastItem = db.prepare('SELECT id, kind, prompt, status FROM task_inbox_items WHERE task_id=? ORDER BY rowid DESC LIMIT 1');
  const progressList = db.prepare('SELECT * FROM task_progress WHERE task_id=? ORDER BY seq DESC LIMIT ?');
  const operation = db.prepare('SELECT task_id, kind, receipt FROM task_operations WHERE key=?');
  const addOperation = db.prepare('INSERT INTO task_operations(key,task_id,kind,receipt,created_at) VALUES(?,?,?,?,?)');
  const addEvent = db.prepare('INSERT INTO task_events(task_id,scope,kind,text,created_at) VALUES(?,?,?,?,?)');
  const openItem = db.prepare(`SELECT * FROM task_inbox_items WHERE task_id=? AND status='open'`);
  const item = db.prepare('SELECT * FROM task_inbox_items WHERE id=?');
  const setStatus = db.prepare(`UPDATE tasks SET status=?, execution_kind=?, resume_item_id=?, context=?, claim_at=?, heartbeat_at=?,
    next_at=?, dispatch_pending=0, updated_at=? WHERE id=?`);

  const ACTIVE_STATES = ['queued', 'running', 'waiting'];
  const HISTORY_STATES = ['done', 'failed', 'cancelled'];
  const summary = (task, now) => ({
    ...taskView(task, now),
    ...(lastProgress.get(task.id) && { progress: lastProgress.get(task.id).note }),
    ...(lastItem.get(task.id) && { inboxItem: lastItem.get(task.id) }),
  });

  // `order` is a code literal, never caller input. `before` is a rowid keyset for History paging.
  function taskQuery(scope, { status, blueprint, text, limit = MAX_LIST, before, order = 'rowid DESC' }) {
    const filters = ['scope=?'];
    const values = [scope];
    if (status === 'active') filters.push(`status IN ('queued','running','waiting')`);
    else if (status === 'history') filters.push(`status IN ('done','failed','cancelled')`);
    else if (TASK_STATUSES.includes(status)) { filters.push('status=?'); values.push(status); }
    if (blueprint) { filters.push('blueprint_id=?'); values.push(blueprint); }
    if (text) { filters.push('(title LIKE ? OR input LIKE ?)'); values.push(`%${text}%`, `%${text}%`); }
    if (before !== undefined) { filters.push('rowid<?'); values.push(before); }
    return {
      sql: `SELECT *, rowid AS seqrowid FROM tasks WHERE ${filters.join(' AND ')} ORDER BY ${order} LIMIT ?`,
      values: [...values, Math.min(Math.max(limit, 1), MAX_LIST)],
    };
  }

  function transaction(run) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function receipt(key, taskId, kind) {
    const stored = operation.get(key);
    if (!stored) return undefined;
    if (stored.task_id !== taskId || stored.kind !== kind) throw bad(409, 'Operation key already used');
    return JSON.parse(stored.receipt);
  }

  function remember(key, taskId, kind, value, now) {
    addOperation.run(key, taskId, kind, JSON.stringify(value), iso(now));
    return value;
  }

  // The current execution is the only writer allowed to change a non-terminal Task. The Task stays `running` while the
  // relay retries an unacknowledged dispatch or resume, so a valid write from that same execution is accepted instead of
  // being rejected by a transient delivery state. A yielded Task (`waiting`) still refuses progress and new items, and a
  // stale execution or a terminal Task always conflicts. `allowQueued` is for a settle that legitimately lands while a
  // response is queued for the same execution, before the scheduler claims it again.
  function fenced(taskId, executionId, { allowQueued = false } = {}) {
    const task = row.get(taskId);
    if (!task) throw bad(404, 'Task not found');
    if (TERMINAL.has(task.status)) throw bad(409, 'Task is already terminal');
    if (task.execution_id !== executionId) throw bad(409, 'Execution is no longer current');
    if (task.status === 'running') return task;
    if (allowQueued && task.status === 'queued') return task;
    throw bad(409, 'Execution is not running');
  }

  return {
    db,

    create({ owner, agent, scope, originTurnId, title, input, blueprint, blueprintSnapshot, profile, review, requiresPr = false, finishRequired = true, notBefore = 0, key, now = Date.now() }) {
      return transaction(() => {
        if (key) {
          const stored = operation.get(key);
          if (stored) {
            if (stored.kind !== 'create') throw bad(409, 'Operation key already used');
            return JSON.parse(stored.receipt);
          }
        }
        const id = newId();
        const createdAt = iso(now);
        db.prepare(`INSERT INTO tasks(id,scope,owner,agent,origin_turn_id,title,input,blueprint_id,blueprint_revision,
          blueprint_snapshot,profile_snapshot,review_snapshot,requires_pr,status,finish_required,not_before,execution_kind,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'queued', ?, ?, 'start', ?, ?)`)
          .run(id, scope, owner, agent, originTurnId, plain(title, MAX_TITLE), plain(input, MAX_INPUT),
            blueprint?.id ?? null, blueprint?.revision ?? null,
            blueprintSnapshot === undefined ? null : JSON.stringify(blueprintSnapshot),
            profile === undefined ? null : JSON.stringify(profile),
            review === undefined ? null : JSON.stringify(review), requiresPr ? 1 : 0,
            finishRequired ? 1 : 0, notBefore, createdAt, createdAt);
        const view = taskView(row.get(id), now);
        if (key) remember(key, id, 'create', view, now);
        return view;
      });
    },

    // The Orchestrator's own read. The web view uses active() and history() so terminal traffic can never crowd out
    // active work and History can page without loading everything.
    list(scope, { status, blueprint, text, limit = MAX_LIST } = {}, now = Date.now()) {
      const query = taskQuery(scope, { status, blueprint, text, limit, order: 'created_at DESC, rowid DESC' });
      return db.prepare(query.sql).all(...query.values).map(task => summary(task, now));
    },

    active(scope, now = Date.now()) {
      const query = taskQuery(scope, { status: 'active', limit: ACTIVE_LIMIT, order: 'rowid DESC' });
      return db.prepare(query.sql).all(...query.values).map(task => summary(task, now));
    },

    history(scope, { status = 'history', blueprint, text, cursor, limit = HISTORY_PAGE } = {}, now = Date.now()) {
      const before = typeof cursor === 'string' && /^[0-9]{1,16}$/.test(cursor) ? Number(cursor) : undefined;
      const query = taskQuery(scope, { status, blueprint, text, limit, before, order: 'rowid DESC' });
      const rows = db.prepare(query.sql).all(...query.values);
      const last = rows.at(-1)?.seqrowid;
      return {
        tasks: rows.map(task => summary(task, now)),
        ...(rows.length === Math.min(Math.max(limit, 1), MAX_LIST) && last !== undefined ? { nextCursor: String(last) } : {}),
      };
    },

    blueprints(scope) {
      return db.prepare(`SELECT DISTINCT blueprint_id FROM tasks WHERE scope=? AND blueprint_id IS NOT NULL
        ORDER BY blueprint_id LIMIT 32`).all(scope).map(row => row.blueprint_id);
    },

    get(scope, id, now = Date.now()) {
      const task = scoped.get(id, scope);
      if (!task) return undefined;
      return detailView(task, itemList.all(id, MAX_ITEMS), progressList.all(id, MAX_PROGRESS), now);
    },

    // Open Inbox items of one conversation, for the web Inbox. Only the owner's own scope is visible.
    openItems(scope) {
      return db.prepare(`SELECT i.id, i.task_id, i.kind, i.prompt, i.created_at, t.title FROM task_inbox_items i
        JOIN tasks t ON t.id=i.task_id WHERE t.scope=? AND i.status='open' ORDER BY i.rowid DESC LIMIT ?`)
        .all(scope, MAX_ITEMS).map(item => ({
          id: item.id, taskId: item.task_id, taskTitle: item.title, kind: item.kind, prompt: item.prompt,
          createdAt: item.created_at,
        }));
    },

    // The one place a Task becomes eligible for execution. The claim and the execution identity land together, so a
    // dispatch retry reuses the same execution ID and the worker admits the same child submission instead of a second.
    claim(now) {
      return transaction(() => {
        const next = db.prepare(`SELECT * FROM tasks WHERE status='queued' AND not_before<=? AND next_at<=?
          ORDER BY not_before, rowid LIMIT 1`).get(now, now);
        if (!next) return undefined;
        // A retry of a dispatch that may already have reached the worker keeps its execution identity, so the worker
        // admits the same child submission instead of starting a second one. Only a Task without one mints a new ID.
        const executionId = next.execution_id ?? newId();
        // A new execution identity starts a new admission sequence, so its fence starts over. A retry of the same
        // execution keeps the fence it already earned: an older admission of that execution stays fenced out.
        const runFence = next.execution_id == null ? 0 : next.run_fence ?? 0;
        // `dispatch_pending` is the durable marker that an outbound RPC is owed for this execution identity. It survives
        // a relay restart, so a claim committed just before a crash is re-driven with the same IDs instead of being lost.
        // The claim is not an acknowledgement: a visible block stays until the matching dispatch/resume ACK clears it.
        // Each claim opens a new dispatch obligation. Its epoch travels with the RPC the relay sends, so a late
        // acknowledgement of an older obligation can never clear a newer one.
        const changed = db.prepare(`UPDATE tasks SET status='running', execution_id=?, claim_at=?, heartbeat_at=?, next_at=0,
          dispatch_pending=1, dispatch_attempts=0, dispatch_epoch=dispatch_epoch+1, run_fence=?, updated_at=? WHERE id=? AND status='queued' AND not_before<=?`)
          .run(executionId, now, now, runFence, iso(now), next.id, now);
        if (changed.changes !== 1) return undefined;
        return row.get(next.id);
      });
    },

    // An unacknowledged dispatch or resume keeps the Task running with the same execution identity and stays pending.
    // It is retried after a backoff; nothing about the execution is replaced.
    retryDispatch(taskId, executionId, now, reason = null, { epoch } = {}) {
      return transaction(() => {
        const task = row.get(taskId);
        if (!task || task.status !== 'running' || task.execution_id !== executionId) return false;
        // The accepted finish is the durable terminal boundary. A lost acknowledgement, an exhausted retry budget, or a
        // lost answer must not downgrade it to a failure: settle it from the receipt instead, whatever obligation the
        // caller thought it was retrying.
        if (task.finish_accepted_at) {
          db.prepare(`UPDATE tasks SET status='done', outcome=?, failure=NULL, execution_kind='start', resume_item_id=NULL,
            context=NULL, claim_at=NULL, dispatch_pending=0, dispatch_epoch=dispatch_epoch+1, next_at=0, blocked_reason=NULL, updated_at=? WHERE id=?`)
            .run(plain(task.finish_summary ?? 'The Task finished.', MAX_SUMMARY), iso(now), taskId);
          addEvent.run(taskId, task.scope, 'outcome', `Task “${task.title}” finished.`, iso(now));
          return 'settled';
        }
        // The retry belongs to the obligation that failed. A newer block, response, or finish already replaced it, so this
        // late report must not reset its backoff or hide it.
        if (epoch !== undefined && task.dispatch_epoch !== epoch) return false;
        const attempts = task.dispatch_attempts + 1;
        if (attempts > MAX_DISPATCH_ATTEMPTS) {
          db.prepare(`UPDATE tasks SET status='failed', failure=?, outcome=NULL, execution_kind='start', resume_item_id=NULL,
            context=NULL, claim_at=NULL, dispatch_pending=0, next_at=0, updated_at=? WHERE id=?`).run(
            plain(reason ?? 'The worker did not accept the execution.', MAX_NOTE), iso(now), taskId);
          addEvent.run(taskId, task.scope, 'outcome', `Task “${task.title}” failed.`, iso(now));
          return 'failed';
        }
        db.prepare(`UPDATE tasks SET dispatch_pending=1, dispatch_attempts=?, next_at=?, updated_at=? WHERE id=?`)
          .run(attempts, now + delay(attempts), iso(now), taskId);
        return 'pending';
      });
    },

    // A running Task whose outbound RPC is owed and due: a dispatch, or the delivery of an Inbox response.
    dueDispatch(now, limit = 4) {
      return db.prepare(`SELECT * FROM tasks WHERE status='running' AND dispatch_pending=1 AND next_at<=?
        ORDER BY claim_at, rowid LIMIT ?`).all(now, Math.min(Math.max(limit, 1), 16));
    },

    // The worker accepted the RPC for exactly this dispatch obligation. A late acknowledgement from an earlier attempt
    // (an answer still in flight when the worker reported a block, a newer response, or an accepted finish) must not
    // clear the newer recovery, so the epoch identifies the obligation, not only the execution identity. The worker also
    // reports the admission that is current after handling the RPC: that is the durable record of a continuation admitted
    // for the same execution, and it becomes the fence, so a settlement from an older admission is refused instead of
    // ending live work. Reporting the same admission again after a recovery reopens exactly that admission and no other.
    ackDispatch(taskId, executionId, epoch, now = Date.now(), run) {
      if (!Number.isSafeInteger(epoch)) return false;
      return transaction(() => {
        const changed = db.prepare(`UPDATE tasks SET dispatch_pending=0, dispatch_attempts=0, next_at=0, blocked_reason=NULL, updated_at=?
          WHERE id=? AND execution_id=? AND status='running' AND dispatch_pending=1 AND dispatch_epoch=?`)
          .run(iso(now), taskId, executionId, epoch);
        if (changed.changes !== 1) return false;
        if (admissionRun(run) !== undefined) {
          db.prepare('UPDATE tasks SET run_fence=? WHERE id=?').run(run, taskId);
        }
        return true;
      });
    },

    // A recoverable refusal (an unavailable profile, a lost worktree, a worker that predates this Task protocol) keeps
    // the Task running but blocks dispatch with a visible reason. It is retried with a bounded backoff; restoring the
    // worker/profile/workspace makes the same execution eligible again. It never substitutes another selection.
    block(taskId, executionId, reason, now = Date.now(), retryAfterMs = 60_000, { epoch, run } = {}) {
      return transaction(() => {
        const task = row.get(taskId);
        if (!task || task.status !== 'running' || task.execution_id !== executionId || task.finish_accepted_at) return false;
        if (epoch !== undefined && task.dispatch_epoch !== epoch) return false;
        const first = task.blocked_reason !== reason;
        // A block schedules a new recovery obligation, so it opens its own epoch: the dispatch or resume RPC that is still
        // in flight belongs to the previous one and its acknowledgement must not clear this block. It also withdraws the
        // admission that reported it: the submission behind that run has ended, so only a newer admission (a continuation)
        // may settle this Task from now on. A settlement from the blocked run that is already in flight is refused below.
        const runFence = admissionRun(run) === undefined ? 0 : run + 1;
        db.prepare(`UPDATE tasks SET blocked_reason=?, dispatch_pending=1, dispatch_attempts=0, dispatch_epoch=dispatch_epoch+1,
          run_fence=MAX(run_fence,?), next_at=?, updated_at=? WHERE id=?`)
          .run(plain(reason, MAX_NOTE), runFence, now + Math.min(Math.max(retryAfterMs, 1_000), 300_000), iso(now), taskId);
        if (first) addEvent.run(taskId, task.scope, 'blocked', `Task “${task.title}” is blocked: ${plain(reason, MAX_NOTE)}`, iso(now));
        return true;
      });
    },

    park({ taskId, executionId, kind, prompt, key, now = Date.now() }) {
      return transaction(() => {
        const previous = receipt(key, taskId, 'inbox');
        if (previous) return previous;
        const task = fenced(taskId, executionId);
        if (task.finish_accepted_at) throw bad(409, 'Finish was accepted; this execution cannot open another Inbox item');
        if (openItem.get(taskId)) throw bad(409, 'This task already has an open Inbox item');
        const id = newId();
        db.prepare('INSERT INTO task_inbox_items(id,task_id,kind,prompt,status,created_at) VALUES(?,?,?,?, \'open\', ?)')
          .run(id, taskId, kind, plain(prompt, MAX_PROMPT), iso(now));
        setStatus.run('waiting', 'resume', id, null, null, now, 0, iso(now), taskId);
        const text = kind === 'question'
          ? `Task “${task.title}” is waiting for input: ${plain(prompt, MAX_NOTE)}`
          : `Task “${task.title}” submitted a report for review: ${plain(prompt, MAX_NOTE)}`;
        addEvent.run(taskId, task.scope, 'inbox', text, iso(now));
        return remember(key, taskId, 'inbox', { itemId: id, status: 'open' }, now);
      });
    },

    progress({ taskId, executionId, note, key, now = Date.now() }) {
      return transaction(() => {
        const previous = receipt(key, taskId, 'progress');
        if (previous) return previous;
        const task = fenced(taskId, executionId);
        if (task.finish_accepted_at) throw bad(409, 'Finish was accepted; this execution can no longer report progress');
        db.prepare('INSERT INTO task_progress(task_id,execution_id,note,created_at) VALUES(?,?,?,?)')
          .run(taskId, executionId, plain(note, MAX_NOTE), iso(now));
        db.prepare('UPDATE tasks SET heartbeat_at=?, updated_at=? WHERE id=?').run(now, iso(now), taskId);
        return remember(key, taskId, 'progress', { ok: true }, now);
      });
    },

    heartbeat({ taskId, executionId, now = Date.now() }) {
      const changed = db.prepare(`UPDATE tasks SET heartbeat_at=? WHERE id=? AND status='running' AND execution_id=?`)
        .run(now, taskId, executionId);
      return changed.changes === 1;
    },

    // The worker refused an execution for a reason no retry can fix, such as a pinned blueprint revision it no longer
    // has. The Task ends failed with that reason instead of running something else.
    failExecution(taskId, executionId, reason, now = Date.now()) {
      return transaction(() => {
        const task = row.get(taskId);
        if (!task || task.status !== 'running' || task.execution_id !== executionId || task.finish_accepted_at) return false;
        db.prepare(`UPDATE tasks SET status='failed', outcome=NULL, failure=?, execution_kind='start', resume_item_id=NULL,
          context=NULL, claim_at=NULL, dispatch_pending=0, dispatch_epoch=dispatch_epoch+1, next_at=0, blocked_reason=NULL, updated_at=? WHERE id=?`).run(plain(reason, MAX_NOTE), iso(now), taskId);
        addEvent.run(taskId, task.scope, 'outcome', `Task “${task.title}” failed.`, iso(now));
        return true;
      });
    },

    meta(id) {
      const task = row.get(id);
      return task && {
        agent: task.agent, scope: task.scope, status: task.status, executionId: task.execution_id,
        finishAccepted: Boolean(task.finish_accepted_at), finishSummary: task.finish_summary ?? null,
        blocked: task.blocked_reason ?? null, handoff: task.handoff_evidence ? JSON.parse(task.handoff_evidence) : null,
        review: task.review_snapshot ? JSON.parse(task.review_snapshot) : null,
        requiresPullRequest: task.requires_pr === 1, finishRequired: task.finish_required === 1,
        repository: task.blueprint_snapshot ? (JSON.parse(task.blueprint_snapshot).repository ?? null) : null,
      };
    },

    inboxItem(itemId) {
      return item.get(itemId);
    },

    // The worker's explicit finish, recorded before it reports the outcome. Replaying the same finish returns the same
    // receipt; a finish from an older or stale execution is refused. Acceptance does not settle the Task: the worker's
    // final turn still has to end, and only `settle` records the terminal outcome.
    acceptFinish({ taskId, executionId, summary, evidence, key, now = Date.now(), run }) {
      return transaction(() => {
        const previous = receipt(key, taskId, 'finish');
        if (previous) return previous;
        const task = fenced(taskId, executionId, { allowQueued: true });
        if (task.status !== 'running') throw bad(409, 'Execution is not running');
        // Acceptance is the durable terminal boundary. A repeated finish from the same execution is a replay even with a
        // different operation key, so a lost acknowledgement is recoverable from authoritative state.
        if (task.finish_accepted_at) {
          return { accepted: true, replay: true, summary: task.finish_summary ?? null,
            ...(task.handoff_evidence && { evidence: JSON.parse(task.handoff_evidence) }) };
        }
        // A finish belongs to one admission. A recovery block withdraws the admission that reported it, so a finish from
        // that run that is already in flight is refused instead of marking a newer continuation complete.
        if (admissionRun(run) !== undefined && task.run_fence > run) {
          throw bad(409, 'This finish belongs to a submission that is no longer current');
        }
        // A pull request is mandatory evidence for this Task, whatever the rollout mode says about finish enforcement.
        if (task.requires_pr === 1) {
          const commit = evidence?.commit;
          if (commit === undefined) throw bad(409, 'A pull request and its Task commit are required for this Task');
          try {
            const repository = task.blueprint_snapshot ? JSON.parse(task.blueprint_snapshot)?.repository : undefined;
            validatePullRequestEvidence({
              url: evidence?.pullRequest?.url, commit: evidence?.pullRequest?.commit, expectedCommit: commit,
              destination: githubRepository(repository?.remote),
            });
          } catch (error) {
            throw bad(409, error.message);
          }
        }
        db.prepare(`UPDATE tasks SET finish_accepted_at=?, finish_summary=?, handoff_evidence=?, blocked_reason=NULL,
          dispatch_pending=0, dispatch_attempts=0, dispatch_epoch=dispatch_epoch+1, run_fence=MAX(run_fence,?), next_at=0,
          execution_kind='start', resume_item_id=NULL, updated_at=? WHERE id=?`)
          .run(iso(now), plain(summary, MAX_SUMMARY), evidence === undefined ? null : JSON.stringify(evidence),
            admissionRun(run) ?? 0, iso(now), taskId);
        return remember(key, taskId, 'finish', { accepted: true, ...(evidence && { evidence }) }, now);
      });
    },

    settle({ taskId, executionId, outcome, summary, deliveredItems = [], key, now = Date.now(), run }) {
      return transaction(() => {
        const task = row.get(taskId);
        // Delivery is recorded only from the worker's own receipt for that item. A settle can land while the answer is
        // still queued, or while the resume RPC is in flight, so the settle alone proves nothing about delivery; the
        // outcome is recorded below either way, and the two facts never collapse into one. The accepted finish may already
        // have cleared the resume obligation, so the receipt is matched against this Task's items, not only the current
        // resume slot.
        if (task && task.execution_id === executionId) {
          for (const itemId of deliveredItems) {
            db.prepare(`UPDATE task_inbox_items SET delivered_at=? WHERE id=? AND task_id=? AND delivered_at IS NULL`)
              .run(iso(now), itemId, taskId);
          }
        }
        // Stamping is idempotent and stays ahead of the receipt, so evidence that arrives with a retried settle is still
        // recorded when the first attempt's receipt answers the call.
        const previous = receipt(key, taskId, 'settle');
        if (previous) return previous;
        const fencedTask = fenced(taskId, executionId, { allowQueued: true });
        if (!['done', 'failed'].includes(outcome)) throw bad(400, 'Invalid outcome');
        // The settlement names the admission it belongs to. A recovery block, or a continuation admitted after one, moves
        // the fence forward, so a settlement that was already in flight when that happened is refused here: the relay is
        // authoritative about which submission is live and does not rely on the worker noticing its own staleness. An
        // accepted finish is exempt, because it is a one-way boundary that no later admission can replace and it still has
        // to be settled from its own admission.
        if (admissionRun(run) !== undefined && fencedTask.run_fence > run && !fencedTask.finish_accepted_at) {
          throw bad(409, 'This settlement belongs to a submission that is no longer current');
        }
        // A bare final turn is success only for a genuinely legacy assignment: a row that records no pinned snapshot, no
        // profile, no review binding, and no pull-request requirement. Anything structured succeeds only through an
        // accepted finish, whose evidence this ledger validated. This is independent of `finish_required`, so a migrated or
        // hand-edited row can never bare-settle its way around a required pull request or a pinned assignment.
        const legacyBareFinal = fencedTask.finish_required === 0 && fencedTask.requires_pr !== 1 &&
          !fencedTask.blueprint_snapshot && !fencedTask.profile_snapshot && !fencedTask.review_snapshot;
        if (outcome === 'done' && !fencedTask.finish_accepted_at && !legacyBareFinal) {
          throw bad(409, 'Finish is required before a Task can succeed');
        }
        // An accepted finish is a one-way terminal boundary. A later failure report cannot downgrade it; the worker must
        // retry the done settle instead.
        if (outcome !== 'done' && fencedTask.finish_accepted_at) {
          throw bad(409, 'Finish was accepted; this Task cannot be recorded as failed');
        }
        db.prepare(`UPDATE tasks SET status=?, outcome=?, failure=?, execution_kind='start', resume_item_id=NULL, context=NULL,
          claim_at=NULL, dispatch_pending=0, dispatch_epoch=dispatch_epoch+1, run_fence=MAX(run_fence,?), next_at=0,
          blocked_reason=NULL, updated_at=? WHERE id=?`)
          .run(outcome, outcome === 'done' ? plain(summary, MAX_SUMMARY) : null,
            outcome === 'failed' ? plain(summary, MAX_SUMMARY) : null, admissionRun(run) ?? 0, iso(now), taskId);
        addEvent.run(taskId, fencedTask.scope, 'outcome',
          outcome === 'done' ? `Task “${fencedTask.title}” finished.` : `Task “${fencedTask.title}” failed.`, iso(now));
        return remember(key, taskId, 'settle', { status: outcome }, now);
      });
    },

    // A response is the one authoritative transition from waiting to eligible. It closes the item, queues the SAME Task
    // for a resume of the SAME child execution, and records the notice in one SQLite transaction. It never inserts a
    // chat turn. An identical retry returns the recorded receipt; a conflicting one is refused.
    respond(scope, itemId, answer, now = Date.now()) {
      return transaction(() => {
        const record = item.get(itemId);
        if (!record) throw bad(404, 'Inbox item not found');
        const task = scoped.get(record.task_id, scope);
        if (!task) throw bad(404, 'Inbox item not found');
        const response = answer === null ? null : plain(answer, MAX_INPUT);
        const status = answer === null ? 'declined' : 'answered';
        // The receipt records what this response did, so an identical retry returns the same values even after the
        // scheduler has claimed the Task again.
        const receiptFor = () => ({ itemId, taskId: task.id, status, taskStatus: 'queued' });
        if (record.status !== 'open') {
          if (record.status !== status || record.response !== response) throw bad(409, 'This Inbox item is already resolved');
          return receiptFor();
        }
        if (task.finish_accepted_at) throw bad(409, 'Finish was accepted; this Inbox item can no longer advance the Task');
        if (task.status !== 'waiting' || task.resume_item_id !== itemId) throw bad(409, 'This Inbox item is not open for response');
        const changed = db.prepare(`UPDATE task_inbox_items SET status=?, response=?, responded_at=? WHERE id=? AND status='open'`)
          .run(status, response, iso(now), itemId);
        if (changed.changes !== 1) throw bad(409, 'This Inbox item is already resolved');
        const context = response === null
          ? `The owner declined the ${record.kind} “${record.prompt}”. Continue without that input, or finish and explain what is blocked.`
          : `The owner answered the ${record.kind} “${record.prompt}”:\n${response}`;
        db.prepare(`UPDATE tasks SET status='queued', execution_kind='resume', resume_item_id=?, context=?, next_at=0,
          dispatch_pending=0, dispatch_epoch=dispatch_epoch+1, updated_at=? WHERE id=?`).run(itemId, plain(context, MAX_CONTEXT), iso(now), task.id);
        addEvent.run(task.id, task.scope, 'response',
          `Task “${task.title}” received your ${status === 'declined' ? 'decline' : 'answer'} and is queued to resume.`, iso(now));
        return receiptFor();
      });
    },

    // The durable resume receipt: an item's `delivered_at` records that its response reached the child. A retried
    // delivery checks this first, so a lost acknowledgement never becomes a second delivery or a replacement child.
    resumeDelivered({ taskId, executionId, itemId, epoch, now = Date.now() }) {
      return transaction(() => {
        const task = row.get(taskId);
        if (!task || task.execution_id !== executionId) return false;
        if (task.status === 'cancelled') return false;
        // A fast finish can settle the Task before this report lands; the delivery still happened and is recorded.
        db.prepare(`UPDATE task_inbox_items SET delivered_at=? WHERE id=? AND task_id=? AND delivered_at IS NULL`).run(iso(now), itemId, taskId);
        // Clearing the resume slot also returns the Task to a plain execution obligation. The answer has reached the
        // child, so a later recovery (a workspace block, a restart) must reattach to that same admitted execution instead
        // of scheduling an empty resume with no item left to deliver. A late acknowledgement of an older item never clears
        // a newer response, and one that belongs to an older dispatch obligation never clears the newer recovery it was
        // superseded by: the slot is cleared, but the block and its scheduled retry stay exactly as they are.
        if (task.status === 'running' && task.resume_item_id === itemId) {
          db.prepare(`UPDATE tasks SET resume_item_id=NULL, execution_kind='start', updated_at=? WHERE id=? AND resume_item_id=?`)
            .run(iso(now), taskId, itemId);
          if (epoch === undefined || task.dispatch_epoch === epoch) {
            db.prepare(`UPDATE tasks SET dispatch_pending=0, next_at=0, blocked_reason=NULL, updated_at=? WHERE id=?`)
              .run(iso(now), taskId);
          }
        }
        return true;
      });
    },

    // The worker definitively reports that this execution can no longer receive the response (it was lost, wiped, or
    // already ended). The first slice never launches a replacement child for Inbox input: the Task ends failed with a
    // clear reason and the owner's response stays recorded on the item.
    resumeUnavailable({ taskId, executionId, itemId, reason, now = Date.now() }) {
      return transaction(() => {
        const task = row.get(taskId);
        if (!task || task.execution_id !== executionId || TERMINAL.has(task.status)) return false;
        const record = item.get(itemId);
        db.prepare(`UPDATE tasks SET status='failed', outcome=NULL, failure=?, execution_kind='start', resume_item_id=NULL,
          context=NULL, claim_at=NULL, dispatch_pending=0, dispatch_epoch=dispatch_epoch+1, next_at=0, blocked_reason=NULL, updated_at=? WHERE id=?`)
          .run(plain(reason, MAX_NOTE), iso(now), taskId);
        addEvent.run(taskId, task.scope, 'outcome',
          `Task “${task.title}” failed: its execution is no longer available.` +
          (record && record.response !== null ? ' Your response is saved in the Task.' : ''), iso(now));
        return true;
      });
    },

    cancel(scope, id, now = Date.now()) {
      return transaction(() => {
        const task = scoped.get(id, scope);
        if (!task) throw bad(404, 'Task not found');
        if (TERMINAL.has(task.status)) {
          if (task.status === 'cancelled') {
            return { task: taskView(task, now), executionId: task.execution_id ?? null, stopPending: task.stop_pending === 1 };
          }
          throw bad(409, 'Task is already terminal');
        }
        const open = openItem.get(id);
        if (open) db.prepare(`UPDATE task_inbox_items SET status='cancelled', responded_at=? WHERE id=?`).run(iso(now), open.id);
        // Cancellation is a ledger decision. Stopping the worker is a separate step, owed while an execution may exist
        // and retried until the worker confirms. Clearing the pending dispatch marker also stops a dispatch that has not
        // been sent yet; a dispatch that already reached the worker is stopped by the same step.
        const stopPending = task.execution_id === null ? 0 : 1;
        db.prepare(`UPDATE tasks SET status='cancelled', execution_kind='start', resume_item_id=NULL, context=NULL, claim_at=NULL,
          dispatch_pending=0, dispatch_epoch=dispatch_epoch+1, next_at=0, blocked_reason=NULL, stop_pending=?, stop_attempts=0, stop_next_at=0, updated_at=? WHERE id=?`)
          .run(stopPending, iso(now), id);
        addEvent.run(id, task.scope, 'outcome', `Task “${task.title}” was cancelled.`, iso(now));
        return { task: taskView(row.get(id), now), executionId: task.execution_id ?? null, stopPending: stopPending === 1 };
      });
    },

    // A cancelled Task whose worker stop is not confirmed yet. Retries are bounded and then leave `stopPending` set as a
    // visible, durable fact instead of claiming the worker stopped.
    dueStop(now, limit = 4) {
      return db.prepare(`SELECT * FROM tasks WHERE status='cancelled' AND stop_pending=1 AND stop_next_at<=?
        AND stop_attempts<? ORDER BY rowid LIMIT ?`).all(now, MAX_STOP_ATTEMPTS, Math.min(Math.max(limit, 1), 16));
    },

    ackStop(taskId, now = Date.now()) {
      const changed = db.prepare(`UPDATE tasks SET stop_pending=0, stop_confirmed_at=?, updated_at=?
        WHERE id=? AND status='cancelled' AND stop_pending=1`).run(iso(now), iso(now), taskId);
      return changed.changes === 1;
    },

    retryStop(taskId, now = Date.now()) {
      return transaction(() => {
        const task = row.get(taskId);
        if (!task || task.status !== 'cancelled' || task.stop_pending !== 1) return false;
        const attempts = task.stop_attempts + 1;
        db.prepare(`UPDATE tasks SET stop_attempts=?, stop_next_at=?, updated_at=? WHERE id=?`)
          .run(attempts, now + delay(attempts), iso(now), taskId);
        return true;
      });
    },

    // Notices are the durable projection of Task events into the originating conversation. Undelivered ones ride along
    // with the next orchestrator turn; all recent ones stay visible in the chat as recorded events.
    pendingNotices(scope, limit = MAX_NOTICES) {
      return db.prepare(`SELECT seq, task_id, kind, text, created_at FROM task_events
        WHERE scope=? AND delivered_at IS NULL ORDER BY seq LIMIT ?`).all(scope, limit);
    },

    notices(scope, limit = 20) {
      return db.prepare(`SELECT seq, task_id, kind, text, created_at, delivered_at FROM task_events
        WHERE scope=? ORDER BY seq DESC LIMIT ?`).all(scope, limit).reverse().map(event => ({
        taskId: event.task_id, kind: event.kind, text: event.text, createdAt: event.created_at,
      }));
    },

    markNoticesDelivered(seqs, turnId, now = Date.now()) {
      if (seqs.length === 0) return 0;
      const update = db.prepare('UPDATE task_events SET delivered_at=?, turn_id=? WHERE seq=? AND delivered_at IS NULL');
      return transaction(() => seqs.reduce((count, seq) => count + update.run(iso(now), turnId, seq).changes, 0));
    },

    status(id) {
      return row.get(id)?.status;
    },
  };
}
