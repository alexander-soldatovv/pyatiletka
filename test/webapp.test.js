import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

test('мини-приложение подключает MAX Bridge и не использует inline-код', () => {
  const html = read('index.html');
  assert.match(html, /https:\/\/st\.max\.ru\/js\/max-web-app\.js/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /\sstyle=/);
});

test('интерфейс содержит обязательные MAX Bridge и аварийные сценарии', () => {
  const app = read('app.js');
  for (const fragment of [
    'bridge?.initData',
    'BackButton',
    'HapticFeedback',
    'openLink',
    "parsed.protocol !== 'https:'",
    'shareContent',
    'shareMaxContent',
    'navigator.clipboard',
    '/api/diagnostics/session',
    'Проверенный user ID',
    'Откройте из MAX',
    'Сессия устарела',
    'Повторить',
  ]) assert.match(app, new RegExp(fragment.replace(/[?.]/g, '\\$&')));
});

test('базовый шрифт и зоны нажатия подходят аудитории 50+', () => {
  const css = read('styles.css');
  assert.match(css, /--font-size:\s*18px/);
  assert.match(css, /min-height:\s*48px/);
  assert.match(css, /min-height:\s*52px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('в пользовательском интерфейсе нет длинного тире U+2014', () => {
  for (const name of ['index.html', 'app.js', 'styles.css']) {
    assert.equal(read(name).includes('\u2014'), false, `${name} содержит U+2014`);
  }
});
