import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeErrorDetails } from './metrics.js';
import { buildPlan, loadRulesData } from './rules.js';
import { validateInitData } from './webapp-auth.js';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' https://st.max.ru",
    "style-src 'self'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    'frame-ancestors https://max.ru https://*.max.ru',
  ].join('; '),
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function currentMonth(clock, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(clock());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month) };
}

function json(response, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(data);
}

function errorJson(response, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message = error instanceof HttpError ? error.message : 'Внутренняя ошибка сервера.';
  const headers = error?.retryAfter ? { 'retry-after': error.retryAfter } : {};
  json(response, status, { error: { code, message } }, headers);
}

function secretMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJsonBody(request, maxBytes) {
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'content_type', 'Ожидается Content-Type: application/json.');
  }
  const statedLength = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(statedLength) && statedLength > maxBytes) {
    request.resume();
    throw new HttpError(413, 'body_too_large', 'Тело запроса слишком большое.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      request.resume();
      throw new HttpError(413, 'body_too_large', 'Тело запроса слишком большое.');
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Не удалось прочитать JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_body', 'Тело запроса должно быть объектом.');
  }
  return value;
}

function sanitizedProfile(user) {
  if (!user) return null;
  return {
    step: user.step,
    sex: user.sex,
    birth_ym: user.birth_ym,
    region: user.region,
    employment: user.employment,
    early: user.early,
  };
}

function planningProfile(user) {
  if (!user || user.step !== 'ready' || !/^\d{4}-\d{2}$/.test(user.birth_ym ?? '')) return null;
  const [birthYear, birthMonth] = user.birth_ym.split('-').map(Number);
  return {
    sex: user.sex,
    birthYear,
    birthMonth,
    region: user.region,
    employment: user.employment,
    early: user.early,
  };
}

function stateForUser(storage, userId, now, rulesData = loadRulesData()) {
  const user = storage.getUser(userId);
  const profile = planningProfile(user);
  if (!profile) {
    return {
      profile: sanitizedProfile(user),
      calculation: null,
      tasks: [],
      progress: { completed: 0, total: 0 },
      rules_version: null,
      disclaimer: null,
      early_warning: null,
    };
  }
  const plan = buildPlan({ profile, now, taskStates: storage.getTaskStates(userId), data: rulesData });
  return {
    profile: sanitizedProfile(user),
    calculation: plan.calculation,
    tasks: plan.tasks,
    progress: plan.progress,
    rules_version: plan.rules_version,
    disclaimer: plan.disclaimer,
    early_warning: plan.early_warning,
    region: plan.region,
  };
}

function validateProfile(body, now, regionIds) {
  const allowedKeys = new Set(['sex', 'birth_ym', 'region', 'employment', 'early']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(400, 'invalid_profile', 'В профиле есть неизвестные поля.');
  }
  if (!['m', 'f'].includes(body.sex)) throw new HttpError(400, 'invalid_profile', 'Некорректно указан пол.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(body.birth_ym ?? '')) {
    throw new HttpError(400, 'invalid_profile', 'Месяц рождения должен иметь формат ГГГГ-ММ.');
  }
  if (!regionIds.has(body.region)) throw new HttpError(400, 'invalid_profile', 'Некорректно указан регион.');
  if (!['employee', 'other'].includes(body.employment)) throw new HttpError(400, 'invalid_profile', 'Некорректно указана занятость.');
  if (!['no', 'yes', 'unsure'].includes(body.early)) throw new HttpError(400, 'invalid_profile', 'Некорректно указан признак досрочной пенсии.');
  const [year, month] = body.birth_ym.split('-').map(Number);
  const ageMonths = now.year * 12 + now.month - (year * 12 + month);
  if (ageMonths < 40 * 12 || ageMonths > 100 * 12) {
    throw new HttpError(400, 'invalid_profile', 'Сервис рассчитан на возраст от 40 до 100 лет.');
  }
}

