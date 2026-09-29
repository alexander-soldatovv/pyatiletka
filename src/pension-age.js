import { readFileSync } from 'node:fs';

const DEFAULT_POLICY = JSON.parse(
  readFileSync(new URL('../data/pension_age.json', import.meta.url), 'utf8'),
);

const monthIndex = (year, month) => year * 12 + month - 1;

const fromMonthIndex = (value) => ({
  year: Math.floor(value / 12),
  month: (value % 12) + 1,
});

function assertYearMonth(value, label) {
  if (!value || !Number.isInteger(value.year) || !Number.isInteger(value.month)) {
    throw new TypeError(`${label} должен содержать целые year и month`);
  }
  if (value.year < 1900 || value.year > 2200 || value.month < 1 || value.month > 12) {
    throw new RangeError(`${label} находится вне допустимого диапазона`);
  }
}

function shiftForBaseAgeYear(year, policy) {
  const table = policy.shift_months_by_base_age_year;
  if (year < 2019) return table.before_2019;
  if (year >= 2023) return table['2023_and_later'];
  return table[String(year)];
}

export function pensionAgeMonths(sex, birthYear, policy = DEFAULT_POLICY) {
  const baseAge = policy.base_age_years?.[sex];
  if (!Number.isInteger(baseAge)) throw new RangeError('sex должен быть m или f');
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > 2200) {
    throw new RangeError('birthYear находится вне допустимого диапазона');
  }

  const baseAgeYear = birthYear + baseAge;
  const shiftMonths = shiftForBaseAgeYear(baseAgeYear, policy);
  const earlyMonths = policy.early_assignment_months_by_base_age_year?.[String(baseAgeYear)] ?? 0;

  if (!Number.isInteger(shiftMonths) || !Number.isInteger(earlyMonths)) {
    throw new TypeError('Таблица пенсионного возраста заполнена некорректно');
  }

  return baseAge * 12 + shiftMonths - earlyMonths;
}

/**
 * Ориентировочный расчёт для общеустановленной страховой пенсии.
 * Досрочные основания эта функция не рассчитывает.
 */
export function computePensionStatus(profile, now, policy = DEFAULT_POLICY) {
  const { sex, birthYear, birthMonth } = profile ?? {};
  assertYearMonth({ year: birthYear, month: birthMonth }, 'Дата рождения');
  assertYearMonth(now, 'Текущий месяц');

  const baseAge = policy.base_age_years?.[sex];
  if (!Number.isInteger(baseAge)) throw new RangeError('sex должен быть m или f');

  const ageMonths = pensionAgeMonths(sex, birthYear, policy);
  const birthIndex = monthIndex(birthYear, birthMonth);
  const rightIndex = birthIndex + ageMonths;
  const windowStartIndex = rightIndex - policy.pre_pension_window_months;
  const taxFromIndex = birthIndex + baseAge * 12;
  const currentIndex = monthIndex(now.year, now.month);

  let state = 'not_yet';
  if (currentIndex >= rightIndex) state = 'right_reached';
  else if (currentIndex >= windowStartIndex) state = 'in_window';

  return {
    approximate: true,
    age_months: ageMonths,
    age_years: ageMonths / 12,
    right: fromMonthIndex(rightIndex),
    window_start: fromMonthIndex(windowStartIndex),
    tax_from: fromMonthIndex(taxFromIndex),
    tax_active: currentIndex >= taxFromIndex,
    months_to_right: rightIndex - currentIndex,
    months_to_window: windowStartIndex - currentIndex,
    months_to_tax: taxFromIndex - currentIndex,
    state,
  };
}

export { DEFAULT_POLICY };
