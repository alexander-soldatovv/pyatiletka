import test from 'node:test';
import assert from 'node:assert/strict';
import { createPyatiletkaBot, registerBotCommands } from '../src/bot.js';
import { createStorage } from '../src/db.js';
import { createMockMaxServer } from './mock-max/server.js';

const eventSalt = 'test-event-salt-123456789';

async function fixture(options = {}) {
  const max = await createMockMaxServer();
  const storage = createStorage({ eventSalt });
  const config = {
    botToken: 'mock-token',
    botUsername: 'pyatiletka_test_bot',
    maxApiBase: max.baseUrl,
    reminderTz: 'UTC',
    miniappEnabled: options.miniappEnabled ?? false,
  };
  const makeBot = () => createPyatiletkaBot({
    storage,
    config,
    clock: () => new Date('2026-09-29T12:00:00Z'),
    queueOptions: { minIntervalMs: 0, retryBaseMs: 1 },
    logger: options.logger ?? { error() {}, warn() {} },
  });
  const app = makeBot();
  return { max, storage, config, makeBot, ...app };
}

async function stopFixture({ max, storage, bot }, run) {
  bot.stopPolling();
  await run;
  storage.close();
  await max.close();
}

test('полный сценарий проходит через реальный клиент библиотеки и mock MAX', async () => {
  const f = await fixture();
  const run = f.bot.start({ mode: 'polling', options: { retry: false } });
  try {
    f.max.botStarted(1);
    await f.max.waitFor((state) => state.messages.length === 1);
    assert.match(f.max.state.messages[0].body.text, /Пятилетка/);

    const steps = [
      'setup:start',
      'setup:sex:m',
      'setup:by:1963',
      'setup:bm:4',
      'setup:region:moscow',
      'setup:emp:employee',
      'setup:early:no',
    ];
    for (const [index, payload] of steps.entries()) {
      f.max.press(1, payload);
      await f.max.waitFor((state) => state.answers.length === index + 1);
    }

    assert.equal(f.storage.getUser(1).step, 'ready');
    assert.match(f.max.state.answers.at(-1).body.message.text, /Личная карта/);

    f.max.press(1, 'nav:task:dispensary_and_days');
    await f.max.waitFor((state) => state.answers.length === 8);
    f.max.press(1, 'task:done:dispensary_and_days');
    await f.max.waitFor((state) => state.answers.length === 9);
    assert.equal(f.storage.getTaskStates(1)[0].status, 'done');

    f.max.callback(1, 'task:done:dispensary_and_days');
    await f.max.waitFor((state) => state.answers.length === 10);
    assert.equal(f.storage.getTaskStates(1).length, 1);
    f.max.press(1, 'task:undo:dispensary_and_days');
    await f.max.waitFor((state) => state.answers.length === 11);
    assert.equal(f.storage.getTaskStates(1)[0].status, 'todo');

    f.max.write(1, '/reset');
    await f.max.waitFor((state) => state.messages.length === 2);
    f.max.press(1, 'reset:yes');
    await f.max.waitFor((state) => state.answers.length === 12);
    assert.equal(f.storage.getUser(1).step, 'idle');
    assert.deepEqual(f.storage.getTaskStates(1), []);

    f.max.callback(1, 'task:done:dispensary_and_days');
    await f.max.waitFor((state) => state.answers.length === 13);
    assert.match(f.max.state.answers.at(-1).body.message.text, /Сначала ответьте/);
    f.max.callback(1, 'unknown:payload');
    await f.max.waitFor((state) => state.answers.length === 14);
    assert.match(f.max.state.answers.at(-1).body.message.text, /устарела/);
  } finally {
    await stopFixture(f, run);
  }
});

test('ошибки даты, вложение и ветки другое и досрочная обрабатываются без падения', async () => {
  const f = await fixture();
  const run = f.bot.start({ mode: 'polling', options: { retry: false } });
  try {
    f.max.botStarted(1);
    await f.max.waitFor((state) => state.messages.length === 1);
    for (const [index, payload] of ['setup:start', 'setup:sex:m', 'setup:birth:custom'].entries()) {
      f.max.press(1, payload);
      await f.max.waitFor((state) => state.answers.length === index + 1);
    }

    f.max.writeAttachment(1);
    await f.max.waitFor((state) => state.messages.length === 2);
    assert.match(f.max.state.messages.at(-1).body.text, /формате ММ.ГГГГ/);
    f.max.write(1, '1'.repeat(5000));
    await f.max.waitFor((state) => state.messages.length === 3);
    f.max.write(1, '01.2030');
    await f.max.waitFor((state) => state.messages.length === 4);
    assert.match(f.max.state.messages.at(-1).body.text, /от 40 до 100/);
    f.max.write(1, '01.1900');
    await f.max.waitFor((state) => state.messages.length === 5);
    assert.match(f.max.state.messages.at(-1).body.text, /от 40 до 100/);
    f.max.write(1, '04.1963');
    await f.max.waitFor((state) => state.messages.length === 6);

    for (const [index, payload] of [
      'setup:region:other',
      'setup:emp:other',
      'setup:early:unsure',
    ].entries()) {
      f.max.press(1, payload);
      await f.max.waitFor((state) => state.answers.length === index + 4);
    }
    const uncertainPlan = f.planFor(1);
    assert.ok(uncertainPlan.early_warning);
    assert.ok(!uncertainPlan.tasks.some((task) => task.id === 'dispensary_and_days'));
    assert.ok(!uncertainPlan.tasks.some((task) => task.id === 'job_guarantees'));

    f.max.botStarted(2);
    await f.max.waitFor((state) => state.messages.length === 7);
    for (const payload of [
      'setup:start',
      'setup:sex:f',
      'setup:by:1968',
      'setup:bm:4',
      'setup:region:moscow',
      'setup:emp:employee',
      'setup:early:yes',
    ]) {
      const expected = f.max.state.answers.length + 1;
      f.max.press(2, payload);
      await f.max.waitFor((state) => state.answers.length === expected);
    }
    const earlyPlan = f.planFor(2);
    assert.equal(earlyPlan.tasks.length, 1);
    assert.equal(earlyPlan.tasks[0].id, 'regional_measures');
    assert.match(f.max.state.answers.at(-1).body.message.text, /досрочной пенсии/);
  } finally {
    await stopFixture(f, run);
  }
});