function createRateLimiter({ limit, windowMs, clock }) {
  const buckets = new Map();
  return (userId) => {
    const time = clock().getTime();
    const key = String(userId);
    let bucket = buckets.get(key);
    if (!bucket || time >= bucket.resetAt) {
      bucket = { count: 0, resetAt: time + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit
      ? { allowed: true, retryAfter: 0 }
      : { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - time) / 1000)) };
  };
}

async function serveStatic(request, response, pathname, publicDir) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    throw new HttpError(405, 'method_not_allowed', 'Метод не поддерживается.');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'invalid_path', 'Некорректный адрес.');
  }
  const relative = decoded === '/' ? '/index.html' : decoded;
  const root = resolve(publicDir);
  const filePath = resolve(root, `.${relative}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    throw new HttpError(404, 'not_found', 'Страница не найдена.');
  }
  let content;
  try {
    content = await readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') {
      throw new HttpError(404, 'not_found', 'Страница не найдена.');
    }
    throw error;
  }
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'cache-control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=300',
    'content-length': content.length,
    'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
  });
  response.end(request.method === 'HEAD' ? undefined : content);
}

export function createHttpServer({
  storage,
  config,
  clock = () => new Date(),
  publicDir = fileURLToPath(new URL('../public/', import.meta.url)),
  logger = console,
  webhookHandler = null,
  metrics = null,
  healthProvider = null,
} = {}) {
  if (!storage) throw new TypeError('Нужно хранилище');
  if (!config?.botToken) throw new TypeError('Нужен BOT_TOKEN');
  const rulesData = loadRulesData();
  const regionIds = new Set(Object.keys(rulesData.regions.regions));
  const now = () => currentMonth(clock, config.reminderTz ?? 'Europe/Moscow');
  const checkRate = createRateLimiter({ limit: config.apiRateLimit ?? 60, windowMs: 60_000, clock });

  function authenticate(request) {
    const raw = request.headers['x-max-init-data'];
    if (Array.isArray(raw)) throw new HttpError(401, 'auth_invalid', 'Некорректные данные запуска.');
    if (config.allowDemoAuth && raw === 'demo') return { userId: config.demoUserId ?? 900000001, demo: true, startParam: null };
    const result = validateInitData(raw, config.botToken, {
      maxAgeSec: config.initDataMaxAgeSec ?? 3600,
      now: clock().getTime(),
    });
    if (!result.ok) {
      const stale = /устарели|будущего/.test(result.reason);
      throw new HttpError(401, stale ? 'auth_stale' : 'auth_invalid', stale
        ? 'Сессия устарела. Закройте и снова откройте мини-приложение из MAX.'
        : 'Откройте мини-приложение из MAX.');
    }
    return { userId: result.user.id, demo: false, startParam: result.startParam };
  }

  async function api(request, response, url) {
    metrics?.increment('api_requests');
    if (request.method === 'GET' && url.pathname === '/api/stats') {
      const authorization = request.headers.authorization;
      const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : '';
      if (!secretMatches(token, config.adminToken)) {
        throw new HttpError(401, 'admin_auth', 'Нужен действующий токен администратора.');
      }
      let stats;
      try {
        stats = storage.getStats(url.searchParams.get('start') ?? '');
      } catch {
        throw new HttpError(400, 'invalid_cohort', 'Некорректный код когорты.');
      }
      return json(response, 200, { ...stats, runtime: metrics?.snapshot() ?? null });
    }
    const auth = authenticate(request);
    const currentUser = storage.getUser(auth.userId);
    if (currentUser && auth.startParam && currentUser.cohort !== auth.startParam) {
      storage.saveUser({ ...currentUser, cohort: auth.startParam });
    }
    const rate = checkRate(auth.userId);
    if (!rate.allowed) {
      const retryAfter = String(rate.retryAfter);
      const error = new HttpError(429, 'rate_limit', `Слишком много запросов. Повторите через ${retryAfter} сек.`);
      error.retryAfter = retryAfter;
      throw error;
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      storage.recordEvent(auth.userId, 'miniapp_opened', null, { cohort: auth.startParam ?? currentUser?.cohort });
      return json(response, 200, stateForUser(storage, auth.userId, now(), rulesData));
    }
    if (request.method === 'POST' && url.pathname === '/api/profile') {
      const body = await readJsonBody(request, config.requestBodyLimitBytes ?? 16_384);
      validateProfile(body, now(), regionIds);
      storage.saveUser({
        user_id: auth.userId,
        step: 'ready',
        cohort: auth.startParam ?? currentUser?.cohort,
        ...body,
      });
      storage.recordEvent(auth.userId, 'setup_completed', { channel: 'miniapp' });
      return json(response, 200, stateForUser(storage, auth.userId, now(), rulesData));
    }
    const taskMatch = url.pathname.match(/^\/api\/tasks\/([a-z0-9_]+)\/status$/);
    if (request.method === 'POST' && taskMatch) {
      const body = await readJsonBody(request, config.requestBodyLimitBytes ?? 16_384);
      if (!['done', 'todo'].includes(body.status)) {
        throw new HttpError(400, 'invalid_status', 'Статус должен быть done или todo.');
      }
      const state = stateForUser(storage, auth.userId, now(), rulesData);
      const task = state.tasks.find((item) => item.id === taskMatch[1]);
      if (!task) throw new HttpError(404, 'task_not_found', 'Шаг не найден для этого профиля.');
      if (body.period != null && String(body.period) !== String(task.period)) {
        throw new HttpError(409, 'period_mismatch', 'Период шага изменился. Обновите карту.');
      }
      storage.setTaskStatus(auth.userId, task.id, body.status, task.period);
      storage.recordEvent(auth.userId, body.status === 'done' ? 'task_done' : 'task_undone', {
        task_id: task.id,
        channel: 'miniapp',
      });
      return json(response, 200, stateForUser(storage, auth.userId, now(), rulesData));
    }
    if (request.method === 'DELETE' && url.pathname === '/api/me') {
      const cohort = storage.getUser(auth.userId)?.cohort ?? '';
      storage.deleteUser(auth.userId);
      storage.recordEvent(auth.userId, 'reset', null, { cohort });
      return json(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/events/share') {
      await readJsonBody(request, config.requestBodyLimitBytes ?? 16_384);
      storage.recordEvent(auth.userId, 'share_used', { channel: 'miniapp' }, {
        cohort: auth.startParam ?? currentUser?.cohort,
      });
      return json(response, 200, { ok: true });
    }
    throw new HttpError(404, 'not_found', 'Метод API не найден.');
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (webhookHandler && url.pathname === config.webhookPath) return await webhookHandler(request, response);
      if (request.method === 'GET' && url.pathname === '/healthz') {
        let checks;
        try {
          checks = healthProvider?.() ?? { database: storage.healthCheck(), bot: true };
        } catch {
          checks = { database: false, bot: false };
        }
        const healthy = Object.values(checks).every(Boolean);
        return json(response, healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'degraded',
          checks,
          runtime: metrics?.snapshot() ?? null,
        });
      }
      if (url.pathname.startsWith('/api/')) return await api(request, response, url);
      return await serveStatic(request, response, url.pathname, publicDir);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        logger.error(JSON.stringify({
          level: 'error', event: 'http_request_failed', ...safeErrorDetails(error),
        }));
      }
      metrics?.increment('http_errors');
      if (!response.headersSent) errorJson(response, error);
      else response.end();
    }
  });
  server.headersTimeout = config.headersTimeoutMs ?? 5_000;
  server.requestTimeout = config.requestTimeoutMs ?? 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export { HttpError, SECURITY_HEADERS, stateForUser };
