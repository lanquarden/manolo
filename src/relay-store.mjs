import { DatabaseSync } from 'node:sqlite';
import { key, routeKey } from './relay-config.mjs';

export function openRelayStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS telegram_state (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL, bot TEXT);
    INSERT OR IGNORE INTO telegram_state(id,cursor) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS telegram_jobs (
      update_id INTEGER PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
      user_id TEXT NOT NULL, chat_id TEXT NOT NULL, agent TEXT NOT NULL, input TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('submit', 'wait', 'send', 'sent', 'dead')),
      output TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS telegram_due ON telegram_jobs(state, next_at);
    CREATE INDEX IF NOT EXISTS telegram_session ON telegram_jobs(session_id, update_id);
    CREATE TABLE IF NOT EXISTS relay_inbox (
      id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS relay_inbox_recipient ON relay_inbox(recipient, created_at);
  `);
  const cursor = () => db.prepare('SELECT cursor FROM telegram_state WHERE id=1').get().cursor;
  const add = db.prepare(`INSERT INTO telegram_jobs
    (update_id,turn_id,session_id,user_id,chat_id,agent,input,state) VALUES (?,?,?,?,?,?,?,'submit')`);
  const active = "('submit','wait','send')";
  return {
    db,
    cursor,
    bindBot(bot) {
      if (!/^[1-9][0-9]*$/.test(bot ?? '')) throw new Error('Expected a Telegram bot token with a numeric bot ID');
      db.prepare('UPDATE telegram_state SET bot=? WHERE id=1 AND bot IS NULL').run(bot);
      if (db.prepare('SELECT bot FROM telegram_state WHERE id=1').get().bot !== bot) {
        throw new Error('This relay data directory is already bound to another Telegram bot');
      }
    },
    ingest(updates, routes, botScope) {
      db.exec('BEGIN IMMEDIATE');
      try {
        let next = cursor();
        for (const { updateId, envelope } of updates) {
          if (!Number.isSafeInteger(updateId) || updateId < next) continue;
          next = updateId + 1;
          if (envelope?.transport !== 'telegram') continue;
          const agent = routes.get(routeKey(envelope));
          if (agent) {
            const session = key('telegram', botScope, envelope.userId, envelope.chatId, agent);
            add.run(updateId, key(session, updateId), session, envelope.userId, envelope.chatId, agent, envelope.text);
          }
        }
        db.prepare('UPDATE telegram_state SET cursor=? WHERE id=1').run(next);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    due(now) {
      return db.prepare(`SELECT j.* FROM telegram_jobs j WHERE j.state IN ${active} AND j.next_at<=?
        AND NOT EXISTS(SELECT 1 FROM telegram_jobs p WHERE p.session_id=j.session_id AND p.update_id<j.update_id AND p.state IN ${active})
        ORDER BY j.update_id LIMIT 10`).all(now);
    },
    advance(job, state, output = null, next = 0, attempts = 0) {
      db.prepare(`UPDATE telegram_jobs SET state=?, output=?, next_at=?, attempts=?,
        input=CASE WHEN ? IN ('sent','dead') THEN '' ELSE input END WHERE update_id=?`)
        .run(state, ['sent', 'dead'].includes(state) ? null : output, next, attempts, state, job.update_id);
    },
    inbox(from, to, text, idempotencyKey) {
      const id = key('inbox', from, idempotencyKey);
      const createdAt = new Date().toISOString();
      const existing = db.prepare('SELECT recipient,body FROM relay_inbox WHERE id=?').get(id);
      if (existing) {
        if (existing.recipient !== to || existing.body !== text) throw Object.assign(new Error('Duplicate inbox key'), { statusCode: 409 });
      } else {
        db.prepare('INSERT INTO relay_inbox VALUES (?,?,?,?,?)').run(id, from, to, text, createdAt);
      }
      return { id };
    },
    messages(agent) {
      return db.prepare(`SELECT id, sender AS "from", body AS text, created_at AS createdAt
        FROM relay_inbox WHERE recipient=? ORDER BY created_at DESC, rowid DESC LIMIT 50`).all(agent);
    },
  };
}
