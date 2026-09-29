const env = process.env;

function int(name, def) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Переменная ${name} должна быть числом, получено: ${v}`);
  return n;
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
    miniappEnabled: env.MINIAPP_ENABLED !== 'false',
    queueMinIntervalMs: int('QUEUE_MIN_INTERVAL_MS', 500),
    maxRequestTimeoutMs: int('MAX_REQUEST_TIMEOUT_MS', 35_000),
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
  if (cfg.mode === 'webhook' && !cfg.publicBaseUrl) {
    throw new Error('Для BOT_MODE=webhook нужен PUBLIC_BASE_URL (публичный https-адрес сервиса).');
  }
  return cfg;
}
