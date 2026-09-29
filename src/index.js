import { createPyatiletkaBot, registerBotCommands } from './bot.js';
import { loadConfig } from './config.js';
import { createStorage } from './db.js';

const config = loadConfig();
const storage = createStorage({ path: config.dbPath, eventSalt: config.eventSalt });
const { bot } = createPyatiletkaBot({
  storage,
  config,
  queueOptions: { minIntervalMs: config.queueMinIntervalMs },
});

await registerBotCommands(bot);

const stop = () => {
  bot.stopPolling();
  storage.close();
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

if (config.mode === 'polling') {
  await bot.start({ mode: 'polling' });
} else {
  const domain = new URL(config.publicBaseUrl).host;
  await bot.start({
    mode: 'webhook',
    options: {
      domain,
      port: config.port,
      path: config.webhookPath,
      secret: config.webhookSecret || undefined,
    },
  });
}

