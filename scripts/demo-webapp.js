import { once } from 'node:events';
import { createStorage } from '../src/db.js';
import { createHttpServer } from '../src/server.js';

const port = Number(process.env.PORT || 3000);
const demoUserId = 900000001;
const storage = createStorage({ path: './data/demo.sqlite', eventSalt: 'local-demo-event-salt-only' });

if (!storage.getUser(demoUserId)) {
  storage.saveUser({
    user_id: demoUserId,
    step: 'ready',
    sex: 'm',
    birth_ym: '1963-04',
    region: 'moscow',
    employment: 'employee',
    early: 'no',
  });
}

const server = createHttpServer({
  storage,
  config: {
    botToken: 'local-demo-token-only',
    allowDemoAuth: true,
    demoUserId,
    apiRateLimit: 120,
    reminderTz: 'Europe/Moscow',
  },
});

server.listen(port, '127.0.0.1');
await once(server, 'listening');
console.log(`Демо мини-приложения: http://127.0.0.1:${port}/?demo=1`);

async function stop() {
  if (server.listening) {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  storage.close();
}

process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
