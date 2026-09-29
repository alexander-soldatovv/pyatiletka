import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Проверка initData мини-приложения MAX по алгоритму из документации MAX
 * (https://dev.max.ru/docs/webapps/validation):
 *  1. разбить строку по '&' на пары key=value, вынуть hash;
 *  2. URL-декодировать значения, отсортировать по ключу a->z;
 *  3. собрать строку key=value через \n;
 *  4. secret_key = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN);
 *  5. подпись = hex(HMAC_SHA256(key=secret_key, msg=launch_params)), сравнить с hash.
 *
 * Возвращает { ok, user, authDate, startParam, reason }.
 */
export function validateInitData(initData, botToken, { maxAgeSec = 3600, now = Date.now() } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof botToken !== 'string' || botToken.length === 0) return fail('не задан токен бота');
  if (!Number.isInteger(maxAgeSec) || maxAgeSec <= 0) return fail('некорректный срок действия');
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 8192) {
    return fail('initData отсутствует или слишком длинный');
  }

  const pairs = initData.split('&').map((p) => {
    const i = p.indexOf('=');
    return i === -1 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
  });

  const hashPairs = pairs.filter(([k]) => k === 'hash');
  if (hashPairs.length !== 1) return fail('параметр hash должен встречаться ровно один раз');
  const keys = pairs.map(([k]) => k);
  if (keys.some((key) => key.length === 0)) return fail('пустое имя параметра');
  if (new Set(keys).size !== keys.length) return fail('повторяющиеся параметры');

  const originalHash = hashPairs[0][1];
  if (!/^[a-fA-F0-9]{64}$/.test(originalHash)) return fail('некорректный формат hash');
  let decoded;
  try {
    decoded = pairs
      .filter(([k]) => k !== 'hash')
      .map(([k, v]) => [k, decodeURIComponent(v.replace(/\+/g, ' '))]);
  } catch {
    return fail('некорректная URL-кодировка');
  }
  decoded.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const launchParams = decoded.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(launchParams).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(originalHash).toLowerCase(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return fail('подпись не совпала');

  const map = Object.fromEntries(decoded);
  const authDate = Number(map.auth_date);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return fail('нет auth_date');
  const ageSec = Math.floor(now / 1000) - authDate;
  if (ageSec > maxAgeSec) return fail('данные запуска устарели, откройте мини-приложение заново');
  if (ageSec < -300) return fail('auth_date из будущего');

  let user = null;
  try {
    user = map.user ? JSON.parse(map.user) : null;
  } catch {
    return fail('поле user не является JSON');
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return fail('нет идентификатора пользователя');

  return { ok: true, user, authDate, startParam: map.start_param || null };
}

/** Генератор подписанного initData для тестов и локальной отладки. */
export function signInitData(params, botToken) {
  if (typeof botToken !== 'string' || botToken.length === 0) throw new TypeError('Нужен токен бота');
  if (Object.hasOwn(params, 'hash')) throw new TypeError('hash вычисляется автоматически');
  const entries = Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const launchParams = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(launchParams).digest('hex');
  return [...entries, ['hash', hash]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
