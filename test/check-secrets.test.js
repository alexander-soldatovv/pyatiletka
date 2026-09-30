import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('../p7-private-key-fixture.pem', import.meta.url));

test('сканер секретов проверяет PEM и не печатает содержимое ключа', () => {
  const marker = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  const fixtureMaterial = 'P7_PRIVATE_KEY_MATERIAL_MUST_NOT_APPEAR';
  writeFileSync(fixture, `${marker}\n${fixtureMaterial}\n`, { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, ['scripts/check-secrets.js'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /обнаружен приватный ключ/);
    assert.doesNotMatch(result.stderr, new RegExp(fixtureMaterial));
  } finally {
    unlinkSync(fixture);
  }
});
