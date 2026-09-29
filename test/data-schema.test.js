import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadAndValidateData, validateData } from '../scripts/check-data.js';

function read(name) {
  return JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
}

function allData() {
  return {
    rules: read('rules.json'),
    regions: read('regions.json'),
    pensionAge: read('pension_age.json'),
    testvectors: read('testvectors.json'),
  };
}

test('рабочие данные проходят схему', () => {
  assert.deepEqual(loadAndValidateData(), []);
});

test('проверка ловит неизвестный региональный task_id', () => {
  const data = allData();
  data.regions.regions.other.task_overrides.missing_task = {};
  assert.ok(validateData(data).some((error) => error.includes('неизвестный task_id')));
});

test('проверка ловит дубликаты, плохую дату и U+2014', () => {
  const data = allData();
  data.rules.tasks.push(structuredClone(data.rules.tasks[0]));
  data.rules.tasks[0].source.checked = 'сегодня';
  data.rules.tasks[0].title = `Нельзя ${String.fromCodePoint(0x2014)} использовать`;
  const errors = validateData(data);
  assert.ok(errors.some((error) => error.includes('дубликат')));
  assert.ok(errors.some((error) => error.includes('YYYY-MM-DD')));
  assert.ok(errors.some((error) => error.includes('U+2014')));
});
