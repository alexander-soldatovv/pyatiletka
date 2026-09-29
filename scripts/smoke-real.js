import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Keyboard } from '@maxhub/max-bot-api';

const args = new Set(process.argv.slice(2));
const knownArgs = new Set(['--container', '--help', '--offline', '--send', '--webhook']);
for (const arg of args) {
  if (!knownArgs.has(arg)) throw new Error(`Неизвестный аргумент: ${arg}`);
}

if (args.has('--help')) {
  console.log(`Проверка реального MAX без вывода секретов.

  npm run smoke:real                 TLS, GET /me и список webhook-подписок
  npm run smoke:real -- --offline    только локальный сертификат и payload кнопок
  npm run smoke:real -- --send       отправить владельцу P6-карточку (нужен SMOKE_USER_ID)
  npm run smoke:real -- --webhook    проверить healthz и наличие production webhook
  npm run smoke:real -- --container  выполнить GET /me внутри уже запущенного app`);
  process.exit(0);
}

if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const maxApiBase = (process.env.MAX_API_BASE || 'https://platform-api2.max.ru').replace(/\/$/u, '');
const defaultCertPath = './certs/russian_trusted_ca.pem';
const configuredCertPath = process.env.NODE_EXTRA_CA_CERTS || defaultCertPath;
const certPath = existsSync(configuredCertPath) ? configuredCertPath : defaultCertPath;
const token = process.env.BOT_TOKEN || '';
const botUsername = (process.env.BOT_USERNAME || '').replace(/^@/u, '');

function result(status, label, detail = '') {
  console.log(`${status.padEnd(7)} ${label}${detail ? `: ${detail}` : ''}`);
}

function certificateBundle() {
  if (!existsSync(certPath)) throw new Error(`Не найден CA bundle: ${certPath}`);
  const pem = readFileSync(certPath, 'utf8');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu) ?? [];
  if (blocks.length < 2) throw new Error('CA bundle должен содержать корневой и выпускающий сертификаты');
  for (const block of blocks) {
    const cert = new X509Certificate(block);
    if (Date.parse(cert.validTo) <= Date.now()) throw new Error(`Сертификат просрочен: ${cert.subject}`);
  }
  result('PASS', 'CA bundle', `${blocks.length} действующих сертификата`);
  return pem;
}

function requestJson(url, { method = 'GET', headers = {}, body = null, ca = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const parsedUrl = new URL(url);
    const requester = parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester(parsedUrl, {
      method,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      ca,
      timeout: 15_000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: response.statusCode, data });
      });
    });
    req.once('timeout', () => req.destroy(new Error(`Таймаут запроса к ${parsedUrl.host}`)));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function authorization() {
  if (!token) throw new Error('Для этой проверки нужен BOT_TOKEN в локальном .env');
  return { Authorization: token };
}

function smokeKeyboard() {
  if (!botUsername) throw new Error('Для P6-карточки нужен BOT_USERNAME в локальном .env');
  return Keyboard.inlineKeyboard([
    [Keyboard.button.openApp('Открыть диагностику P6', botUsername, undefined, 'smoke')],
    [Keyboard.button.clipboard('Скопировать проверочную строку', 'PYATILETKA-P6-CLIPBOARD')],
  ]);
}

function validateKeyboard() {
  const username = botUsername || 'example_bot';
  const attachment = Keyboard.inlineKeyboard([
    [Keyboard.button.openApp('Открыть диагностику P6', username, undefined, 'smoke')],
    [Keyboard.button.clipboard('Скопировать проверочную строку', 'PYATILETKA-P6-CLIPBOARD')],
  ]);
  const buttons = attachment.payload?.buttons?.flat() ?? [];
  const openApp = buttons.find((button) => button.type === 'open_app');
  const clipboard = buttons.find((button) => button.type === 'clipboard');
  if (openApp?.web_app !== username || openApp?.payload !== 'smoke' || clipboard?.payload !== 'PYATILETKA-P6-CLIPBOARD') {
    throw new Error('SDK сформировал неожиданный payload P6-кнопок');
  }
  result('PASS', 'Payload кнопок', 'open_app и clipboard соответствуют SDK 0.3.1');
}

