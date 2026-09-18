# Native Messaging: связь расширения с PrintNum без порта

Помимо HTTP-сервера (`localhost:5000`), PrintNum умеет работать через
**Native Messaging** — прямой обмен с браузером через stdin/stdout.
Это позволяет печатать **без открытого сетевого порта**.

- [Что это и зачем](#что-это-и-зачем)
- [Как это работает](#как-это-работает)
- [Протокол](#протокол)
- [Регистрация host-приложения](#регистрация-host-приложения)
- [Использование из расширения](#использование-из-расширения)
- [Проверка и отладка](#проверка-и-отладка)
- [HTTP или Native Messaging](#http-или-native-messaging)

---

## Что это и зачем

Обычно расширение общается с PrintNum по HTTP:

```
Расширение → HTTP localhost:5000 → PrintNum.exe → принтер
```

Native Messaging меняет транспорт:

```
Расширение → stdin/stdout (JSON) → PrintNum.exe --native-host → принтер
```

**Преимущества:**
- не нужен открытый порт (нет конфликта с AirPlay, VPN, другим ПО);
- доступ есть только у явно разрешённых расширений (`allowed_origins`);
- браузер сам запускает процесс.

**Недостатки:**
- требует регистрации host-манифеста в реестре (Windows);
- нельзя проверить из `curl` (только из расширения);
- сложнее отлаживать.

> **Важно:** это не даёт браузеру прямого доступа к Win32 API. Печать всё равно
> выполняет нативное приложение. Native Messaging — лишь канал связи.

---

## Как это работает

1. Расширение вызывает `chrome.runtime.sendNativeMessage("ru.printnum.host", {...})`.
2. Браузер находит host-манифест по имени в реестре.
3. Браузер запускает `printnum.exe --native-host` как дочерний процесс.
4. Обмен сообщениями идёт через **stdin** (запросы) и **stdout** (ответы).
5. При закрытии порта/вкладки браузер завершает процесс.

---

## Протокол

Каждое сообщение — **4 байта длины (little-endian) + JSON (UTF-8)**.
Максимум 1 МБ на сообщение.

### Запрос → ответ

| `command`         | Тело запроса                              | Ответ |
| ----------------- | ----------------------------------------- | ----- |
| `ping`            | —                                         | `{"status":"ok","version":"3.0.0"}` |
| `status-printer`  | —                                         | `{"status":"ok","printerOnline":bool}` |
| `list-printers`   | —                                         | `{"status":"ok","listPrinters":[...]}` |
| `print-number`    | `{"text":"123-47"}`                       | `{"status":"ok"}` |
| `print-barcode`   | `{"text":"ii18725308927","heightMm":10,"moduleMm":0.25}` | `{"status":"ok"}` |

При пропуске печати (пустой текст, приложение остановлено, нет принтера)
возвращается `{"status":"skipped","reason":"..."}`.
При ошибке — `{"status":"error","error":"..."}`.

### Пример «сырых» байтов

```
Запрос:  [2A 00 00 00] {"command":"ping"}
Ответ:   [1B 00 00 00] {"status":"ok","version":"3.0.0"}
```

---

## Регистрация host-приложения

### Windows — автоматически

```bat
cd src-printnum\native-host
install-native-host.bat "C:\PrintNum\printnum.exe" "<ID-расширения>"
```

`<ID-расширения>` — со страницы `chrome://extensions` (карточка PrintNum → **ID**).

Скрипт:
- создаёт `ru.printnum.host.json` рядом с `printnum.exe`;
- прописывает его в реестр для Chrome, Edge, Яндекс.Браузера и Chromium.

### Windows — вручную

1. Создайте файл `C:\PrintNum\ru.printnum.host.json`:

   ```json
   {
     "name": "ru.printnum.host",
     "description": "PrintNum native messaging host",
     "path": "C:\\PrintNum\\printnum.exe",
     "type": "stdio",
     "allowed_origins": ["chrome-extension://<ID-расширения>/"]
   }
   ```

2. Пропишите путь к манифесту в реестре (для Chrome):

   ```
   HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\ru.printnum.host
       (Default) = C:\PrintNum\ru.printnum.host.json
   ```

   Для Edge: `...\Microsoft\Edge\NativeMessagingHosts\...`,
   для Яндекс.Браузера: `...\Yandex\YandexBrowser\NativeMessagingHosts\...`.

### Firefox

Firefox использует другой механизм (файл в
`%APPDATA%\Mozilla\NativeMessagingHosts\` + `allowed_extensions` с ID аддона).
Не входит в текущую поддержку.

---

## Использование из расширения

Разрешение уже добавлено в манифест расширения (`nativeMessaging`).

```ts
import { sendNative, isNativeAvailable } from "@/utils/nativeMessaging";

if (isNativeAvailable()) {
  const r = await sendNative({
    command: "print-barcode",
    text: "ii18725308927",
    heightMm: 10,
    moduleMm: 0.25,
  });
  console.log(r); // { status: "ok" }
}
```

В popup кнопка **«Печать через PrintNum»** работает так:
1. пробует Native Messaging;
2. если host не зарегистрирован — откатывается на HTTP.

Это поведение автоматическое, настраивать ничего не нужно.

---

## Проверка и отладка

### Ручная проверка протокола (Node.js)

Без расширения и браузера можно проверить сам хост:

```js
import { spawn } from "node:child_process";
const child = spawn("./printnum", ["--native-host"]);

const msg = Buffer.from(JSON.stringify({ command: "ping" }), "utf8");
const header = Buffer.alloc(4);
header.writeUInt32LE(msg.length, 0);
child.stdin.write(Buffer.concat([header, msg]));

child.stdout.once("data", (buf) => {
  const len = buf.readUInt32LE(0);
  console.log(JSON.parse(buf.subarray(4, 4 + len).toString()));
});
```

### Логи

Приложение пишет логи в **stderr** (не мешают протоколу).
В браузере они не видны — смотрите их отдельно.

### Частые проблемы

| Симптом | Причина |
| ------- | ------- |
| `Native host has exited` | Неверный путь в `path` манифеста |
| `Access to the specified native messaging host is forbidden` | ID расширения не совпадает с `allowed_origins` |
| `Specified native messaging host not found` | Манифест не зарегистрирован в реестре |
| Печать не идёт | Приложение остановлено (`running=false`) или принтер не выбран |

После установки манифеста **перезапустите браузер**.

---

## HTTP или Native Messaging

| Критерий | HTTP (`localhost:5000`) | Native Messaging |
| -------- | ----------------------- | ---------------- |
| Открытый порт | Да | **Нет** |
| Безопасность | Порт доступен локально | Только разрешённым расширениям |
| Установка | Ничего не нужно | Регистрация в реестре |
| Проверка из curl | Да | Нет |
| Запуск приложения | Вручную (или автозапуск) | Браузер запускает сам |
| Отладка | Проще | Сложнее |

**Рекомендация:** обычным пользователям достаточно HTTP (текущий режим).
Native Messaging полезен, если нужно избежать открытого порта или
ограничить доступ.

---

См. также:

- [Инструкция по первому запуску](./first-run.md)
- [Эмуляция для тестирования](./emulation-testing.md)