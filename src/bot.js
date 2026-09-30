import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { parseBirthYm } from './dates.js';
import { safeErrorDetails } from './metrics.js';
import { createDialogQueue } from './queue.js';
import { buildPlan } from './rules.js';
import {
  birthMonthView,
  birthYearView,
  customBirthView,
  datesView,
  earlyView,
  employmentView,
  fallbackView,
  helpView,
  noProfileView,
  nowView,
  planView,
  regionView,
  resetView,
  sexView,
  sourcesView,
  staleView,
  taskView,
  welcomeView,
} from './texts.js';

const COMMANDS = [
  { name: 'start', description: 'Начать или открыть меню' },
  { name: 'plan', description: 'Открыть весь план' },
  { name: 'now', description: 'Что сделать сейчас' },
  { name: 'dates', description: 'Показать ориентировочные даты' },
  { name: 'sources', description: 'Показать источники' },
  { name: 'reset', description: 'Удалить мои данные' },
  { name: 'help', description: 'Помощь' },
  { name: 'id', description: 'Диагностический ID' },
];

function currentMonth(clock, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(clock());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month) };
}

function getUserId(ctx) {
  const value = ctx.user?.user_id;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('В обновлении нет корректного user_id');
  return value;
}

function patchUser(storage, userId, patch) {
  const existing = storage.getUser(userId) ?? {
    user_id: String(userId),
    step: 'idle',
  };
  return storage.saveUser({ ...existing, ...patch, user_id: String(userId) });
}

function profileFromUser(user) {
  if (!user || user.step !== 'ready' || !/^\d{4}-\d{2}$/.test(user.birth_ym ?? '')) return null;
  const [birthYear, birthMonth] = user.birth_ym.split('-').map(Number);
  return {
    sex: user.sex,
    birthYear,
    birthMonth,
    region: user.region,
    employment: user.employment,
    early: user.early,
  };
}

function bodyFromView(view) {
  const body = { text: view.text.slice(0, 4000) };
  if (view.buttons?.length) body.attachments = [Keyboard.inlineKeyboard(view.buttons)];
  return body;
}

function replaceOpenAppWithLink(view, botUsername) {
  const deepLink = `https://max.ru/${encodeURIComponent(botUsername)}?startapp=plan`;
  return {
    ...view,
    hasOpenApp: false,
    buttons: view.buttons.map((row) => row.map((button) => (
      button.type === 'open_app'
        ? Keyboard.button.link('Открыть мою карту', deepLink)
        : button
    ))),
  };
}

function birthYmAllowed(birthYm, now) {
  const [year, month] = birthYm.split('-').map(Number);
  const ageMonths = now.year * 12 + now.month - (year * 12 + month);
  return ageMonths >= 40 * 12 && ageMonths <= 100 * 12;
}

function fetchWithTimeout(timeoutMs, fetchImpl = globalThis.fetch) {
  return (url, options = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    return fetchImpl(url, { ...options, signal });
  };
}

