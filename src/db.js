import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function userHash(userId, salt) {
  return createHmac('sha256', salt).update(String(userId)).digest('hex');
}

function parsePayload(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function createStorage({ path = ':memory:', eventSalt, now = () => new Date() } = {}) {
  if (typeof eventSalt !== 'string' || eventSalt.length < 16) {
    throw new Error('EVENT_SALT должен содержать не менее 16 символов');
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      step TEXT NOT NULL,
      sex TEXT,
      birth_ym TEXT,
      region TEXT,
      employment TEXT,
      early TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_state (
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('done', 'todo')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, task_id, period)
    );

    CREATE TABLE IF NOT EXISTS reminders (
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT '',
      bucket TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (user_id, task_id, period, bucket)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_hash TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT,
      ts TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_user_hash ON events(user_hash);
  `);

  const timestamp = () => now().toISOString();

  const statements = {
    getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
    upsertUser: db.prepare(`
      INSERT INTO users (
        user_id, step, sex, birth_ym, region, employment, early, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        step = excluded.step,
        sex = excluded.sex,
        birth_ym = excluded.birth_ym,
        region = excluded.region,
        employment = excluded.employment,
        early = excluded.early,
        updated_at = excluded.updated_at
    `),
    setTask: db.prepare(`
      INSERT INTO task_state (user_id, task_id, period, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, task_id, period) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at
    `),
    getTasks: db.prepare(`
      SELECT task_id, period, status, updated_at
      FROM task_state WHERE user_id = ? ORDER BY task_id, period
    `),
    addReminder: db.prepare(`
      INSERT OR IGNORE INTO reminders (user_id, task_id, period, bucket, sent_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    addEvent: db.prepare('INSERT INTO events (user_hash, type, payload, ts) VALUES (?, ?, ?, ?)'),
    getEvents: db.prepare('SELECT type, payload, ts FROM events WHERE user_hash = ? ORDER BY id'),
    deleteEvents: db.prepare('DELETE FROM events WHERE user_hash = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE user_id = ?'),
  };

  return {
    getUser(userId) {
      return statements.getUser.get(String(userId)) ?? null;
    },

    saveUser(user) {
      if (user?.user_id == null || typeof user.step !== 'string') {
        throw new TypeError('Нужны user_id и step');
      }
      const existing = statements.getUser.get(String(user.user_id));
      const time = timestamp();
      statements.upsertUser.run(
        String(user.user_id),
        user.step,
        user.sex ?? null,
        user.birth_ym ?? null,
        user.region ?? null,
        user.employment ?? null,
        user.early ?? null,
        existing?.created_at ?? time,
        time,
      );
      return this.getUser(user.user_id);
    },

    setTaskStatus(userId, taskId, status, period = '') {
      if (!['done', 'todo'].includes(status)) throw new RangeError('Некорректный статус задачи');
      statements.setTask.run(String(userId), taskId, String(period ?? ''), status, timestamp());
    },

    getTaskStates(userId) {
      return statements.getTasks.all(String(userId));
    },

    reserveReminder(userId, taskId, period, bucket) {
      const result = statements.addReminder.run(
        String(userId),
        taskId,
        String(period ?? ''),
        bucket,
        timestamp(),
      );
      return result.changes === 1;
    },

    recordEvent(userId, type, payload = null) {
      const hash = userHash(userId, eventSalt);
      statements.addEvent.run(hash, type, payload == null ? null : JSON.stringify(payload), timestamp());
    },

    getEventsForTest(userId) {
      return statements.getEvents.all(userHash(userId, eventSalt)).map((event) => ({
        ...event,
        payload: parsePayload(event.payload),
      }));
    },

    deleteUser(userId) {
      const id = String(userId);
      db.exec('BEGIN IMMEDIATE');
      try {
        statements.deleteEvents.run(userHash(id, eventSalt));
        const result = statements.deleteUser.run(id);
        db.exec('COMMIT');
        return result.changes === 1;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    close() {
      db.close();
    },
  };
}

export { userHash };

