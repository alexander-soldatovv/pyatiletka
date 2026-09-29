import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyatiletkaBot } from '../src/bot.js';
import { createStorage } from '../src/db.js';
import { collectReminders, runReminderPass } from '../src/reminders.js';
import { createMockMaxServer } from './mock-max/server.js';

const eventSalt = 'reminder-test-event-salt-123';

function profile(userId, birthYm = '1963-04') {
  return {
    user_id: String(userId),
    step: 'ready',
    sex: 'm',
    birth_ym: birthYm,
    region: 'moscow',
    employment: 'employee',
    early: 'no',
    bot_active: 1,
  };
}

function reservePastBoundaries(storage, userId) {
  storage.reserveReminder(userId, 'status_certificate', '2023-04', 'window-start');
  storage.reserveReminder(userId, 'property_tax_benefit', '2023-04', 'tax-start');
}

test('годовой шаг возвращается после 1 января и напоминает в календарную дату', () => {
  const user = profile(1);
  const completed2026 = [{ task_id: 'dispensary_and_days', period: '2026', status: 'done' }];
  const in2026 = collectReminders({
    user,
    taskStates: completed2026,
    now: { year: 2026, month: 4, day: 1 },
    annualDates: ['04-01', '09-01', '11-01'],
  });
  assert.equal(in2026.some((item) => item.bucket === 'annual:04-01'), false);

  const in2027 = collectReminders({
    user,
    taskStates: completed2026,
    now: { year: 2027, month: 4, day: 1 },
    annualDates: ['04-01', '09-01', '11-01'],
  });
  assert.equal(in2027.find((item) => item.bucket === 'annual:04-01').period, '2027');
});

test('вехи формируются ровно за 12, 3 и 1 месяц', () => {
  const user = profile(1, '1964-01');
  const cases = [
    [{ year: 2028, month: 1, day: 15 }, 'before-right:12', 'pension_rights_check'],
    [{ year: 2028, month: 10, day: 15 }, 'before-right:3', 'pension_application'],
    [{ year: 2028, month: 12, day: 15 }, 'before-right:1', 'pension_application'],
  ];
  for (const [now, bucket, taskId] of cases) {
    const candidate = collectReminders({ user, taskStates: [], now, annualDates: [] })
      .find((item) => item.bucket === bucket);
    assert.equal(candidate.taskId, taskId);
  }
  assert.equal(
    collectReminders({ user, taskStates: [], now: { year: 2028, month: 11, day: 15 }, annualDates: [] })
      .some((item) => item.bucket.startsWith('before-right:')),
    false,
  );
});

test('вне окна времени проход ничего не отправляет', async () => {
  const storage = createStorage({ eventSalt });
  storage.saveUser(profile(1));
  try {
    const result = await runReminderPass({
      storage,
      send: async () => { throw new Error('не должен вызываться'); },
      clock: () => new Date('2026-04-01T08:59:00Z'),
      timeZone: 'UTC',
    });
    assert.equal(result.skipped, 'outside_window');
    assert.equal(storage.getRemindersForTest(1).length, 0);
  } finally {
    storage.close();
  }
});

test('перезапуск процесса не отправляет уже зарезервированное напоминание', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pyatiletka-reminder-'));
  const path = join(directory, 'state.sqlite');
  const sent = [];
  let storage = createStorage({ path, eventSalt });
  storage.saveUser(profile(1));
  reservePastBoundaries(storage, 1);
  try {
    const options = {
      send: async (_userId, view) => { sent.push(view.text); },
      clock: () => new Date('2026-04-01T10:00:00Z'),
      timeZone: 'UTC',
    };
    assert.equal((await runReminderPass({ storage, ...options })).sent, 1);
    storage.close();
    storage = createStorage({ path, eventSalt });
    assert.equal((await runReminderPass({ storage, ...options })).sent, 0);
    assert.equal(sent.length, 1);
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('отписавшийся пользователь пропускается, ошибка одного не мешает остальным', async () => {
  const storage = createStorage({ eventSalt });
  for (const userId of [1, 2, 3, 4]) {
    storage.saveUser(profile(userId));
    reservePastBoundaries(storage, userId);
  }
  storage.setBotActive(4, false);
  const sent = [];
  try {
    const first = await runReminderPass({
      storage,
      send: async (userId) => {
        if (String(userId) === '2') throw Object.assign(new Error('private details'), { code: 'mock_send' });
        sent.push(String(userId));
      },
      clock: () => new Date('2026-04-01T10:00:00Z'),
      timeZone: 'UTC',
      logger: { error() {} },
    });
    assert.deepEqual(first, { skipped: null, users: 3, sent: 2, failed: 1 });
    assert.deepEqual(sent.sort(), ['1', '3']);
    assert.equal(storage.getRemindersForTest(2).some((item) => item.bucket === 'annual:04-01'), false);
    assert.equal(storage.getRemindersForTest(4).some((item) => item.bucket === 'annual:04-01'), false);

    const second = await runReminderPass({
      storage,
      send: async (userId) => { sent.push(String(userId)); },
      clock: () => new Date('2026-04-01T10:05:00Z'),
      timeZone: 'UTC',
    });
    assert.equal(second.sent, 1);
    assert.equal(sent.at(-1), '2');
  } finally {
    storage.close();
  }
});

test('200 виртуальных пользователей получают по одному сообщению через mock MAX', async () => {
  const max = await createMockMaxServer();
  const storage = createStorage({ eventSalt });
  const { sendToUser } = createPyatiletkaBot({
    storage,
    config: { botToken: 'mock-token', maxApiBase: max.baseUrl, reminderTz: 'UTC' },
    queueOptions: { minIntervalMs: 500 },
  });
  try {
    for (let userId = 1; userId <= 200; userId += 1) {
      storage.saveUser(profile(userId));
      reservePastBoundaries(storage, userId);
    }
    const result = await runReminderPass({
      storage,
      send: sendToUser,
      clock: () => new Date('2026-04-01T10:00:00Z'),
      timeZone: 'UTC',
    });
    assert.equal(result.sent, 200);
    assert.equal(result.failed, 0);
    assert.equal(max.state.messages.length, 200);
    const perDialog = Map.groupBy(max.state.messages, (message) => message.chatId);
    assert.equal(perDialog.size, 200);
    assert.equal([...perDialog.values()].every((messages) => messages.length === 1), true);
  } finally {
    storage.close();
    await max.close();
  }
});
