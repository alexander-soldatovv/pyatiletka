// Работа с датами в формате YYYY-MM-DD. Арифметика идёт в UTC, поэтому нет сдвигов из-за часовых поясов.

const MS_DAY = 86_400_000;

function toUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function isValidIso(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const t = toUtc(iso);
  const dt = new Date(t);
  return dt.toISOString().slice(0, 10) === iso;
}

export function addDays(iso, n) {
  return new Date(toUtc(iso) + n * MS_DAY).toISOString().slice(0, 10);
}

/** Сколько дней от a до b (b - a). */
export function diffDays(aIso, bIso) {
  return Math.round((toUtc(bIso) - toUtc(aIso)) / MS_DAY);
}

/** Разбор даты ДД.ММ.ГГГГ (также принимает / и -). Возвращает ISO или null. */
export function parseRuDate(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isValidIso(iso) ? iso : null;
}

/** Разбор месяца рождения ММ.ГГГГ. Возвращает YYYY-MM или null. */
export function parseBirthYm(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^(\d{1,2})[./-](\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const year = Number(match[2]);
  if (month < 1 || month > 12 || year < 1900 || year > 2200) return null;
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function formatRu(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Сегодняшняя дата в заданном часовом поясе. */
export function todayIso(tz = 'Europe/Moscow', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts; // en-CA даёт YYYY-MM-DD
}

export function hourInTz(tz = 'Europe/Moscow', now = new Date()) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now);
  return Number(h);
}

/** Склонение: 1 день, 2 дня, 5 дней. */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function daysWord(n) {
  return `${n} ${plural(n, 'день', 'дня', 'дней')}`;
}
