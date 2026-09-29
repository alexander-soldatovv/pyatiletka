import { once } from 'node:events';
import { createPyatiletkaBot, registerBotCommands } from './bot.js';
import { loadConfig, resolveBotMode } from './config.js';
import { createStorage } from './db.js';
import { createMetrics, safeErrorDetails } from './metrics.js';
import { runReminderPass, startReminderScheduler } from './reminders.js';
import { configureWebhook, runPollingLoop } from './runtime.js';
import { createHttpServer } from './server.js';

const config = loadConfig();
const mode = resolveBotMode(config);
const metrics = createMetrics();
const storage = createStorage({ path: config.dbPath, eventSalt: config.eventSalt });
const { bot, sendToUser } = createPyatiletkaBot({
  storage,
  config,
  metrics,
  queueOptions: { minIntervalMs: config.queueMinIntervalMs },
});

if (mode !== config.mode) {
  console.warn(JSON.stringify({
    level: 'warn', event: 'webhook_fallback_to_polling', reason: 'public_base_url_missing',
  }));
}

await registerBotCommands(bot);

let webhookHandler = null;
let webhookUrl = null;
let webhookReady = false;
if (mode === 'webhook') {
  bot.botInfo = await bot.api.getMyInfo();
  const domain = new URL(config.publicBaseUrl).host;
  webhookHandler = bot.webhookCallback({
    domain,
    port: config.port,
    path: config.webhookPath,
    secret: config.webhookSecret || undefined,
  });
  webhookUrl = `${config.publicBaseUrl}${config.webhookPath}`;
}

const healthProvider = () => ({
  database: storage.healthCheck(),
  bot: mode === 'webhook' ? webhookReady : bot.pollingIsStarted,
});
const server = createHttpServer({ storage, config, webhookHandler, metrics, healthProvider });
server.listen(config.port, '0.0.0.0');
await once(server, 'listening');
console.log(JSON.stringify({ level: 'info', event: 'http_started', port: config.port }));

if (webhookUrl) {
  await configureWebhook({ bot, url: webhookUrl, secret: config.webhookSecret });
  webhookReady = true;
  console.log(JSON.stringify({ level: 'info', event: 'webhook_started', path: config.webhookPath }));
}

let stopping = false;
const pollingAbort = new AbortController();
const pollingRun = mode === 'polling'
  ? runPollingLoop({ bot, isStopping: () => stopping, signal: pollingAbort.signal, metrics })
  : Promise.resolve();
const reminders = startReminderScheduler({
  intervalMs: config.reminderIntervalSec * 1000,
  run: () => runReminderPass({
    storage,
    send: sendToUser,
    timeZone: config.reminderTz,
    fromHour: config.reminderFromHour,
    toHour: config.reminderToHour,
    annualDates: config.annualReminderDates,
    metrics,
  }),
});

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
  reminders.stop();
  await reminders.waitUntilIdle();
  pollingAbort.abort();
  bot.stopPolling();
  if (webhookUrl) {
    try {
      await bot.api.unsubscribe(webhookUrl);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'webhook_unsubscribe_failed',
        ...safeErrorDetails(error),
      }));
    }
  }
  if (server.listening) {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  await pollingRun;
  storage.close();
}

process.once('SIGINT', () => { void stop('SIGINT'); });
process.once('SIGTERM', () => { void stop('SIGTERM'); });

process.on('unhandledRejection', (error) => {
  metrics.increment('update_errors');
  console.error(JSON.stringify({ level: 'error', event: 'unhandled_rejection', ...safeErrorDetails(error) }));
});
