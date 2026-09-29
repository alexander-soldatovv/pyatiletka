import test from 'node:test';
import assert from 'node:assert/strict';
import { configureWebhook, runPollingLoop } from '../src/runtime.js';

test('polling повторно подключается после ошибки запуска', async () => {
  let stopping = false;
  let starts = 0;
  const delays = [];
  const bot = {
    async start() {
      starts += 1;
      if (starts === 1) throw Object.assign(new Error('network and private data'), { code: 'network' });
      stopping = true;
    },
  };
  const logs = [];
  await runPollingLoop({
    bot,
    isStopping: () => stopping,
    retryMs: 5000,
    sleep: async (delay) => { delays.push(delay); },
    logger: { error(value) { logs.push(value); } },
  });
  assert.equal(starts, 2);
  assert.deepEqual(delays, [5000]);
  assert.doesNotMatch(logs[0], /private data/);
  assert.match(logs[0], /network/);
});

test('webhook заменяет подписки одной актуальной с текущим секретом', async () => {
  const removed = [];
  const added = [];
  const bot = {
    api: {
      async getSubscriptions() {
        return [{ url: 'https://old.test/webhook' }, { url: 'https://new.test/webhook' }];
      },
      async unsubscribe(url) { removed.push(url); },
      async subscribe(url, secret) { added.push([url, secret]); },
    },
  };
  await configureWebhook({ bot, url: 'https://new.test/webhook', secret: 'secret' });
  assert.deepEqual(removed, ['https://old.test/webhook', 'https://new.test/webhook']);
  assert.deepEqual(added, [['https://new.test/webhook', 'secret']]);
});