test('при ошибке редактирования callback бот отправляет новое сообщение', async () => {
  const f = await fixture();
  const run = f.bot.start({ mode: 'polling', options: { retry: false } });
  try {
    f.max.botStarted(1);
    await f.max.waitFor((state) => state.messages.length === 1);
    f.max.press(1, 'setup:start');
    await f.max.waitFor((state) => state.answers.length === 1);
    f.max.failNextAnswer(400);
    f.max.press(1, 'setup:sex:m');
    await f.max.waitFor((state) => state.messages.length === 2);
    assert.equal(f.storage.getUser(1).step, 'birth_year');
    assert.match(f.max.state.messages.at(-1).body.text, /Выберите год рождения/);
  } finally {
    await stopFixture(f, run);
  }
});

test('команда dates показывает все три временных состояния', async () => {
  const f = await fixture();
  const profiles = [
    [1, '1975-04', /ещё не начался/],
    [2, '1963-04', /ориентировочно идёт/],
    [3, '1959-04', /уже наступила/],
  ];
  for (const [userId, birthYm] of profiles) {
    f.storage.saveUser({
      user_id: userId,
      step: 'ready',
      sex: 'm',
      birth_ym: birthYm,
      region: 'other',
      employment: 'other',
      early: 'no',
    });
  }
  const run = f.bot.start({ mode: 'polling', options: { retry: false } });
  try {
    for (const [userId, _birthYm, expected] of profiles) {
      const count = f.max.state.messages.length + 1;
      f.max.write(userId, '/dates');
      await f.max.waitFor((state) => state.messages.length === count);
      assert.match(f.max.state.messages.at(-1).body.text, expected);
    }
  } finally {
    await stopFixture(f, run);
  }
});

test('состояние мастера сохраняется после перезапуска бота', async () => {
  const f = await fixture();
  const firstRun = f.bot.start({ mode: 'polling', options: { retry: false } });
  f.max.botStarted(1);
  await f.max.waitFor((state) => state.messages.length === 1);
  f.max.press(1, 'setup:start');
  await f.max.waitFor((state) => state.answers.length === 1);
  f.max.press(1, 'setup:sex:m');
  await f.max.waitFor((state) => state.answers.length === 2);
  assert.equal(f.storage.getUser(1).step, 'birth_year');
  f.bot.stopPolling();
  await firstRun;

  const { bot: restarted } = f.makeBot();
  const secondRun = restarted.start({ mode: 'polling', options: { retry: false } });
  try {
    await f.max.waitFor((state) => (state.requests.get('GET /me') ?? 0) >= 2);
    await f.max.waitFor((state) => state.answers.length >= 4);
    f.max.press(1, 'setup:by:1963');
    await f.max.waitFor(() => f.storage.getUser(1).step === 'birth_month:1963');
  } finally {
    restarted.stopPolling();
    await secondRun;
    f.storage.close();
    await f.max.close();
  }
});

test('команды регистрируются через PATCH /me/commands', async () => {
  const f = await fixture();
  try {
    assert.equal(await registerBotCommands(f.bot, { warn() {} }), true);
    assert.ok(f.max.state.commands.some((command) => command.name === 'start'));
    assert.ok(f.max.state.commands.some((command) => command.name === 'reset'));
  } finally {
    f.storage.close();
    await f.max.close();
  }
});

test('429 при отправке повторяется, а open_app получает link fallback', async () => {
  const f = await fixture({ miniappEnabled: true });
  f.max.state.rejectOpenApp = true;
  f.storage.saveUser({
    user_id: 1,
    step: 'ready',
    sex: 'm',
    birth_ym: '1963-04',
    region: 'moscow',
    employment: 'employee',
    early: 'no',
  });
  f.max.failNextMessage(429);
  const run = f.bot.start({ mode: 'polling', options: { retry: false } });
  try {
    f.max.write(1, '/plan');
    await f.max.waitFor((state) => state.messages.length === 1);
    const buttons = f.max.state.messages[0].body.attachments[0].payload.buttons.flat();
    assert.ok(buttons.some((button) => button.type === 'link' && button.url.includes('startapp=plan')));
    assert.ok(!buttons.some((button) => button.type === 'open_app'));
  } finally {
    await stopFixture(f, run);
  }
});
