import { createServer } from 'node:http';

function json(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  response.end(data);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function user(userId) {
  return {
    user_id: userId,
    first_name: 'Тест',
    last_name: 'Пользователь',
    username: `user_${userId}`,
    name: 'Тест Пользователь',
    is_bot: false,
    last_activity_time: Date.now(),
  };
}

function incomingMessage(userId, text, mid, attachments = null) {
  return {
    sender: user(userId),
    recipient: { chat_id: userId, chat_type: 'dialog', user_id: null, post_id: null },
    timestamp: Date.now(),
    body: { mid, seq: 1, text, attachments, markup: null },
  };
}

function hasOpenApp(body) {
  return body.attachments?.some((attachment) => (
    attachment.type === 'inline_keyboard'
    && attachment.payload.buttons.flat().some((button) => button.type === 'open_app')
  ));
}

export async function createMockMaxServer({ token = 'mock-token' } = {}) {
  const state = {
    updates: [],
    messages: [],
    answers: [],
    commands: [],
    subscriptions: [],
    currentMessages: new Map(),
    nextMessageFailure: null,
    nextAnswerFailure: null,
    rejectOpenApp: false,
    requests: new Map(),
  };
  let sequence = 0;

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== token) return json(response, 401, { code: 'verify.token', message: 'Invalid token' });
      const url = new URL(request.url, 'http://127.0.0.1');
      const requestKey = `${request.method} ${url.pathname}`;
      state.requests.set(requestKey, (state.requests.get(requestKey) ?? 0) + 1);

      if (request.method === 'GET' && url.pathname === '/me') {
        return json(response, 200, {
          ...user(999),
          first_name: 'Пятилетка',
          username: 'pyatiletka_test_bot',
          is_bot: true,
        });
      }
      if (request.method === 'GET' && url.pathname === '/subscriptions') {
        return json(response, 200, { subscriptions: state.subscriptions });
      }
      if (request.method === 'POST' && url.pathname === '/subscriptions') {
        const body = await readJson(request);
        state.subscriptions = [body];
        return json(response, 200, { success: true });
      }
      if (request.method === 'GET' && url.pathname === '/chats') {
        return json(response, 410, { code: 'method.removed', message: 'Use POST /subscriptions' });
      }
      if (request.method === 'DELETE' && url.pathname === '/subscriptions') {
        state.subscriptions = [];
        return json(response, 200, { success: true });
      }
      if (request.method === 'GET' && url.pathname === '/updates') {
        const marker = Number(url.searchParams.get('marker') ?? 0);
        let updates = state.updates.slice(marker);
        await new Promise((resolve) => setTimeout(resolve, updates.length ? 0 : 10));
        updates = state.updates.slice(marker);
        return json(response, 200, { updates, marker: marker + updates.length });
      }
      if (request.method === 'PATCH' && url.pathname === '/me/commands') {
        const body = await readJson(request);
        state.commands = body.commands ?? [];
        return json(response, 200, { success: true });
      }
      if (request.method === 'POST' && url.pathname === '/messages') {
        const body = await readJson(request);
        if (state.nextMessageFailure) {
          const status = state.nextMessageFailure;
          state.nextMessageFailure = null;
          return json(response, status, { code: 'mock.failure', message: 'Mock failure' });
        }
        if (state.rejectOpenApp && hasOpenApp(body)) {
          return json(response, 400, { code: 'open_app.unavailable', message: 'Open app unavailable' });
        }
        const chatId = Number(url.searchParams.get('chat_id') ?? url.searchParams.get('user_id'));
        const message = {
          sender: { ...user(999), is_bot: true },
          recipient: { chat_id: chatId, chat_type: 'dialog', user_id: null, post_id: null },
          timestamp: Date.now(),
          body: {
            mid: `bot-${++sequence}`,
            seq: sequence,
            text: body.text ?? null,
            attachments: body.attachments ?? null,
            markup: null,
          },
        };
        state.messages.push({ chatId, body, message });
        state.currentMessages.set(chatId, message);
        return json(response, 200, { message });
      }
      if (request.method === 'POST' && url.pathname === '/answers') {
        const body = await readJson(request);
        if (state.nextAnswerFailure) {
          const status = state.nextAnswerFailure;
          state.nextAnswerFailure = null;
          return json(response, status, { code: 'mock.failure', message: 'Mock failure' });
        }
        if (state.rejectOpenApp && hasOpenApp(body.message ?? {})) {
          return json(response, 400, { code: 'open_app.unavailable', message: 'Open app unavailable' });
        }
        const callbackId = url.searchParams.get('callback_id');
        state.answers.push({ callbackId, body });
        const chatId = Number(callbackId.split(':')[0]);
        const previous = state.currentMessages.get(chatId);
        if (previous && body.message) {
          state.currentMessages.set(chatId, {
            ...previous,
            body: {
              ...previous.body,
              text: body.message.text ?? null,
              attachments: body.message.attachments ?? null,
            },
          });
        }
        return json(response, 200, { success: true });
      }

      return json(response, 404, { code: 'not.found', message: 'Not found' });
    } catch (error) {
      return json(response, 500, { code: 'mock.error', message: error.message });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  function push(update) {
    state.updates.push({ ...update, timestamp: Date.now() + state.updates.length });
  }

  return {
    baseUrl,
    state,
    botStarted(userId = 1) {
      push({ update_type: 'bot_started', chat_id: userId, user: user(userId), payload: null });
    },
    write(userId, text) {
      push({ update_type: 'message_created', message: incomingMessage(userId, text, `user-${++sequence}`) });
    },
    writeAttachment(userId) {
      push({
        update_type: 'message_created',
        message: incomingMessage(userId, null, `user-${++sequence}`, [{ type: 'image', payload: { token: 'mock' } }]),
      });
    },
    press(userId, payload) {
      const message = state.currentMessages.get(userId);
      if (!message) throw new Error('Нет сообщения для callback');
      const buttons = message.body.attachments?.find((attachment) => attachment.type === 'inline_keyboard')?.payload.buttons.flat() ?? [];
      if (!buttons.some((button) => button.payload === payload)) throw new Error(`Кнопка ${payload} не найдена`);
      this.callback(userId, payload);
    },
    callback(userId, payload) {
      const message = state.currentMessages.get(userId);
      if (!message) throw new Error('Нет сообщения для callback');
      push({
        update_type: 'message_callback',
        callback: {
          timestamp: Date.now(),
          callback_id: `${userId}:${++sequence}`,
          payload,
          user: user(userId),
        },
        message,
        user_locale: 'ru',
      });
    },
    failNextMessage(status) {
      state.nextMessageFailure = status;
    },
    failNextAnswer(status) {
      state.nextAnswerFailure = status;
    },
    async waitFor(predicate, { timeoutMs = 2000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(state)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Превышено время ожидания mock MAX: messages=${state.messages.length}, answers=${state.answers.length}, updates=${state.updates.length}`);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
