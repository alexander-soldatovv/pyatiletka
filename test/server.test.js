import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPyatiletkaBot } from '../src/bot.js';
import { createStorage } from '../src/db.js';
import { createMetrics } from '../src/metrics.js';
import { createHttpServer } from '../src/server.js';
import { signInitData } from '../src/webapp-auth.js';

const token = 'server-test-token-not-real';
const eventSalt = 'server-test-event-salt-123456';
const instant = new Date('2026-09-29T12:00:00Z');

async function fixture(overrides = {}, serverOverrides = {}) {
  const storage = createStorage({ eventSalt, now: () => instant });
  const config = {
    botToken: token,
    initDataMaxAgeSec: 3600,
    reminderTz: 'UTC',
    allowDemoAuth: false,
    demoUserId: 99,
    apiRateLimit: 60,
    requestBodyLimitBytes: 16_384,
    adminToken: 'server-test-admin-token',
    ...overrides,
  };
  const metrics = createMetrics({ clock: () => instant });
  const server = createHttpServer({
    storage,
    config,
    clock: () => instant,
    metrics,
    logger: { error() {} },
    ...serverOverrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const initData = signInitData({
    auth_date: Math.floor(instant.getTime() / 1000) - 5,
    query_id: 'server-test',
    user: { id: 42, first_name: 'Тест' },
  }, token);
  return {
    storage,
    server,
    baseUrl,
    initData,
    metrics,
    async close() {
      server.close();
      await once(server, 'close');
      storage.close();
    },
  };
}

function auth(value) {
  return { 'X-Max-Init-Data': value };
}

test('сервер отдаёт healthz, статику и заголовки безопасности', async () => {
  const f = await fixture();
  try {
    const health = await fetch(`${f.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: 'ok',
      checks: { database: true, bot: true },
      runtime: {
        uptime_seconds: 0,
        counters: {
          api_requests: 0,
          http_errors: 0,
          updates_processed: 0,
          update_errors: 0,
          messages_sent: 0,
          reminders_sent: 0,
          reminder_errors: 0,
        },
      },
    });
    const page = await fetch(`${f.baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /https:\/\/st\.max\.ru/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /Пятилетка/);
  } finally {
    await f.close();
  }
});

test('API принимает только свежую подпись MAX', async () => {
  const f = await fixture();
  try {
    const valid = await fetch(`${f.baseUrl}/api/state`, { headers: auth(f.initData) });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).profile, null);

    const missing = await fetch(`${f.baseUrl}/api/state`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, 'auth_invalid');

    const foreign = signInitData({
      auth_date: Math.floor(instant.getTime() / 1000),
      user: { id: 42 },
    }, 'foreign-token');
    assert.equal((await fetch(`${f.baseUrl}/api/state`, { headers: auth(foreign) })).status, 401);

    const stale = signInitData({
      auth_date: Math.floor(instant.getTime() / 1000) - 3601,
      user: { id: 42 },
    }, token);
    const staleResponse = await fetch(`${f.baseUrl}/api/state`, { headers: auth(stale) });
    assert.equal(staleResponse.status, 401);
    assert.equal((await staleResponse.json()).error.code, 'auth_stale');
  } finally {
    await f.close();
  }
});

test('профиль и отметки общие для API и хранилища бота', async () => {
  const f = await fixture();
  try {
    const profile = {
      sex: 'm',
      birth_ym: '1963-04',
      region: 'moscow',
      employment: 'employee',
      early: 'no',
    };
    const saved = await fetch(`${f.baseUrl}/api/profile`, {
      method: 'POST', headers: { ...auth(f.initData), 'Content-Type': 'application/json' }, body: JSON.stringify(profile),
    });
    assert.equal(saved.status, 200);
    const initialState = await saved.json();
    assert.equal(initialState.profile.birth_ym, '1963-04');
    assert.equal(f.storage.getUser(42).step, 'ready');

    const task = initialState.tasks.find((item) => item.id === 'dispensary_and_days');
    const mark = () => fetch(`${f.baseUrl}/api/tasks/${task.id}/status`, {
      method: 'POST',
      headers: { ...auth(f.initData), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done', period: task.period }),
    });
    assert.equal((await mark()).status, 200);
    assert.equal((await mark()).status, 200);
    assert.equal(f.storage.getTaskStates(42).length, 1);
    assert.equal(f.storage.getTaskStates(42)[0].status, 'done');
    const { planFor } = createPyatiletkaBot({
      storage: f.storage,
      config: { botToken: token, maxApiBase: f.baseUrl, reminderTz: 'UTC' },
      clock: () => instant,
      queueOptions: { minIntervalMs: 0 },
    });
    assert.equal(planFor(42).tasks.find((item) => item.id === task.id).completed, true);

    f.storage.setTaskStatus(42, task.id, 'todo', task.period);
    const stateAfterBotChange = await fetch(`${f.baseUrl}/api/state`, { headers: auth(f.initData) });
    assert.equal((await stateAfterBotChange.json()).tasks.find((item) => item.id === task.id).completed, false);

    const mismatch = await fetch(`${f.baseUrl}/api/tasks/${task.id}/status`, {
      method: 'POST',
      headers: { ...auth(f.initData), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'todo', period: '1900' }),
    });
    assert.equal(mismatch.status, 409);

    const removed = await fetch(`${f.baseUrl}/api/me`, { method: 'DELETE', headers: auth(f.initData) });
    assert.equal(removed.status, 200);
    assert.equal(f.storage.getUser(42), null);
    assert.deepEqual(f.storage.getTaskStates(42), []);
    assert.deepEqual(f.storage.getEventsForTest(42).map((event) => event.type), ['reset']);
  } finally {
    await f.close();
  }
});

test('статистика защищена ADMIN_TOKEN и фильтруется по когорте', async () => {
  const f = await fixture();
  try {
    const cohortInitData = signInitData({
      auth_date: Math.floor(instant.getTime() / 1000),
      start_param: 'pilot_hr',
      user: { id: 42 },
    }, token);
    f.storage.saveUser({ user_id: 42, step: 'idle' });
    await fetch(`${f.baseUrl}/api/state`, { headers: auth(cohortInitData) });
    await fetch(`${f.baseUrl}/api/events/share`, {
      method: 'POST',
      headers: { ...auth(cohortInitData), 'Content-Type': 'application/json' },
      body: '{}',
    });

    assert.equal((await fetch(`${f.baseUrl}/api/stats`)).status, 401);
    const statsResponse = await fetch(`${f.baseUrl}/api/stats?start=pilot_hr`, {
      headers: { Authorization: 'Bearer server-test-admin-token' },
    });
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json();
    assert.equal(stats.cohort, 'pilot_hr');
    assert.equal(stats.users.total, 1);
    assert.equal(stats.events.miniapp_opened, 1);
    assert.equal(stats.events.share_used, 1);
    assert.ok(stats.runtime.counters.api_requests >= 3);
  } finally {
    await f.close();
  }
});

test('API валидирует профиль, JSON и размер тела', async () => {
  const f = await fixture({ requestBodyLimitBytes: 180 });
  try {
    const invalidProfile = await fetch(`${f.baseUrl}/api/profile`, {
      method: 'POST', headers: { ...auth(f.initData), 'Content-Type': 'application/json' }, body: JSON.stringify({ sex: 'x' }),
    });
    assert.equal(invalidProfile.status, 400);

    const invalidJson = await fetch(`${f.baseUrl}/api/profile`, {
      method: 'POST', headers: { ...auth(f.initData), 'Content-Type': 'application/json' }, body: '{broken',
    });
    assert.equal(invalidJson.status, 400);

    const tooLarge = await fetch(`${f.baseUrl}/api/profile`, {
      method: 'POST', headers: { ...auth(f.initData), 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(300) }),
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await f.close();
  }
});

test('демо-авторизация требует явного режима и лимитирует запросы', async () => {
  const f = await fixture({ allowDemoAuth: true, apiRateLimit: 1 });
  try {
    const demo = await fetch(`${f.baseUrl}/api/state`, { headers: auth('demo') });
    assert.equal(demo.status, 200);
    assert.equal((await demo.json()).profile, null);
    const limited = await fetch(`${f.baseUrl}/api/state`, { headers: auth('demo') });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await fetch(`${f.baseUrl}/api/state`)).status, 401);
  } finally {
    await f.close();
  }
});