export function createPyatiletkaBot({
  storage,
  config,
  clock = () => new Date(),
  logger = console,
  queueOptions = {},
  metrics = null,
} = {}) {
  if (!storage) throw new TypeError('Нужно хранилище');
  if (!config?.botToken) throw new TypeError('Нужен BOT_TOKEN');

  const bot = new Bot(config.botToken, {
    clientOptions: {
      baseUrl: config.maxApiBase,
      fetch: fetchWithTimeout(config.maxRequestTimeoutMs ?? 35_000),
    },
  });
  const queue = createDialogQueue({ minIntervalMs: 500, ...queueOptions });
  const now = () => currentMonth(clock, config.reminderTz ?? 'Europe/Moscow');

  bot.use(async (_ctx, next) => {
    metrics?.increment('updates_processed');
    return next();
  });

  function planFor(userId) {
    const user = storage.getUser(userId);
    const profile = profileFromUser(user);
    if (!profile) return null;
    return buildPlan({
      profile,
      now: now(),
      taskStates: storage.getTaskStates(userId),
    });
  }

  async function sendNew(ctx, view) {
    const userId = getUserId(ctx);
    const dialogId = ctx.chatId ?? userId;
    const send = (body) => (ctx.chatId
      ? bot.api.sendMessageToChat(ctx.chatId, body.text, { attachments: body.attachments })
      : bot.api.sendMessageToUser(userId, body.text, { attachments: body.attachments }));
    try {
      const result = await queue.schedule(dialogId, () => send(bodyFromView(view)));
      metrics?.increment('messages_sent');
      return result;
    } catch (error) {
      if (view.hasOpenApp && config.botUsername) {
        const result = await queue.schedule(dialogId, () => send(bodyFromView(replaceOpenAppWithLink(view, config.botUsername))));
        metrics?.increment('messages_sent');
        return result;
      }
      throw error;
    }
  }

  async function sendToUser(userId, view) {
    const result = await queue.schedule(userId, () => {
      const body = bodyFromView(view);
      return bot.api.sendMessageToUser(userId, body.text, { attachments: body.attachments });
    });
    metrics?.increment('messages_sent');
    return result;
  }

  async function respond(ctx, view) {
    if (ctx.updateType !== 'message_callback') return sendNew(ctx, view);
    const dialogId = ctx.chatId ?? getUserId(ctx);
    try {
      await queue.schedule(dialogId, () => ctx.answerOnCallback({ message: bodyFromView(view) }));
      metrics?.increment('messages_sent');
    } catch {
      await sendNew(ctx, view);
    }
  }

  async function requirePlan(ctx, renderer) {
    const plan = planFor(getUserId(ctx));
    return respond(ctx, plan ? renderer(plan) : noProfileView());
  }

  async function showWelcome(ctx) {
    const userId = getUserId(ctx);
    const existing = storage.getUser(userId);
    storage.saveUser({
      ...(existing ?? { user_id: userId, step: 'idle' }),
      user_id: userId,
      bot_active: true,
      cohort: ctx.startPayload || existing?.cohort || '',
    });
    storage.recordEvent(userId, 'setup_started');
    await respond(ctx, welcomeView());
  }

  bot.on(['bot_stopped', 'dialog_removed'], async (ctx) => {
    storage.setBotActive(getUserId(ctx), false);
  });

  // В MAX у сообщения с вложением body.text равен null. Обрабатываем его до
  // command(), потому что версия 0.3.1 считает поле null текстовым сообщением.
  bot.on(
    (update) => update.update_type === 'message_created' && typeof update.message?.body?.text !== 'string',
    async (ctx) => {
      const user = storage.getUser(getUserId(ctx));
      return respond(ctx, user?.step === 'birth_custom' ? customBirthView('format') : fallbackView());
    },
  );

  bot.on('bot_started', showWelcome);
  bot.command('start', showWelcome);
  bot.command('plan', (ctx) => requirePlan(ctx, (plan) => planView(plan, config)));
  bot.command('now', (ctx) => requirePlan(ctx, nowView));
  bot.command('dates', (ctx) => requirePlan(ctx, datesView));
  bot.command('sources', (ctx) => requirePlan(ctx, sourcesView));
  bot.command('help', (ctx) => respond(ctx, helpView()));
  bot.command('reset', (ctx) => respond(ctx, resetView()));
  bot.command('id', (ctx) => respond(ctx, { text: `Ваш диагностический ID: ${getUserId(ctx)}`, buttons: [] }));

  bot.on('message_callback', async (ctx) => {
    const payload = ctx.callback?.payload ?? '';
    const userId = getUserId(ctx);
    const user = storage.getUser(userId);

    if (payload === 'setup:start') {
      patchUser(storage, userId, { step: 'sex', sex: null, birth_ym: null, region: null, employment: null, early: null });
      return respond(ctx, sexView());
    }
    if (payload === 'nav:help') return respond(ctx, helpView());
    if (payload === 'reset:yes') {
      storage.deleteUser(userId);
      return respond(ctx, welcomeView());
    }
    if (!user) return respond(ctx, staleView());

    const sex = payload.match(/^setup:sex:(m|f)$/);
    if (sex) {
      if (user.step !== 'sex') return respond(ctx, staleView());
      patchUser(storage, userId, { step: 'birth_year', sex: sex[1] });
      return respond(ctx, birthYearView());
    }

    const birthYear = payload.match(/^setup:by:(\d{4})$/);
    if (birthYear) {
      if (user.step !== 'birth_year') return respond(ctx, staleView());
      const selectedYear = Number(birthYear[1]);
      if (selectedYear < 1959 || selectedYear > 1975) return respond(ctx, staleView());
      patchUser(storage, userId, { step: `birth_month:${birthYear[1]}` });
      return respond(ctx, birthMonthView());
    }
    if (payload === 'setup:birth:custom') {
      if (user.step !== 'birth_year') return respond(ctx, staleView());
      patchUser(storage, userId, { step: 'birth_custom' });
      return respond(ctx, customBirthView());
    }

    const birthMonth = payload.match(/^setup:bm:(\d{1,2})$/);
    if (birthMonth) {
      const year = user.step.match(/^birth_month:(\d{4})$/)?.[1];
      const month = Number(birthMonth[1]);
      if (!year || month < 1 || month > 12) return respond(ctx, staleView());
      patchUser(storage, userId, { step: 'region', birth_ym: `${year}-${String(month).padStart(2, '0')}` });
      return respond(ctx, regionView());
    }

    const region = payload.match(/^setup:region:(moscow|other)$/);
    if (region) {
      if (user.step !== 'region') return respond(ctx, staleView());
      patchUser(storage, userId, { step: 'employment', region: region[1] });
      return respond(ctx, employmentView());
    }

    const employment = payload.match(/^setup:emp:(employee|other)$/);
    if (employment) {
      if (user.step !== 'employment') return respond(ctx, staleView());
      patchUser(storage, userId, { step: 'early', employment: employment[1] });
      return respond(ctx, earlyView());
    }

    const early = payload.match(/^setup:early:(no|yes|unsure)$/);
    if (early) {
      if (user.step !== 'early') return respond(ctx, staleView());
      patchUser(storage, userId, { step: 'ready', early: early[1] });
      storage.recordEvent(userId, 'setup_completed');
      return respond(ctx, planView(planFor(userId), config));
    }

    if (payload === 'nav:plan') return requirePlan(ctx, (plan) => planView(plan, config));
    if (payload === 'nav:now') return requirePlan(ctx, nowView);
    if (payload === 'nav:dates') return requirePlan(ctx, datesView);
    if (payload === 'nav:sources') return requirePlan(ctx, sourcesView);

    const reminderNavigation = payload.match(/^reminder:open:([a-z0-9_]+)$/);
    if (reminderNavigation) {
      const plan = planFor(userId);
      const task = plan?.tasks.find((item) => item.id === reminderNavigation[1]);
      if (!task) return respond(ctx, noProfileView());
      storage.recordEvent(userId, 'reminder_opened', { task_id: task.id });
      return respond(ctx, taskView(task));
    }

    const taskNavigation = payload.match(/^nav:task:([a-z0-9_]+)$/);
    if (taskNavigation) {
      const plan = planFor(userId);
      const task = plan?.tasks.find((item) => item.id === taskNavigation[1]);
      return respond(ctx, task ? taskView(task) : noProfileView());
    }

    const taskStatus = payload.match(/^task:(done|undo):([a-z0-9_]+)$/);
    if (taskStatus) {
      const plan = planFor(userId);
      const task = plan?.tasks.find((item) => item.id === taskStatus[2]);
      if (!task) return respond(ctx, noProfileView());
      const status = taskStatus[1] === 'done' ? 'done' : 'todo';
      storage.setTaskStatus(userId, task.id, status, task.period);
      storage.recordEvent(userId, status === 'done' ? 'task_done' : 'task_undone', { task_id: task.id });
      const updated = planFor(userId).tasks.find((item) => item.id === task.id);
      return respond(ctx, taskView(updated));
    }

    return respond(ctx, staleView());
  });

  bot.on('message_created', async (ctx) => {
    const userId = getUserId(ctx);
    const user = storage.getUser(userId);
    const text = ctx.message?.body?.text;
    if (user?.step === 'birth_custom') {
      if (typeof text !== 'string' || text.length > 32) return respond(ctx, customBirthView('format'));
      const birthYm = parseBirthYm(text);
      if (!birthYm) return respond(ctx, customBirthView('format'));
      if (!birthYmAllowed(birthYm, now())) return respond(ctx, customBirthView('range'));
      patchUser(storage, userId, { step: 'region', birth_ym: birthYm });
      return respond(ctx, regionView());
    }
    return respond(ctx, fallbackView());
  });

  bot.catch(async (error) => {
    metrics?.increment('update_errors');
    logger.error(JSON.stringify({
      level: 'error',
      event: 'bot_update_failed',
      ...safeErrorDetails(error),
    }));
  });

  return { bot, planFor, sendToUser };
}

export async function registerBotCommands(bot, logger = console) {
  try {
    await bot.api.setMyCommands(COMMANDS);
    return true;
  } catch (error) {
    logger.warn(JSON.stringify({
      level: 'warn',
      event: 'commands_registration_failed',
      ...safeErrorDetails(error),
    }));
    return false;
  }
}

export { COMMANDS, fetchWithTimeout, profileFromUser };
