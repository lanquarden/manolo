import { DatabaseSync } from 'node:sqlite';
import { validTranscript, validVoiceFileId } from './speech.mjs';
import { key, routeKey, SNOWFLAKE } from './relay-config.mjs';

const conflict = () => Object.assign(new Error('Turn ID was already used'), { statusCode: 409 });
const webStatus = row => {
  if (row.state === 'done') return { status: 'done', text: row.output };
  if (row.state === 'failed') return { status: 'failed', text: 'This turn could not be completed.' };
  return { status: 'pending' };
};

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
    CREATE TABLE IF NOT EXISTS discord_jobs (
      seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL, bot TEXT NOT NULL,
      turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
      user_id TEXT NOT NULL, chat_id TEXT NOT NULL, agent TEXT NOT NULL, input TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('submit','wait','send','sent','dead')),
      output TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bot,event_id)
    );
    CREATE INDEX IF NOT EXISTS discord_due ON discord_jobs(bot,state,next_at);
    CREATE INDEX IF NOT EXISTS discord_session ON discord_jobs(session_id,seq);
    CREATE TABLE IF NOT EXISTS web_turns (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL, owner TEXT NOT NULL, agent TEXT NOT NULL,
      turn_id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL, input TEXT NOT NULL, created_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('submit','wait','done','failed')),
      output TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS web_due ON web_turns(state,next_at);
    CREATE INDEX IF NOT EXISTS web_session ON web_turns(session_id,seq);
    CREATE TABLE IF NOT EXISTS relay_inbox (
      id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS relay_inbox_recipient ON relay_inbox(recipient, created_at);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(telegram_jobs)').all().map(row => row.name));
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!columns.has('voice_file_id')) db.exec('ALTER TABLE telegram_jobs ADD COLUMN voice_file_id TEXT');
    if (!columns.has('reply_message_id')) db.exec('ALTER TABLE telegram_jobs ADD COLUMN reply_message_id INTEGER');
    if (!columns.has('voice_reply')) db.exec('ALTER TABLE telegram_jobs ADD COLUMN voice_reply INTEGER NOT NULL DEFAULT 0');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const cursor = () => db.prepare('SELECT cursor FROM telegram_state WHERE id=1').get().cursor;
  const add = db.prepare(`INSERT INTO telegram_jobs
    (update_id,turn_id,session_id,user_id,chat_id,agent,input,voice_file_id,reply_message_id,voice_reply,state)
    VALUES (?,?,?,?,?,?,?,?,?,?,'submit')`);
  const active = "('submit','wait','send')";
  const selection = (table, extra, sequence, states) => db.prepare(`SELECT j.* FROM ${table} j WHERE j.state IN ${states} AND j.next_at<=? ${extra}
    AND NOT EXISTS(SELECT 1 FROM ${table} p WHERE p.session_id=j.session_id AND p.${sequence}<j.${sequence} AND p.state IN ${states})
    ORDER BY j.${sequence} LIMIT 10`);
  const discordReady = selection('discord_jobs', 'AND j.bot=?', 'seq', active);
  const webReady = selection('web_turns', '', 'seq', "('submit','wait')");
  const webLookup = db.prepare('SELECT * FROM web_turns WHERE turn_id=?');
  const webSession = (owner, agent) => key('web-session', owner, agent);
  const webId = (owner, agent, id) => key('web', owner, agent, id);
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
          if (!Number.isSafeInteger(updateId) || updateId < next || updateId >= Number.MAX_SAFE_INTEGER) continue;
          next = updateId + 1;
          if (envelope?.transport !== 'telegram') continue;
          const agent = routes.get(routeKey(envelope));
          if (agent) {
            const session = key('telegram', botScope, envelope.userId, envelope.chatId, agent);
            const { voiceFileId, messageId, text } = envelope;
            if (validVoiceFileId(voiceFileId) && envelope.userId === envelope.chatId && Number.isSafeInteger(messageId) && messageId > 0) {
              add.run(updateId, key(session, updateId), session, envelope.userId, envelope.chatId, agent, '', voiceFileId, messageId, 1);
            } else if (typeof text === 'string' && text.length > 0 && text.length <= 4000) {
              add.run(updateId, key(session, updateId), session, envelope.userId, envelope.chatId, agent, text, null, null, 0);
            }
          }
        }
        db.prepare('UPDATE telegram_state SET cursor=? WHERE id=1').run(next);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    ingestDiscord(envelope, routes, bot) {
      const { transport, eventId, userId, chatId, text } = envelope;
      if (transport !== 'discord' || ![eventId, userId, chatId, bot].every(value => typeof value === 'string' && SNOWFLAKE.test(value)) ||
          typeof text !== 'string' || !text.trim() || text.length > 4000) return false;
      const agent = routes.get(routeKey(envelope));
      if (!agent) return false;
      const session = key(transport, bot, userId, chatId, agent);
      return db.prepare(`INSERT INTO discord_jobs
        (event_id,bot,turn_id,session_id,user_id,chat_id,agent,input,state) VALUES (?,?,?,?,?,?,?,?,'submit')
        ON CONFLICT(bot,event_id) DO NOTHING`).run(eventId, bot, key(session, eventId), session, userId, chatId, agent, text).changes === 1;
    },
    due(now) {
      return db.prepare(`SELECT j.* FROM telegram_jobs j WHERE j.state IN ${active} AND j.next_at<=?
        AND NOT EXISTS(SELECT 1 FROM telegram_jobs p WHERE p.session_id=j.session_id AND p.update_id<j.update_id AND p.state IN ${active})
        ORDER BY j.update_id LIMIT 10`).all(now);
    },
    discordReady(now, bot) { return discordReady.all(now, bot); },
    transcribed(job, text) {
      if (!validTranscript(text)) throw new TypeError('Invalid stored transcript');
      db.prepare(`UPDATE telegram_jobs SET input=?, voice_file_id=NULL, next_at=0, attempts=0 WHERE update_id=? AND voice_file_id IS NOT NULL`)
        .run(text, job.update_id);
    },
    voiceFallback(job, text) {
      db.prepare(`UPDATE telegram_jobs SET state='send', voice_file_id=NULL, voice_reply=0, output=?, next_at=0, attempts=0 WHERE update_id=?`)
        .run(text, job.update_id);
    },
    advance(transport, job, state, output = null, next = 0, attempts = 0) {
      const [table, column, id] = transport === 'telegram'
        ? ['telegram_jobs', 'update_id', job.update_id] : ['discord_jobs', 'seq', job.seq];
      const terminal = ['sent', 'dead'].includes(state);
      const cleanup = terminal ? ", input=''" + (transport === 'telegram' ? ', voice_file_id=NULL, reply_message_id=NULL, voice_reply=0' : '') : '';
      db.prepare(`UPDATE ${table} SET state=?, output=?, next_at=?, attempts=?${cleanup} WHERE ${column}=?`)
        .run(state, terminal ? null : output, next, attempts, id);
    },
    webSubmit(owner, agent, id, text) {
      const turnId = webId(owner, agent, id);
      db.prepare(`INSERT INTO web_turns(id,owner,agent,turn_id,session_id,input,created_at,state)
        VALUES(?,?,?,?,?,?,?,'submit') ON CONFLICT(turn_id) DO NOTHING`)
        .run(id, owner, agent, turnId, webSession(owner, agent), text, new Date().toISOString());
      const row = webLookup.get(turnId);
      if (row.input !== text) throw conflict();
      return webStatus(row);
    },
    webTurn(owner, agent, id) {
      const row = webLookup.get(webId(owner, agent, id));
      return row && webStatus(row);
    },
    webHistory(owner, agent) {
      return db.prepare('SELECT * FROM web_turns WHERE session_id=? ORDER BY seq DESC LIMIT 30').all(webSession(owner, agent)).reverse().map(row => ({
        id: row.id, text: row.input, createdAt: row.created_at,
        status: webStatus(row).status, ...(row.state === 'done' && { reply: row.output }),
      }));
    },
    webReady(now) { return webReady.all(now); },
    webAdvance(job, state, output = null, next = 0, attempts = 0) {
      db.prepare('UPDATE web_turns SET state=?, output=?, next_at=?, attempts=? WHERE seq=?').run(state, output, next, attempts, job.seq);
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
