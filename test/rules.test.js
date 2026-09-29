import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, loadRulesData } from '../src/rules.js';

const now = { year: 2026, month: 9 };

function profile(overrides = {}) {
  return {
    sex: 'm',
    birthYear: 1963,
    birthMonth: 4,
    region: 'moscow',
    employment: 'employee',
    early: 'no',
    ...overrides,
  };
}

test('карта строится для всех сочетаний профиля', () => {
  for (const sex of ['m', 'f']) {
    for (const region of ['moscow', 'other']) {
      for (const employment of ['employee', 'other']) {
        for (const early of ['no', 'yes', 'unsure']) {
          const plan = buildPlan({ profile: profile({ sex, region, employment, early }), now });
          assert.ok(plan.tasks.length > 0, `${sex}/${region}/${employment}/${early}`);
          assert.equal(plan.region.id, region);
        }
      }
    }
  }
});

test('шаги работодателя скрываются для другой занятости', () => {
  const plan = buildPlan({ profile: profile({ employment: 'other' }), now });
  const ids = plan.tasks.map((task) => task.id);
  assert.ok(!ids.includes('dispensary_and_days'));
  assert.ok(!ids.includes('job_guarantees'));
  assert.ok(ids.includes('pension_rights_check'));
});

test('при досрочной пенсии остаётся предупреждение и безопасная сокращённая карта', () => {
  const plan = buildPlan({ profile: profile({ early: 'yes' }), now });
  assert.match(plan.early_warning, /СФР/);
  assert.deepEqual(plan.tasks.map((task) => task.id), ['regional_measures']);
});

test('регион переопределяет каналы без изменения движка', () => {
  const plan = buildPlan({ profile: profile({ region: 'moscow' }), now });
  const regional = plan.tasks.find((task) => task.id === 'regional_measures');
  assert.equal(regional.channels[0].label, 'Московское долголетие (mos.ru)');
});

test('годовая отметка действует только в своём календарном году', () => {
  const state2026 = [{ task_id: 'dispensary_and_days', period: '2026', status: 'done' }];
  const current = buildPlan({ profile: profile(), now, taskStates: state2026 });
  const next = buildPlan({ profile: profile(), now: { year: 2027, month: 1 }, taskStates: state2026 });

  assert.equal(current.tasks.find((task) => task.id === 'dispensary_and_days').completed, true);
  assert.equal(next.tasks.find((task) => task.id === 'dispensary_and_days').completed, false);
});

test('веха становится доступной за указанное число месяцев', () => {
  const before = buildPlan({ profile: profile(), now: { year: 2027, month: 3 } });
  const onTime = buildPlan({ profile: profile(), now: { year: 2027, month: 4 } });

  assert.equal(before.tasks.find((task) => task.id === 'pension_rights_check').availability, 'upcoming');
  assert.equal(onTime.tasks.find((task) => task.id === 'pension_rights_check').availability, 'due');
});

test('налоговый шаг не показывается как срочный до прежнего пенсионного возраста', () => {
  const plan = buildPlan({
    profile: profile({ sex: 'f', birthYear: 1972, birthMonth: 10 }),
    now: { year: 2026, month: 9 },
  });
  const tax = plan.tasks.find((task) => task.id === 'property_tax_benefit');
  assert.equal(tax.availability, 'upcoming');
  assert.equal(tax.months_until_available, 13);
});

test('новый регион подключается только данными', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pyatiletka-region-'));
  const regions = JSON.parse(readFileSync(new URL('../data/regions.json', import.meta.url), 'utf8'));
  regions.regions.test_region = {
    label: 'Тестовый регион',
    task_overrides: {
      regional_measures: {
        channels: [{ label: 'Официальный портал', url: 'https://example.test/' }],
        extra_note: 'Тестовый пакет без изменения кода.'
      }
    }
  };
  const path = join(directory, 'regions.json');
  writeFileSync(path, JSON.stringify(regions), 'utf8');

  try {
    const data = loadRulesData({ regionsPath: path });
    const plan = buildPlan({ profile: profile({ region: 'test_region' }), now, data });
    const regional = plan.tasks.find((task) => task.id === 'regional_measures');
    assert.equal(regional.channels[0].label, 'Официальный портал');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('неизвестный регион отклоняется', () => {
  assert.throws(() => buildPlan({ profile: profile({ region: 'missing' }), now }));
});
