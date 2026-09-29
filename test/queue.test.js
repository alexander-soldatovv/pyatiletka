import test from 'node:test';
import assert from 'node:assert/strict';
import { createDialogQueue } from '../src/queue.js';

test('очередь сохраняет порядок внутри диалога', async () => {
  const seen = [];
  const queue = createDialogQueue({ minIntervalMs: 0 });
  await Promise.all([
    queue.schedule(1, async () => { seen.push(1); }),
    queue.schedule(1, async () => { seen.push(2); }),
    queue.schedule(1, async () => { seen.push(3); }),
  ]);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('429 повторяется с экспоненциальной задержкой', async () => {
  const delays = [];
  let attempts = 0;
  const queue = createDialogQueue({
    minIntervalMs: 0,
    retryBaseMs: 10,
    sleep: async (delay) => { delays.push(delay); },
  });
  const result = await queue.schedule(1, async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('rate limit'), { status: 429 });
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('ошибка 400 не повторяется', async () => {
  let attempts = 0;
  const queue = createDialogQueue({ minIntervalMs: 0 });
  await assert.rejects(queue.schedule(1, async () => {
    attempts += 1;
    throw Object.assign(new Error('bad request'), { status: 400 });
  }));
  assert.equal(attempts, 1);
});

test('503 повторяется ограниченное число раз', async () => {
  let attempts = 0;
  const queue = createDialogQueue({
    minIntervalMs: 0,
    maxAttempts: 3,
    sleep: async () => {},
  });
  await assert.rejects(queue.schedule(1, async () => {
    attempts += 1;
    throw Object.assign(new Error('service unavailable'), { status: 503 });
  }));
  assert.equal(attempts, 3);
});

test('каждая попытка отправки соблюдает интервал диалога', async () => {
  let time = 1000;
  const delays = [];
  let attempts = 0;
  const queue = createDialogQueue({
    minIntervalMs: 500,
    retryBaseMs: 250,
    now: () => time,
    sleep: async (delay) => {
      delays.push(delay);
      time += delay;
    },
  });
  await queue.schedule(1, async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('rate limit'), { status: 429 });
  });
  assert.deepEqual(delays, [250, 250]);
  assert.equal(attempts, 2);
});
