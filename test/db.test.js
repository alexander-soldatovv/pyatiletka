import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStorage, userHash } from '../src/db.js';

const eventSalt = 'test-only-salt-at-least-16';
const fixedNow = () => new Date('2026-09-29T12:00:00.000Z');

test('профиль сохраняется и обновляется без смены created_at', () => {
  const storage = createStorage({ eventSalt, now: fixedNow });
  try {
    const created = storage.saveUser({ user_id: 42, step: 'sex' });
    const updated = storage.saveUser({
      user_id: 42,
      step: 'ready',
      sex: 'm',
      birth_ym: '1963-04',
      region: 'moscow',
      employment: 'employee',
      early: 'no',
    });

    assert.equal(updated.user_id, '42');
    assert.equal(updated.step, 'ready');
    assert.equal(updated.created_at, created.created_at);
  } finally {
    storage.close();
  }
});

test('статус шага обновляется идемпотентно', () => {
  const storage = createStorage({ eventSalt, now: fixedNow });
  try {
    storage.saveUser({ user_id: 42, step: 'ready' });
    storage.setTaskStatus(42, 'dispensary_and_days', 'done', '2026');
    storage.setTaskStatus(42, 'dispensary_and_days', 'done', '2026');
    assert.equal(storage.getTaskStates(42).length, 1);
    assert.equal(storage.getTaskStates(42)[0].status, 'done');
  } finally {
    storage.close();
  }
});

test('напоминание резервируется только один раз', () => {
  const storage = createStorage({ eventSalt, now: fixedNow });
  try {
    storage.saveUser({ user_id: 42, step: 'ready' });
    assert.equal(storage.reserveReminder(42, 'task', '2026', 'april'), true);
    assert.equal(storage.reserveReminder(42, 'task', '2026', 'april'), false);
  } finally {
    storage.close();
  }
});

test('удаление пользователя удаляет профиль, шаги, напоминания и события', () => {
  const storage = createStorage({ eventSalt, now: fixedNow });
  try {
    storage.saveUser({ user_id: 42, step: 'ready' });
    storage.setTaskStatus(42, 'task', 'done');
    storage.reserveReminder(42, 'task', '', 'once');
    storage.recordEvent(42, 'setup_completed', { safe: true });

    assert.equal(storage.getEventsForTest(42).length, 1);
    assert.equal(storage.deleteUser(42), true);
    assert.equal(storage.getUser(42), null);
    assert.deepEqual(storage.getTaskStates(42), []);
    assert.deepEqual(storage.getEventsForTest(42), []);
  } finally {
    storage.close();
  }
});

test('хеш события стабилен и не содержит исходный ID', () => {
  const hash = userHash(42, eventSalt);
  assert.equal(hash.length, 64);
  assert.ok(!hash.includes('42'));
  assert.equal(hash, userHash(42, eventSalt));
});

test('короткая соль отклоняется', () => {
  assert.throws(() => createStorage({ eventSalt: 'short' }), /EVENT_SALT/);
});

test('состояние переживает повторное открытие базы', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pyatiletka-db-'));
  const path = join(directory, 'state.sqlite');
  let storage = createStorage({ path, eventSalt, now: fixedNow });
  storage.saveUser({ user_id: 42, step: 'birth', sex: 'm' });
  storage.close();

  try {
    storage = createStorage({ path, eventSalt, now: fixedNow });
    assert.equal(storage.getUser(42).step, 'birth');
    assert.equal(storage.getUser(42).sex, 'm');
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('активность бота, когорта и агрегаты сохраняются без исходного ID', () => {
  const storage = createStorage({ eventSalt, now: fixedNow });
  try {
    storage.saveUser({ user_id: 42, step: 'ready', cohort: 'pilot_hr' });
    storage.recordEvent(42, 'setup_completed');
    storage.setBotActive(42, false);
    assert.equal(storage.listReminderUsers().length, 0);
    storage.setBotActive(42, true);
    assert.equal(storage.listReminderUsers().length, 1);
    assert.deepEqual(storage.getStats('pilot_hr'), {
      cohort: 'pilot_hr',
      users: { total: 1, ready: 1, active: 1 },
      events: { setup_completed: 1 },
    });
  } finally {
    storage.close();
  }
});

test('резерв напоминания можно снять после ошибки отправки', () => {
  const storage = createStorage({ eventSalt, now: fixedNow });
  try {
    storage.saveUser({ user_id: 42, step: 'ready' });
    assert.equal(storage.reserveReminder(42, 'task', '2026', 'bucket'), true);
    assert.equal(storage.releaseReminder(42, 'task', '2026', 'bucket'), true);
    assert.equal(storage.reserveReminder(42, 'task', '2026', 'bucket'), true);
  } finally {
    storage.close();
  }
});

test('база P3 автоматически получает поля P4 без потери профиля', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pyatiletka-migration-'));
  const path = join(directory, 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY, step TEXT NOT NULL, sex TEXT, birth_ym TEXT,
      region TEXT, employment TEXT, early TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_hash TEXT NOT NULL,
      type TEXT NOT NULL, payload TEXT, ts TEXT NOT NULL
    );
    INSERT INTO users VALUES ('42', 'ready', 'm', '1963-04', 'moscow', 'employee', 'no', 'old', 'old');
  `);
  old.close();
  const storage = createStorage({ path, eventSalt, now: fixedNow });
  try {
    assert.equal(storage.getUser(42).birth_ym, '1963-04');
    assert.equal(storage.getUser(42).bot_active, 1);
    assert.equal(storage.getUser(42).cohort, '');
    storage.recordEvent(42, 'miniapp_opened');
    assert.equal(storage.getStats().events.miniapp_opened, 1);
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
