import { setTimeout as sleepDefault } from 'node:timers/promises';
import { safeErrorDetails } from './metrics.js';

export async function runPollingLoop({
  bot,
  isStopping,
  signal,
  retryMs = 5_000,
  sleep = sleepDefault,
  logger = console,
  metrics = null,
} = {}) {
  if (!bot || typeof isStopping !== 'function') throw new TypeError('Нужны bot и isStopping');
  while (!isStopping()) {
    try {
      // Повтор контролируется этим циклом, чтобы не запускать второй retry библиотеки параллельно.
      await bot.start({ mode: 'polling', options: { retry: false } });
      if (!isStopping()) throw Object.assign(new Error('Polling остановился'), { code: 'polling_stopped' });
    } catch (error) {
      if (isStopping()) break;
      metrics?.increment('update_errors');
      logger.error(JSON.stringify({ level: 'error', event: 'polling_connection_failed', ...safeErrorDetails(error) }));
    }
    if (isStopping()) break;
    try {
      await sleep(retryMs, undefined, { signal });
    } catch (error) {
      if (error?.name !== 'AbortError') throw error;
    }
  }
}

export async function configureWebhook({ bot, url, secret }) {
  const subscriptions = await bot.api.getSubscriptions();
  await Promise.all(subscriptions.map((subscription) => bot.api.unsubscribe(subscription.url)));
  await bot.api.subscribe(url, secret);
}