test('healthz возвращает 503, если бот не готов', async () => {
  const f = await fixture({}, { healthProvider: () => ({ database: true, bot: false }) });
  try {
    const response = await fetch(`${f.baseUrl}/healthz`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'degraded');
  } finally {
    await f.close();
  }
});

test('webhook принимает только точный x-max-bot-api-secret', async () => {
  const storage = createStorage({ eventSalt, now: () => instant });
  storage.saveUser({ user_id: 42, step: 'ready' });
  const { bot } = createPyatiletkaBot({
    storage,
    config: { botToken: token, maxApiBase: 'http://127.0.0.1:1', reminderTz: 'UTC' },
    clock: () => instant,
  });
  bot.botInfo = { user_id: 999, username: 'test_bot', is_bot: true };
  const webhookHandler = bot.webhookCallback({
    domain: 'example.test',
    port: 3000,
    path: '/webhook',
    secret: 'webhook-secret-12345',
  });
  const server = createHttpServer({
    storage,
    config: { botToken: token, webhookPath: '/webhook' },
    webhookHandler,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({
    update_type: 'bot_stopped',
    timestamp: instant.getTime(),
    chat_id: 42,
    user: { user_id: 42, first_name: 'Тест', is_bot: false },
  });
  try {
    assert.equal((await fetch(`${baseUrl}/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })).status, 404);
    assert.equal((await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-max-bot-api-secret': 'webhook-secret-12345' },
      body,
    })).status, 200);
    const deadline = Date.now() + 500;
    while (storage.getUser(42).bot_active !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(storage.getUser(42).bot_active, 0);
  } finally {
    server.close();
    await once(server, 'close');
    storage.close();
  }
});
