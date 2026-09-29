import test from 'node:test';
import assert from 'node:assert/strict';
import { signInitData, validateInitData } from '../src/webapp-auth.js';

const token = 'test-token-not-a-real-secret';
const now = Date.parse('2026-09-29T12:00:00.000Z');
const authDate = Math.floor(now / 1000) - 10;

function valid(overrides = {}) {
  return signInitData({
    auth_date: authDate,
    query_id: 'query-1',
    start_param: 'pilot_a',
    user: { id: 12345, first_name: 'Тест' },
    ...overrides,
  }, token);
}

test('валидная подпись возвращает только проверенного пользователя', () => {
  const result = validateInitData(valid(), token, { now });
  assert.equal(result.ok, true);
  assert.equal(result.user.id, 12345);
  assert.equal(result.startParam, 'pilot_a');
});

test('подмена данных и чужой токен отклоняются', () => {
  const signed = valid();
  assert.equal(validateInitData(signed.replace('query-1', 'query-2'), token, { now }).ok, false);
  assert.equal(validateInitData(signed, 'another-token', { now }).ok, false);
});

test('повторный hash и повторный параметр отклоняются', () => {
  const signed = valid();
  const hash = new URLSearchParams(signed).get('hash');
  assert.equal(validateInitData(`${signed}&hash=${hash}`, token, { now }).ok, false);
  assert.equal(validateInitData(`${signed}&query_id=again`, token, { now }).ok, false);
});

test('устаревшие данные и дата из будущего отклоняются', () => {
  const stale = valid({ auth_date: Math.floor(now / 1000) - 3601 });
  const future = valid({ auth_date: Math.floor(now / 1000) + 301 });
  assert.match(validateInitData(stale, token, { now }).reason, /устарели/);
  assert.match(validateInitData(future, token, { now }).reason, /будущего/);
});

test('нет пользователя, неверный ID и битый JSON отклоняются', () => {
  const withoutUser = signInitData({ auth_date: authDate }, token);
  const wrongId = valid({ user: { id: '12345' } });
  const brokenJson = signInitData({ auth_date: authDate, user: '{broken' }, token);
  assert.equal(validateInitData(withoutUser, token, { now }).ok, false);
  assert.equal(validateInitData(wrongId, token, { now }).ok, false);
  assert.equal(validateInitData(brokenJson, token, { now }).ok, false);
});

test('слишком длинная строка и битая URL-кодировка отклоняются', () => {
  assert.equal(validateInitData(`a=${'x'.repeat(9000)}`, token, { now }).ok, false);
  assert.equal(validateInitData('user=%ZZ&hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', token, { now }).ok, false);
});

test('пустой токен не используется', () => {
  assert.equal(validateInitData(valid(), '', { now }).ok, false);
  assert.throws(() => signInitData({ auth_date: authDate }, ''));
});

