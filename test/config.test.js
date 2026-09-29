import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout } from '../src/bot.js';
import { loadConfig, resolveBotMode } from '../src/config.js';

const eventSalt = 'test-event-salt-123456789';

test('MAX_API_BASE по умолчанию указывает на API v2', () => {
  const previous = process.env.MAX_API_BASE;
  delete process.env.MAX_API_BASE;
  try {
    const config = loadConfig({ botToken: 'test', eventSalt });
    assert.equal(config.maxApiBase, 'https://platform-api2.max.ru');
  } finally {
    if (previous === undefined) delete process.env.MAX_API_BASE;
    else process.env.MAX_API_BASE = previous;
  }
});

test('без BOT_TOKEN запуск отклоняется без значения секрета в ошибке', () => {
  assert.throws(
    () => loadConfig({ botToken: '', eventSalt }),
    (error) => error.message === 'Не задан BOT_TOKEN. Скопируйте .env.example в .env и укажите токен бота.',
  );
});

test('сетевой клиент прерывает зависший запрос по таймауту', async () => {
  const hangingFetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  const timedFetch = fetchWithTimeout(5, hangingFetch);
  await assert.rejects(timedFetch('https://example.test'), (error) => error.name === 'TimeoutError');
});

test('webhook без публичного URL безопасно переходит на polling', () => {
  const config = loadConfig({ botToken: 'test', eventSalt, mode: 'webhook', publicBaseUrl: '' });
  assert.equal(resolveBotMode(config), 'polling');
});

test('публичный webhook требует секрет', () => {
  assert.throws(
    () => loadConfig({
      botToken: 'test', eventSalt, mode: 'webhook', publicBaseUrl: 'https://example.test', webhookSecret: '',
    }),
    /WEBHOOK_SECRET/,
  );
});

test('календарь напоминаний отклоняет невозможную дату', () => {
  assert.throws(
    () => loadConfig({ botToken: 'test', eventSalt, annualReminderDates: ['02-31'] }),
    /ANNUAL_REMINDER_DATES/,
  );
});
