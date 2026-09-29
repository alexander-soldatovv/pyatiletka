import { existsSync } from 'node:fs';

const env = process.env;

function int(name, def) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Переменная ${name} должна быть числом, получено: ${v}`);
  return n;
}

function validMonthDay(value) {
  if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const [month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(2000, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function loadConfig(overrides = {}) {
  const cfg = {
    botToken: env.BOT_TOKEN || '',
    botUsername: env.BOT_USERNAME || '',
    // polling: работает без публичного адреса (удобно для проверки); webhook: для продакшена
    mode: env.BOT_MODE || 'polling',
    port: int('PORT', 3000),
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    webhookPath: env.WEBHOOK_PATH || '/webhook',
    webhookSecret: env.WEBHOOK_SECRET || '',
    dbPath: env.DB_PATH || './data/pyatiletka.sqlite',
    eventSalt: env.EVENT_SALT || '',
    maxApiBase: env.MAX_API_BASE || 'https://platform-api2.max.ru',
    initDataMaxAgeSec: int('INIT_DATA_MAX_AGE_SEC', 3600),
    // Только для локальной отладки мини-приложения в браузере. В продакшене должно быть false.
    allowDemoAuth: env.ALLOW_DEMO_AUTH === 'true',
    reminderTz: env.REMINDER_TZ || 'Europe/Moscow',
    reminderIntervalSec: int('REMINDER_INTERVAL_SEC', 900),
    reminderFromHour: int('REMINDER_FROM_HOUR', 9),
    reminderToHour: int('REMINDER_TO_HOUR', 20),
    annualReminderDates: (env.ANNUAL_REMINDER_DATES || '04-01,09-01,11-01').split(',').map((value) => value.trim()),
    miniappEnabled: env.MINIAPP_ENABLED !== 'false',
    queueMinIntervalMs: int('QUEUE_MIN_INTERVAL_MS', 500),
    maxRequestTimeoutMs: int('MAX_REQUEST_TIMEOUT_MS', 35_000),
    apiRateLimit: int('API_RATE_LIMIT', 60),
    requestBodyLimitBytes: int('REQUEST_BODY_LIMIT_BYTES', 16_384),
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 10_000),
    headersTimeoutMs: int('HEADERS_TIMEOUT_MS', 5_000),
    demoUserId: int('DEMO_USER_ID', 900000001),
    adminToken: env.ADMIN_TOKEN || '',
    caCertPath: env.NODE_EXTRA_CA_CERTS || '',
    ...overrides,
  };
  if (!cfg.botToken) {
    throw new Error('Не задан BOT_TOKEN. Скопируйте .env.example в .env и укажите токен бота.');
  }
  if (!cfg.eventSalt || cfg.eventSalt.length < 16) {
    throw new Error('Не задан EVENT_SALT длиной не менее 16 символов.');
  }
  if (!['polling', 'webhook'].includes(cfg.mode)) {
    throw new Error(`BOT_MODE должен быть polling или webhook, получено: ${cfg.mode}`);
  }
  if (!Number.isInteger(cfg.queueMinIntervalMs) || cfg.queueMinIntervalMs < 0) {
    throw new Error('QUEUE_MIN_INTERVAL_MS должен быть целым неотрицательным числом.');
  }
  if (!Number.isInteger(cfg.maxRequestTimeoutMs) || cfg.maxRequestTimeoutMs <= 0) {
    throw new Error('MAX_REQUEST_TIMEOUT_MS должен быть целым положительным числом.');
  }
  for (const name of ['apiRateLimit', 'requestBodyLimitBytes', 'requestTimeoutMs', 'headersTimeoutMs', 'demoUserId']) {
    if (!Number.isInteger(cfg[name]) || cfg[name] <= 0) {
      throw new Error(`${name} должен быть целым положительным числом.`);
    }
  }
  if (!Number.isInteger(cfg.reminderIntervalSec) || cfg.reminderIntervalSec <= 0) {
    throw new Error('REMINDER_INTERVAL_SEC должен быть целым положительным числом.');
  }
  if (!Number.isInteger(cfg.reminderFromHour) || !Number.isInteger(cfg.reminderToHour)
    || cfg.reminderFromHour < 0 || cfg.reminderToHour > 24 || cfg.reminderFromHour >= cfg.reminderToHour) {
    throw new Error('Окно напоминаний должно задаваться целыми часами от 0 до 24.');
  }
  if (!Array.isArray(cfg.annualReminderDates) || cfg.annualReminderDates.length === 0
    || cfg.annualReminderDates.some((value) => !validMonthDay(value))) {
    throw new Error('ANNUAL_REMINDER_DATES должен содержать даты ММ-ДД через запятую.');
  }
  cfg.annualReminderDates = [...new Set(cfg.annualReminderDates)];
  if (cfg.adminToken && cfg.adminToken.length < 16) {
    throw new Error('ADMIN_TOKEN должен содержать не менее 16 символов.');
  }
  if (cfg.mode === 'webhook' && cfg.publicBaseUrl) {
    let publicUrl;
    try {
      publicUrl = new URL(cfg.publicBaseUrl);
    } catch {
      throw new Error('PUBLIC_BASE_URL должен быть корректным HTTPS URL.');
    }
    if (publicUrl.protocol !== 'https:' || (publicUrl.port && publicUrl.port !== '443')
      || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
      throw new Error('PUBLIC_BASE_URL для webhook должен использовать HTTPS на порту 443 без credentials, query и fragment.');
    }
    if (!/^\/[A-Za-z0-9/_-]*$/u.test(cfg.webhookPath)) {
      throw new Error('WEBHOOK_PATH должен начинаться с / и содержать только безопасные символы пути.');
    }
    if (cfg.webhookSecret.length < 16 || cfg.webhookSecret.length > 256
      || !/^[A-Za-z0-9_-]+$/u.test(cfg.webhookSecret)) {
      throw new Error('WEBHOOK_SECRET должен содержать 16-256 символов A-Z, a-z, 0-9, _ или -.');
    }
  }
  if (cfg.caCertPath && !existsSync(cfg.caCertPath)) {
    throw new Error(`Не найден сертификат Минцифры: ${cfg.caCertPath}. См. certs/README.md.`);
  }
  return cfg;
}

export function resolveBotMode(config) {
  return config.mode === 'webhook' && !config.publicBaseUrl ? 'polling' : config.mode;
}
