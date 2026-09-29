import { Keyboard } from '@maxhub/max-bot-api';
import { setTimeout as sleep } from 'node:timers/promises';
import { profileFromUser } from './bot.js';
import { safeErrorDetails } from './metrics.js';
import { buildPlan, loadRulesData } from './rules.js';

const MILESTONES = new Map([
  [12, {
    taskId: 'pension_rights_check',
    text: 'До ориентировочной даты права около года. Проверьте стаж и пенсионные баллы заранее.',
  }],
  [3, {
    taskId: 'pension_application',
    text: 'До ориентировочной даты права около трёх месяцев. Пора уточнить дату в СФР и подготовить документы.',
  }],
  [1, {
    taskId: 'pension_application',
    text: 'До ориентировочной даты права около месяца. Уточните право в СФР и проверьте порядок подачи заявления.',
  }],
]);

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
  };
}

function yearMonth(value) {
  return `${value.year}-${String(value.month).padStart(2, '0')}`;
}

function reminderView(text, taskId) {
  return {
    text: `${text}\n\nДаты ориентировочные. Точную дату и статус подтверждает СФР.`,
    buttons: [[Keyboard.button.callback('Открыть шаг', `reminder:open:${taskId}`)]],
  };
}

export function collectReminders({ user, taskStates, now, annualDates, data = loadRulesData() }) {
  const profile = profileFromUser(user);
  if (!profile || user.bot_active === 0) return [];
  const plan = buildPlan({ profile, now, taskStates, data });
  const task = (taskId) => plan.tasks.find((item) => item.id === taskId);
  const candidates = [];
  const today = `${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
  const annual = task('dispensary_and_days');

  if (annual && !annual.completed && annual.availability === 'due' && annualDates.includes(today)) {
    candidates.push({
      taskId: annual.id,
      period: String(now.year),
      bucket: `annual:${today}`,
      view: reminderView('Напоминание о диспансеризации: в этом году шаг ещё не отмечен. Проверьте запись и согласуйте дни с работодателем.', annual.id),
    });
  }

  const milestone = MILESTONES.get(plan.calculation.months_to_right);
  const milestoneTask = milestone && task(milestone.taskId);
  if (milestoneTask && !milestoneTask.completed) {
    candidates.push({
      taskId: milestoneTask.id,
      period: yearMonth(plan.calculation.right),
      bucket: `before-right:${plan.calculation.months_to_right}`,
      view: reminderView(milestone.text, milestoneTask.id),
    });
  }

  const statusTask = task('status_certificate');
  if (statusTask && !statusTask.completed && plan.calculation.months_to_window <= 0) {
    candidates.push({
      taskId: statusTask.id,
      period: yearMonth(plan.calculation.window_start),
      bucket: 'window-start',
      view: reminderView('Ориентировочно начался предпенсионный период. Подтвердите статус справкой СФР.', statusTask.id),
    });
  }

  const taxTask = task('property_tax_benefit');
  if (taxTask && !taxTask.completed && plan.calculation.tax_active) {
    candidates.push({
      taskId: taxTask.id,
      period: yearMonth(plan.calculation.tax_from),
      bucket: 'tax-start',
      view: reminderView('Ориентировочно наступила возрастная граница налоговых льгот. Проверьте сведения в ФНС.', taxTask.id),
    });
  }

  return candidates;
}

export async function runReminderPass({
  storage,
  send,
  clock = () => new Date(),
  timeZone = 'Europe/Moscow',
  fromHour = 9,
  toHour = 20,
  annualDates = ['04-01', '09-01', '11-01'],
  metrics = null,
  logger = console,
  data = loadRulesData(),
} = {}) {
  if (!storage || typeof send !== 'function') throw new TypeError('Нужны хранилище и отправитель');
  const now = zonedParts(clock(), timeZone);
  if (now.hour < fromHour || now.hour >= toHour) return { skipped: 'outside_window', users: 0, sent: 0, failed: 0 };

  const users = storage.listReminderUsers();
  const result = { skipped: null, users: users.length, sent: 0, failed: 0 };
  for (const user of users) {
    let candidates;
    try {
      candidates = collectReminders({
        user,
        taskStates: storage.getTaskStates(user.user_id),
        now,
        annualDates,
        data,
      });
    } catch (error) {
      result.failed += 1;
      metrics?.increment('reminder_errors');
      logger.error(JSON.stringify({ level: 'error', event: 'reminder_plan_failed', ...safeErrorDetails(error) }));
      continue;
    }

    for (const candidate of candidates) {
      const reserved = storage.reserveReminder(user.user_id, candidate.taskId, candidate.period, candidate.bucket);
      if (!reserved) continue;
      try {
        await send(user.user_id, candidate.view);
        storage.recordEvent(user.user_id, 'reminder_sent', {
          task_id: candidate.taskId,
          bucket: candidate.bucket,
        });
        result.sent += 1;
        metrics?.increment('reminders_sent');
      } catch (error) {
        storage.releaseReminder(user.user_id, candidate.taskId, candidate.period, candidate.bucket);
        result.failed += 1;
        metrics?.increment('reminder_errors');
        logger.error(JSON.stringify({ level: 'error', event: 'reminder_send_failed', ...safeErrorDetails(error) }));
      }
    }
  }
  return result;
}

export function startReminderScheduler({ intervalMs = 900_000, run, logger = console } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0 || typeof run !== 'function') {
    throw new TypeError('Нужны положительный intervalMs и функция run');
  }
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await run();
    } catch (error) {
      logger.error(JSON.stringify({ level: 'error', event: 'reminder_pass_failed', ...safeErrorDetails(error) }));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    async waitUntilIdle() {
      while (running) await sleep(1);
    },
  };
}

export { zonedParts };
