import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';

const path = new URL('../certs/russian_trusted_ca.pem', import.meta.url);
const pem = readFileSync(path, 'utf8');
const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu) ?? [];
const expected = new Map([
  ['CN=Russian Trusted Root CA', 'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31'],
  ['CN=Russian Trusted Sub CA', 'BB:BD:E2:10:3E:79:0B:99:9E:C6:2B:D0:3C:F6:25:A5:A2:E7:C3:16:E1:0A:FE:6A:49:0E:ED:EA:D8:B3:FD:9B'],
]);

if (blocks.length !== 2) throw new Error(`Ожидалось два сертификата, найдено: ${blocks.length}`);
for (const block of blocks) {
  const certificate = new X509Certificate(block);
  const name = [...expected.keys()].find((candidate) => certificate.subject.includes(candidate));
  if (!name || certificate.fingerprint256 !== expected.get(name)) {
    throw new Error(`Неожиданный сертификат или отпечаток: ${certificate.subject}`);
  }
  if (Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error(`Сертификат просрочен: ${certificate.subject}, ${certificate.validTo}`);
  }
  console.log(`${name}: отпечаток и срок действия проверены, действует до ${certificate.validTo}`);
}

if (process.argv.includes('--offline')) process.exit(0);

await new Promise((resolve, reject) => {
  const req = request('https://platform-api2.max.ru/me', { ca: pem, timeout: 10_000 }, (response) => {
    response.resume();
    response.once('end', () => {
      if (![401, 403].includes(response.statusCode)) {
        reject(new Error(`TLS установлен, но /me вернул неожиданный HTTP ${response.statusCode}`));
        return;
      }
      console.log(`TLS до platform-api2.max.ru проверен, ожидаемый ответ без токена: HTTP ${response.statusCode}`);
      resolve();
    });
  });
  req.once('timeout', () => req.destroy(new Error('Таймаут TLS-проверки MAX')));
  req.once('error', reject);
  req.end();
});
