# Сертификаты Минцифры

`russian_trusted_ca.pem` содержит два публичных сертификата: Russian Trusted Root CA и Russian Trusted Sub CA. Node.js читает bundle через `NODE_EXTRA_CA_CERTS`.

Источник на 30.09.2026: [официальная страница Госуслуг](https://www.gosuslugi.ru/crt). Прямые файлы были получены с домена раздачи Госуслуг:

- `https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer`;
- `https://gu-st.ru/content/Other/doc/russian_trusted_sub_ca.cer`.

Проверенные SHA-256 отпечатки:

- Root: `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`;
- Sub: `BB:BD:E2:10:3E:79:0B:99:9E:C6:2B:D0:3C:F6:25:A5:A2:E7:C3:16:E1:0A:FE:6A:49:0E:ED:EA:D8:B3:FD:9B`.

Выпускающий сертификат из bundle действует до 06.03.2027. Перед production-развёртыванием откройте официальную страницу снова: если там опубликован новый выпускающий сертификат, замените второй блок в bundle.

Проверка локального файла:

```bash
openssl crl2pkcs7 -nocrl -certfile certs/russian_trusted_ca.pem \
  | openssl pkcs7 -print_certs -noout
```

Если файл удалён или путь неверен, приложение завершится с сообщением `Не найден сертификат Минцифры` и ссылкой на эту инструкцию.
