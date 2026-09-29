import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computePensionStatus, pensionAgeMonths } from '../src/pension-age.js';

const testvectors = JSON.parse(
  readFileSync(new URL('../data/testvectors.json', import.meta.url), 'utf8'),
);

for (const vector of testvectors.vectors) {
  test(`возраст по закону: ${vector.sex} ${vector.birth_year}`, () => {
    assert.equal(
      pensionAgeMonths(vector.sex, vector.birth_year),
      vector.expected_age_months,
    );
  });
}

test('льгота первых двух лет уменьшает возраст из Приложения 6 на 6 месяцев', () => {
  const man1959 = computePensionStatus(
    { sex: 'm', birthYear: 1959, birthMonth: 1 },
    { year: 2019, month: 7 },
  );
  const woman1965 = computePensionStatus(
    { sex: 'f', birthYear: 1965, birthMonth: 8 },
    { year: 2022, month: 2 },
  );

  assert.equal(man1959.age_months, 60 * 12 + 6);
  assert.deepEqual(man1959.right, { year: 2019, month: 7 });
  assert.equal(woman1965.age_months, 56 * 12 + 6);
  assert.deepEqual(woman1965.right, { year: 2022, month: 2 });
});

test('границы статусов переключаются точно в начале месяца', () => {
  const profile = { sex: 'm', birthYear: 1963, birthMonth: 4 };

  assert.equal(computePensionStatus(profile, { year: 2023, month: 3 }).state, 'not_yet');
  assert.equal(computePensionStatus(profile, { year: 2023, month: 4 }).state, 'in_window');
  assert.equal(computePensionStatus(profile, { year: 2028, month: 4 }).state, 'right_reached');
});

test('налоговая граница считается от прежнего возраста', () => {
  const man = computePensionStatus(
    { sex: 'm', birthYear: 1966, birthMonth: 5 },
    { year: 2026, month: 9 },
  );
  const woman = computePensionStatus(
    { sex: 'f', birthYear: 1971, birthMonth: 5 },
    { year: 2026, month: 4 },
  );

  assert.deepEqual(man.tax_from, { year: 2026, month: 5 });
  assert.equal(man.tax_active, true);
  assert.deepEqual(woman.tax_from, { year: 2026, month: 5 });
  assert.equal(woman.tax_active, false);
});

test('невалидный ввод отклоняется', () => {
  const now = { year: 2026, month: 1 };
  assert.throws(() => computePensionStatus({ sex: 'x', birthYear: 1965, birthMonth: 1 }, now));
  assert.throws(() => computePensionStatus({ sex: 'm', birthYear: 1965, birthMonth: 13 }, now));
  assert.throws(() => computePensionStatus({ sex: 'm', birthYear: 1899, birthMonth: 1 }, now));
  assert.throws(() => computePensionStatus({ sex: 'm', birthYear: 1965, birthMonth: 1 }, { year: 2026, month: 0 }));
});

