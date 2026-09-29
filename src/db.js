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

function normalizeCohort(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : '';
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
      cohort TEXT NOT NULL DEFAULT '',
      bot_active INTEGER NOT NULL DEFAULT 1 CHECK (bot_active IN (0, 1)),
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
      cohort TEXT NOT NULL DEFAULT '',
      ts TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_user_hash ON events(user_hash);
  `);

  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
  if (!userColumns.has('cohort')) db.exec("ALTER TABLE users ADD COLUMN cohort TEXT NOT NULL DEFAULT ''");
  if (!userColumns.has('bot_active')) db.exec('ALTER TABLE users ADD COLUMN bot_active INTEGER NOT NULL DEFAULT 1');
  const eventColumns = new Set(db.prepare('PRAGMA table_info(events)').all().map((column) => column.name));
  if (!eventColumns.has('cohort')) db.exec("ALTER TABLE events ADD COLUMN cohort TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_cohort_type ON events(cohort, type)');

  const timestamp = () => now().toISOString();

  const statements = {
    getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
    upsertUser: db.prepare(`
      INSERT INTO users (
        user_id, step, sex, birth_ym, region, employment, early, cohort, bot_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        step = excluded.step,
        sex = excluded.sex,
        birth_ym = excluded.birth_ym,
        region = excluded.region,
        employment = excluded.employment,
        early = excluded.early,
        cohort = excluded.cohort,
        bot_active = excluded.bot_active,
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
    releaseReminder: db.prepare(`
      DELETE FROM reminders WHERE user_id = ? AND task_id = ? AND period = ? AND bucket = ?
    `),
    getReminders: db.prepare(`
      SELECT task_id, period, bucket, sent_at FROM reminders WHERE user_id = ? ORDER BY task_id, period, bucket
    `),
    listReminderUsers: db.prepare("SELECT * FROM users WHERE step = 'ready' AND bot_active = 1 ORDER BY user_id"),
    setBotActive: db.prepare('UPDATE users SET bot_active = ?, updated_at = ? WHERE user_id = ?'),
    addEvent: db.prepare('INSERT INTO events (user_hash, type, payload, cohort, ts) VALUES (?, ?, ?, ?, ?)'),
    getEvents: db.prepare('SELECT type, payload, cohort, ts FROM events WHERE user_hash = ? ORDER BY id'),
    aggregateEvents: db.prepare(`
      SELECT type, COUNT(*) AS count FROM events
      WHERE (? = '' OR cohort = ?)
      GROUP BY type ORDER BY type
    `),
    aggregateUsers: db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN step = 'ready' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN bot_active = 1 THEN 1 ELSE 0 END) AS active
      FROM users WHERE (? = '' OR cohort = ?)
    `),
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
      const cohort = normalizeCohort(user.cohort ?? existing?.cohort ?? '');
      const botActive = user.bot_active == null ? (existing?.bot_active ?? 1) : (user.bot_active ? 1 : 0);
      statements.upsertUser.run(
        String(user.user_id),
        user.step,
        user.sex ?? null,
        user.birth_ym ?? null,
        user.region ?? null,
        user.employment ?? null,
        user.early ?? null,
        cohort,
        botActive,
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

    releaseReminder(userId, taskId, period, bucket) {
      return statements.releaseReminder.run(
        String(userId),
        taskId,
        String(period ?? ''),
        bucket,
      ).changes === 1;
    },

    getRemindersForTest(userId) {
      return statements.getReminders.all(String(userId));
    },

    listReminderUsers() {
      return statements.listReminderUsers.all();
    },

    setBotActive(userId, active) {
      const id = String(userId);
      const result = statements.setBotActive.run(active ? 1 : 0, timestamp(), id);
      if (result.changes === 0) this.saveUser({ user_id: id, step: 'idle', bot_active: active });
      return this.getUser(id);
    },

    recordEvent(userId, type, payload = null, options = {}) {
      const hash = userHash(userId, eventSalt);
      const cohort = normalizeCohort(options.cohort ?? this.getUser(userId)?.cohort ?? '');
      statements.addEvent.run(hash, type, payload == null ? null : JSON.stringify(payload), cohort, timestamp());
    },

    getEventsForTest(userId) {
      return statements.getEvents.all(userHash(userId, eventSalt)).map((event) => ({
        ...event,
        payload: parsePayload(event.payload),
      }));
    },

    getStats(cohort = '') {
      const normalized = normalizeCohort(cohort);
      if (cohort && !normalized) throw new RangeError('Некорректный код когорты');
      const events = Object.fromEntries(
        statements.aggregateEvents.all(normalized, normalized).map((row) => [row.type, Number(row.count)]),
      );
      const users = statements.aggregateUsers.get(normalized, normalized);
      return {
        cohort: normalized || null,
        users: {
          total: Number(users.total ?? 0),
          ready: Number(users.ready ?? 0),
          active: Number(users.active ?? 0),
        },
        events,
      };
    },

    healthCheck() {
      try {
        return db.prepare('SELECT 1 AS ok').get().ok === 1;
      } catch {
        return false;
      }
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
