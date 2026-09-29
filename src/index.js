import { once } from 'node:events';
import { createPyatiletkaBot, registerBotCommands } from './bot.js';
import { loadConfig } from './config.js';
import { createStorage } from './db.js';
import { createHttpServer } from './server.js';

const config = loadConfig();
const storage = createStorage({ path: config.dbPath, eventSalt: config.eventSalt });
const { bot } = createPyatiletkaBot({
  storage,
  config,
  queueOptions: { minIntervalMs: config.queueMinIntervalMs },
});

await registerBotCommands(bot);

let webhookHandler = null;
let webhookUrl = null;
if (config.mode === 'webhook') {
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

const server = createHttpServer({ storage, config, webhookHandler });
server.listen(config.port, '0.0.0.0');
await once(server, 'listening');
console.log(JSON.stringify({ level: 'info', event: 'http_started', port: config.port }));

if (webhookUrl) {
  await bot.api.subscribe(webhookUrl, config.webhookSecret || undefined);
  console.log(JSON.stringify({ level: 'info', event: 'webhook_started', path: config.webhookPath }));
}

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
  bot.stopPolling();
  if (webhookUrl) {
    try {
      await bot.api.unsubscribe(webhookUrl);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'webhook_unsubscribe_failed',
        error: error instanceof Error ? error.message : 'unknown',
      }));
    }
  }
  if (server.listening) {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  storage.close();
}

process.once('SIGINT', () => { void stop('SIGINT'); });
process.once('SIGTERM', () => { void stop('SIGTERM'); });

if (config.mode === 'polling') {
  await bot.start({ mode: 'polling' });
}
