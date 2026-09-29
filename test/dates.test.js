import test from 'node:test';
import assert from 'node:assert/strict';
import { daysWord, parseBirthYm, parseRuDate } from '../src/dates.js';

test('месяц рождения разбирается из ММ.ГГГГ', () => {
  assert.equal(parseBirthYm('4.1963'), '1963-04');
  assert.equal(parseBirthYm(' 12/1971 '), '1971-12');
  assert.equal(parseBirthYm('13.1971'), null);
  assert.equal(parseBirthYm('1971-12'), null);
});

test('полная русская дата проверяет календарь', () => {
  assert.equal(parseRuDate('29.02.2024'), '2024-02-29');
  assert.equal(parseRuDate('29.02.2023'), null);
});

test('склонение дней', () => {
  assert.equal(daysWord(1), '1 день');
  assert.equal(daysWord(2), '2 дня');
  assert.equal(daysWord(5), '5 дней');
  assert.equal(daysWord(11), '11 дней');
  assert.equal(daysWord(21), '21 день');
});