async function checkMax(ca) {
  const response = await requestJson(`${maxApiBase}/me`, {
    headers: token ? authorization() : {}, ca,
  });
  if (!token) {
    if (![401, 403].includes(response.status)) throw new Error(`GET /me без токена вернул HTTP ${response.status}`);
    result('PASS', 'TLS до MAX', `ожидаемый HTTP ${response.status} без токена`);
    result('PENDING', 'Реальный бот', 'BOT_TOKEN не найден в .env');
    return null;
  }
  if (response.status !== 200 || !response.data?.is_bot || !response.data?.username) {
    throw new Error(`GET /me с токеном не подтвердил бота, HTTP ${response.status}`);
  }
  if (botUsername && response.data.username !== botUsername) {
    throw new Error('BOT_USERNAME не совпадает с username, возвращённым GET /me');
  }
  result('PASS', 'GET /me', `бот @${response.data.username}, токен не выведен`);

  const subscriptions = await requestJson(`${maxApiBase}/subscriptions`, { headers: authorization(), ca });
  if (subscriptions.status !== 200) throw new Error(`GET /subscriptions вернул HTTP ${subscriptions.status}`);
  const list = Array.isArray(subscriptions.data) ? subscriptions.data : subscriptions.data?.subscriptions;
  result('PASS', 'Webhook-подписки', `API доступен, подписок: ${Array.isArray(list) ? list.length : 0}`);
  return { bot: response.data, subscriptions: Array.isArray(list) ? list : [] };
}

async function sendSmokeCard(ca) {
  const userId = process.env.SMOKE_USER_ID || '';
  if (!/^[1-9]\d{0,18}$/u.test(userId)) {
    throw new Error('Для --send задайте SMOKE_USER_ID из команды /id');
  }
  const url = new URL(`${maxApiBase}/messages`);
  url.searchParams.set('user_id', userId);
  const response = await requestJson(url, {
    method: 'POST', headers: authorization(), ca,
    body: {
      text: 'P6: проверьте запуск Mini App и clipboard. Карточка создана только для smoke-теста.',
      attachments: [smokeKeyboard()],
    },
  });
  if (response.status !== 200 || !response.data?.message) {
    throw new Error(`Отправка P6-карточки вернула HTTP ${response.status}`);
  }
  result('PASS', 'A8: исходящее сообщение', 'API принял сообщение после bot_started');
  result('PENDING', 'A2/A3/A5', 'проверьте две кнопки в полученной P6-карточке');
}

async function checkWebhook(subscriptions) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/u, '');
  const path = process.env.WEBHOOK_PATH || '/webhook';
  if (!base.startsWith('https://')) throw new Error('Для --webhook нужен PUBLIC_BASE_URL с https://');
  if (!process.env.WEBHOOK_SECRET) throw new Error('Для --webhook нужен WEBHOOK_SECRET');
  const health = await requestJson(`${base}/healthz`);
  if (health.status !== 200 || health.data?.status !== 'ok') {
    throw new Error(`Публичный healthz вернул HTTP ${health.status}`);
  }
  const expectedUrl = `${base}${path}`;
  if (!subscriptions.some((subscription) => subscription.url === expectedUrl)) {
    throw new Error(`В MAX нет подписки на ${expectedUrl}`);
  }
  result('PASS', 'Webhook URL и healthz', 'HTTPS endpoint доступен и зарегистрирован');
  result('PENDING', 'A6: реальное событие', 'отправьте /id и подтвердите получение через webhook в логах');
}

function checkContainer() {
  const code = "fetch('https://platform-api2.max.ru/me',{headers:{Authorization:process.env.BOT_TOKEN}}).then(r=>{console.log('container MAX HTTP '+r.status);process.exit(r.status===200?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})";
  let command = 'docker';
  let prefix = ['compose'];
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
    command = 'docker-compose';
    prefix = [];
  }
  const run = spawnSync(command, [...prefix, 'exec', '-T', 'app', 'node', '-e', code], { stdio: 'inherit' });
  if (run.error || run.status !== 0) throw new Error('Проверка внутри контейнера не прошла');
  result('PASS', 'A4: MAX из контейнера', 'GET /me вернул HTTP 200');
}

async function main() {
  console.log('P6 smoke MAX. Секреты и SMOKE_USER_ID в вывод не попадают.');
  const ca = certificateBundle();
  validateKeyboard();
  if (args.has('--offline')) {
    result('PENDING', 'Сеть и реальный MAX', 'offline-режим');
    return;
  }
  const live = await checkMax(ca);
  if (args.has('--send')) {
    if (!live) throw new Error('--send требует действующий BOT_TOKEN');
    await sendSmokeCard(ca);
  }
  if (args.has('--webhook')) {
    if (!live) throw new Error('--webhook требует действующий BOT_TOKEN');
    await checkWebhook(live.subscriptions);
  }
  if (args.has('--container')) checkContainer();
}

main().catch((error) => {
  console.error(`FAIL    ${error.message}`);
  process.exitCode = 1;
});
