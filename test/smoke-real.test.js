import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMockMaxServer } from './mock-max/server.js';

const execFileAsync = promisify(execFile);

test('real smoke проверяет API и отправляет карточку без вывода секрета и ID', async () => {
  const mock = await createMockMaxServer({ token: 'test-real-smoke-token' });
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/smoke-real.js', '--send'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        MAX_API_BASE: mock.baseUrl,
        BOT_TOKEN: 'test-real-smoke-token',
        BOT_USERNAME: 'pyatiletka_test_bot',
        SMOKE_USER_ID: '424242',
        NODE_EXTRA_CA_CERTS: './certs/russian_trusted_ca.pem',
      },
    });
    assert.equal(stderr, '');
    assert.match(stdout, /PASS\s+GET \/me/);
    assert.match(stdout, /PASS\s+A8: исходящее сообщение/);
    assert.doesNotMatch(stdout, /test-real-smoke-token|424242/);
    assert.equal(mock.state.messages.length, 1);
    const buttons = mock.state.messages[0].body.attachments[0].payload.buttons.flat();
    assert.equal(buttons.find((button) => button.type === 'open_app').payload, 'smoke');
    assert.equal(buttons.find((button) => button.type === 'clipboard').payload, 'PYATILETKA-P6-CLIPBOARD');
  } finally {
    await mock.close();
  }
});
