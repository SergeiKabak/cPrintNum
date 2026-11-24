# PrintNum — база знаний проекта

> Единый источник правды по проекту для людей и ИИ-агентов.
> Объединяет прежний `README.md` (C-служба) и `extension/README.md` (браузерное
> расширение). Всё, что описано ниже, проверено по исходникам и по живому
> прогону службы под Wine (`./wine-ctl.sh test` → `21 passed, 0 failed`).

**Что это:** два компонента, которые работают только вместе.

1. **Сервер** — `printnum-win7.c` → `printnum-win7.exe`. Один файл, без CRT,
   HTTP-сервер на `127.0.0.1:5000`, печать этикеток через Win32 GDI + Spooler.
   Целевая ОС — **Windows 7 SP1 x64** (Win10/11 тоже работают).
2. **Клиент** — браузерное расширение Chromium (`extension/`, WXT + Preact + TS).
   Живёт на `https://turbo-pvz.ozon.ru/*`, ловит номера ячеек/полок и отправляет
   их в сервер по HTTP.

Без запущенного сервера расширение печатать не может (в popup горит
«Печать не активна»), без расширения сервер печатает только по `curl`/CLI.

```
Ozon (turbo-pvz.ozon.ru)
  ├─ XHR/fetch ответы ──► pageHook (MAIN) ─┐
  ├─ DOM приёмки ──────────────────────┐  │
  └─ кнопка «копировать» ШК ──┐        │  │
                              ▼        ▼  ▼
                    content scripts (ISOLATED) / popup
                              │  chrome.runtime.sendMessage
                              ▼
                    background.js (service worker)
                              │  fetch http://127.0.0.1:5000/...
                              ▼
   printnum-win7.exe  ── GDI/Spooler ──► принтер этикеток 43×25 мм
```

---

## Содержание

- [1. Быстрый старт](#1-быстрый-старт)
- [2. Карта репозитория](#2-карта-репозитория)
- [3. Сервер (C-служба)](#3-сервер-c-служба)
- [4. Клиент (расширение)](#4-клиент-расширение)
- [5. Связь сервер ↔ клиент](#5-связь-сервер--клиент)
- [6. Инварианты и подводные камни](#6-инварианты-и-подводные-камни)
- [7. Рецепты изменений](#7-рецепты-изменений)
- [8. Проверка и тесты](#8-проверка-и-тесты)
- [9. История, устаревшее, мёртвый код](#9-история-устаревшее-мёртвый-код)
- [10. Глоссарий](#10-глоссарий)

---

## 1. Быстрый старт

### 1.1. Пользователь (Windows 7/10/11)

1. Распаковать `dist/PrintNum-win7.zip` в любую папку, например
   `C:\PrintNum\`. В корне архива лежат **и расширение** (`manifest.json`,
   `background.js`, `content-scripts/`, `chunks/`, `assets/`, `icon/`),
   **и приложение** (`printnum-win7.exe`, `printnum-diag.exe`, `config.json`).
2. Запустить `printnum-win7.exe` — сразу служба (режим по умолчанию, флаг
   `--service` не обязателен): HTTP-сервер `127.0.0.1:5000`, без окон и
   консоли. Графического интерфейса нет. Лог: `%APPDATA%\PrintNum\log.txt`.
3. Установить расширение: Chrome Web Store **или** из того же архива —
   `chrome://extensions` → «Режим разработчика» → «Загрузить распакованное» →
   выбрать **эту же папку** (manifest.json в её корне). Перезагрузить
   открытые вкладки Ozon. В репозитории сборка расширения лежит в
   `extension/output/chrome-mv3`.
4. В popup расширения: «Настройки печати» → выбрать принтер и размер этикетки
   (по умолчанию `43*25`). Шахматка, обводка и «QR товара рядом с номером»
   включены по умолчанию — при необходимости выключаются там же.
5. В драйвере принтера **вручную задать тот же размер бумаги**, иначе этикетка
   печатается пустой/смещённой.
6. При первом запросе браузер может спросить разрешение на доступ к локальной
   сети (`localhost`/`127.0.0.1`) — разрешить.

### 1.2. Разработчик (macOS/Linux, кросс-компиляция)

```bash
# сервер
brew install mingw-w64
./build.sh                      # exe + сборка расширения + dist/*.zip
SKIP_EXTENSION=1 ./build.sh     # только exe (если нет Node.js)

# живой прогон службы под Wine
./wine-ctl.sh start             # сборка (если нужно) + запуск в фоне
./wine-ctl.sh test              # smoke-тест всех эндпоинтов (21 проверка)
./wine-ctl.sh logs | stop | reset | restart

# клиент
cd extension
npm install                     # или pnpm install
npm run dev                     # WXT: output/chrome-mv3 + браузер
npm run compile                 # tsc --noEmit (сейчас проходит без ошибок)
npm run build                   # production-сборка
npm run zip                     # output/chrome-mv3.zip
```

Порт: сервер слушает **жёстко 5000** (`DEFAULT_PORT` в C), расширение берёт
порт из `VITE_PRINTNUM_PORT` **на этапе сборки** (`.env`, по умолчанию 5000).
Если менять порт — менять в двух местах и пересобирать расширение.

---

## 2. Карта репозитория

```
cPrintNum/
├── printnum-win7.c          # ВЕСЬ сервер: HTTP, конфиг, GDI-печать, QR (~2900 строк)
├── build.sh                 # кросс-сборка exe + сборка расширения + единый zip
├── wine-ctl.sh              # запуск/остановка/логи/smoke-тест службы под Wine
├── config.json              # рабочий конфиг для сборки (копируется в dist/)
├── dist/                    # 2 exe + config.json + PrintNum-win7.zip
│                            # (единый архив: расширение + exe + config)
├── printnum-win7.exe        # артефакт сборки: служба (подсистема Windows)
├── printnum-diag.exe        # артефакт сборки (-mconsole, для Wine/диагностики)
├── demo_qr_label.bmp        # пример вывода --demo-qr (344×200, 43×25 мм @203dpi)
├── demo_cell_qr_label.bmp   # пример --demo-cell-qr: «163» (шахматка+обводка) + QR ii…
├── generate_compile_commands.py  # генератор compile_commands.json для clangd
├── compile_commands.json    # БД компиляции для clangd (пути/цели устаревшие)
├── .cache/clangd/index/     # локальный кэш clangd — не трогать, не коммитить
├── .DS_Store                # мусор macOS
├── extension/               # КЛИЕНТ: WXT-расширение (см. §4)
└── README.md                # этот файл
```

### 2.1. `extension/` — подробно

```
extension/
├── public/                  # статика → копируется в output как есть
│   └── icon/                # 16/32/48/96/128.png → manifest.icons
│                            # ВАЖНО: WXT ищет publicDir в КОРНЕ проекта
│                            # (public), а не в src/public
├── src/
│   ├── entrypoints/         # точки входа WXT (файл = артефакт, см. §4.3)
│   │   ├── background.ts            # service worker: очередь печати, инъекция pageHook
│   │   ├── sendPrintNum.content.ts  # document_start: DOM-наблюдатель + приём postMessage
│   │   ├── pageHook.unlisted.ts     # MAIN-world: перехват XHR/fetch ответов Ozon
│   │   ├── labelCopy.content.ts     # «копировать» ШК → chrome.storage
│   │   └── popup/                   # окно расширения
│   │       ├── index.html           # точка входа popup (link на ~/assets/main.css)
│   │       ├── main.tsx             # render(<App/>, #root)
│   │       ├── App.tsx              # порядок панелей: статус, настройки, автопечать, QR
│   │       ├── statusPrinting.tsx   # GET / → «Печать активна/не активна»
│   │       ├── PrintSettingsPanel.tsx # GET/POST /config, /papers, /listPrinters, /service*
│   │       ├── AutoPrintPanel.tsx   # режим автопечати в chrome.storage (autoPrint)
│   │       └── BarcodeGenerator.tsx # превью QR-этикетки + печать (HTTP / browser)
│   ├── utils/
│   │   ├── api.ts               # HTTP-клиент сервера + тип PrintSettings
│   │   ├── autoPrint.ts         # обработка события печати в background
│   │   ├── autoPrintSettings.ts # ключи storage, дефолты, нормализация, типы
│   │   ├── ozonPlacements.ts    # парсинг ответов Ozon → Placement (+ findBarcode для QR)
│   │   ├── constants.ts         # SELECTORS (3 шт.), regex ячейки/ШК, путь приёмки
│   │   ├── qrLabel.ts           # SVG-превью QR-этикетки (геометрия как в C)
│   │   ├── observer.ts          # подписка на смену URL + observe(document.body)
│   │   └── scannerSimulator.ts  # dev-эмулятор сканера (в prod вырезается)
│   ├── components/preact/button.tsx # единственный UI-компонент (кнопка)
│   ├── hooks/useStorageValue.ts # одиночное значение в chrome.storage (AutoPrintPanel)
│   ├── lib/utils.ts             # cn() = clsx + tailwind-merge
│   └── assets/main.css          # Tailwind + CSS-переменные темы (подключён в popup)
├── output/chrome-mv3/       # ГОТОВОЕ расширение (production-сборка WXT):
│                            #   manifest.json, background.js, pageHook.js,
│                            #   content-scripts/{sendPrintNum,labelCopy}.js,
│                            #   popup.html, chunks/, assets/, icon/
│                            # именно ЭТА папка грузится как unpacked extension
│                            # и именно её содержимое попадает в dist-архив;
│                            # `npm run zip` дополнительно делает output/chrome-mv3.zip
├── .wxt/                    # сгенерированные типы WXT (wxt prepare), не редактировать
├── example.html             # сохранённая страница Ozon (дамп, в .gitignore)
├── example_files/           # CSS/JS-ассеты того дампа (в .gitignore)
├── node_modules/            # зависимости
├── wxt.config.ts            # filterEntrypoints, manifest, outDir, vite (preact alias)
├── package.json             # v2.1.0, скрипты dev/build/compile/zip
├── package-lock.json        # npm (pnpm-lock.yaml удалён — один пакетный менеджер)
├── tsconfig.json            # strict, preact jsx, алиасы @ ~ @@ ~~
├── tailwind.config.js       # rem→px через postcss-rem-to-px (popup в px)
├── postcss.config.js        # tailwind + rem-to-px + autoprefixer
├── .env.example             # VITE_PRINTNUM_PORT=5000
├── .gitignore               # node_modules, output, .wxt, example.html, example_files
└── README.md                # после объединения — короткая ссылка на этот файл
```

Всего в `src/` — 23 файла; всё, что не достижимо из пяти
`INCLUDED_ENTRYPOINTS`, удалено (см. §4.14 и §9).

### 2.2. Состояние git

- Git-корень проекта — `/Users/rayan/development/PrintNum` (родительская папка).
- `cPrintNum/` закоммичен (`f0ba5e9 Move project to cPrintNum and merge docs…`);
  старые пути (`src-printnum/`, `extension/`, `docs/`, `amvera/`, `dist-*`)
  удалены из дерева, но доступны в истории.
- `.gitignore` родителя игнорирует `*.exe`, `node_modules`, `dist`, `.env`.

---

## 3. Сервер (C-служба)

### 3.1. Сборка

`build.sh` собирает два exe из одного исходника:

| Артефакт | Флаги | Назначение |
|---|---|---|
| `printnum-win7.exe` | `-mwindows` | подсистема Windows: ни окна, ни консоли; служба (GUI нет) |
| `printnum-diag.exe` | `-mconsole` | то же + консоль (удобно под Wine/для диагностики) |

Общие флаги:

```bash
x86_64-w64-mingw32-gcc -municode -Os -s -Wall -static \
  -nostdlib -e wWinMain -ffreestanding -fno-builtin \
  -ffunction-sections -Wl,--gc-sections \
  printnum-win7.c -o printnum-win7.exe \
  -lgcc -lkernel32 -luser32 -lgdi32 -lwinspool -lws2_32 -lshell32
```

`build.sh` после сборки проверяет отсутствие `api-ms-win-crt*` в импортах,
собирает расширение и пакует **один** архив `dist/PrintNum-win7.zip`:

```
PrintNum-win7.zip
├── manifest.json          ← расширение в корне архива
├── background.js
├── content-scripts/
├── chunks/  assets/  icon/
├── printnum-win7.exe      ← приложение рядом
├── printnum-diag.exe
└── config.json
```

Почему так: распаковал один раз — запускаешь exe и **эту же папку** грузишь
как unpacked extension (`chrome://extensions` → «Загрузить распакованное»).
Отдельного zip-а расширения больше нет (`PrintNum-extension-chrome.zip`
удаляется из `dist/`, если остался от прошлых сборок).

> `extension/output/chrome-mv3` — это и есть **папка готового расширения**
> (production-сборка WXT). Её содержимое `build.sh` кладёт в корень архива.
> Для Chrome Web Store нужен архив **без** `.exe`: `cd extension && npm run zip`
> → `extension/output/printnum-<версия>-chrome.zip` (manifest в корне).
>
> ⚠️ `npm run dev` пишет в ту же папку **dev**-сборку (с эмулятором сканера).
> `./build.sh` пересобирает production, но если запускали только `npm run dev`,
> в архив попадёт dev-версия — перед релизом делайте `npm run build`.

Порядок в `build.sh`: exe → расширение → упаковка.

- Расширение собирается через `npm run build` (WXT), если есть
  `extension/node_modules` и `npm`. Если npm нет — используется готовая
  сборка `extension/output/chrome-mv3` (с предупреждением).
- Совсем без сборки расширения скрипт падает с подсказкой, чтобы релизный
  архив не остался без расширения. Собрать только exe:
  `SKIP_EXTENSION=1 ./build.sh` (архив будет без файлов расширения).
- Версия расширения в логе берётся из `output/chrome-mv3/manifest.json`.
- `.DS_Store`/`__MACOSX` в архивы не попадают.

**Не использовать `-fdata-sections`**: множество static-буферов в отдельных
секциях раздувает PE из-за выравнивания.

### 3.2. Почему без CRT и что это значит для правок

`-nostdlib -e wWinMain` → нельзя вызывать `malloc/free`, `printf`, `strlen`,
`swprintf`, `qsort` и т.п. В конце файла определены `strlen`, `strcmp`,
`memcpy`, `memset` (псевдонимы `my_*`). Свои утилиты wide-строк:
`slen/scpy/scat/seq/sascii/sstr/stoi/itos`, память — `HeapAlloc/HeapFree`,
форматирование — `wsprintfW/wsprintfA` из user32.

### 3.3. Карта файла `printnum-win7.c`

| Строки | Секция |
|---|---|
| 1–44 | шапка: контракт API, пути, команда сборки; `DEFAULT_PORT 5000`, `MAX_PAPERS 16`, `JSON_MAX 8192`, `BODY_MAX 4096` |
| 45–132 | мини-утилиты wide-строк, UTF-8↔UTF-16, JSON-escape |
| 133–454 | `Config`, дефолты, `%APPDATA%\PrintNum`, лог, мини-JSON (чтение/запись), `cfg_load/save`, `cfg_to_api_json` (+`features`) |
| 455–513 | принтеры: `list_printers` (EnumPrinters L4), `status_printer` (GetPrinter L2 + флаги) |
| 514–590 | автозагрузка: `Startup\PrintNum.cmd`, `spawn_detached_service` (`--service`, `CREATE_NO_WINDOW`) |
| 591–704 | бизнес-логика этикетки: `prepare_label_data` (полка, hybrid/expand, header, точка/подчёркивание) |
| 705–1023 | GDI: шрифты, `calc_sizes`, `draw_header`, `draw_main_text`, `apply_checker_with_outline`, `draw_label`, `print_text` |
| 1024–1408 | HTTP: `send_response` (CORS), `read_request`, `handle_request`, `run_server` |
| 1409–2282 | порт QR-энкодера ricmoo/QRCode (версии 1–40, все ECC) |
| 2283–2603 | комбинированная QR-этикетка: `pn_qr_encode`, `draw_qr`, `draw_qr_label_core`, `print_qr_label` |
| 2604–2746 | демо-рендер в BMP: `demo_render_bmp` (`--demo-file`), `demo_qr_label_render` (`--demo-qr`) |
| 2747–2859 | `wWinMain`: разбор argv, `PRINTNUM_DRY_RUN`, выбор режима |
| 2860–2894 | мини-CRT (`strlen/strcmp/memcpy/memset`) |

### 3.4. Зависимости (только системные DLL Win7 SP1)

| DLL | Что используется |
|---|---|
| `KERNEL32` | файлы/каталоги/процессы/память/время, `MultiByteToWideChar`/`WideCharToMultiByte`, `GetCommandLineW`, `LocalFree` |
| `USER32` | `wsprintfW` / `wsprintfA` (замена CRT-форматирования) |
| `GDI32` | `CreateFontW`, `GetTextExtentPoint32W`, `TextOutW`, DC/bitmap, `GetDIBits`/`SetDIBits`, `PatBlt`/`BitBlt`, `CreateDCW`, `StartDocW/StartPage/EndPage/EndDoc`, `GetDeviceCaps` |
| `WINSPOOL.DRV` | `OpenPrinterW`, `GetPrinterW`, `EnumPrintersW`, печать через драйвер |
| `WS2_32` | Winsock 2.2: `socket/bind/listen/accept/recv/send`, `setsockopt(SO_REUSEADDR)` |
| `SHELL32` | `CommandLineToArgvW` (разбор `--print`, `--demo-*`) |

`api-ms-win-crt-*` отсутствуют — принципиальное требование (чистая Win7).

### 3.5. Конфиг

Файл: `%APPDATA%\PrintNum\config.json` (UTF-8). Каталог создаётся при старте.
Совместим по полям с прежними Rust/Python-версиями.

| Ключ | Тип | Дефолт в коде | Смысл |
|---|---|---|---|
| `printer` | string | `""` | имя принтера Windows; пусто → печать невозможна (503 `no printer`) |
| `paper` | string | `"43*25"` | размер этикетки в мм, формат `Ш*В` |
| `idNum` | bool | `false` | показывать «хвост» после дефиса (`163-1` → мелкое `-1`) |
| `endLine` | bool | `false` | `true` — подчёркивание; `false` — точка в конце |
| `hybrid` | bool | `false` | гибридный формат: номер ≥ `expand` → крупно вторая часть |
| `expand` | number | `500` | порог для `hybrid` (минимум 1) |
| `running` | bool | `true` | глобальный выключатель печати |
| `papers` | string[] | 8 значений | список размеров для `GET /papers` (до 16, имя ≤31 символа) |
| `checker` | bool | **`true`** | шахматная заливка цифры (экономия термоголовки) |
| `checkerMm` | number | `10` | клетка шахматки в 0.1 мм (10 = 1.0 мм, минимум 1) |
| `outline` | bool | `true` | сплошная обводка по контуру глифа (работает вместе с `checker`) |
| `outlineMm` | number | `5` | толщина обводки в 0.1 мм (5 = 0.5 мм, минимум 1) |
| `qrWithNumber` | bool | **`true`** | печатать QR товара рядом с номером ячейки (без точки) |
| `printerMode` | string | `"gdi"` | `"gdi"` — печать через драйвер Windows; `"escpos"` — raw ESC/POS без настроек драйвера |
| `labelGapMm` | number (0.1 мм) | `20` | зазор между этикетками (die-cut), 20 = 2 мм; только `escpos` |
| `rawXOffsetMm` | number (0.1 мм) | `0` | сдвиг картинки вправо внутри ленты; только `escpos` |
| `rawTransport` | string | `"spooler"` | `"spooler"` (USB/LAN/BT через спулер, `pDatatype:RAW`) или `"tcp"` |
| `rawHost` | string | `""` | IP принтера для `rawTransport:"tcp"` |
| `rawPort` | number | `9100` | TCP-порт raw-печати |
| `rawInitHex` | string | `""` | hex-байты после `ESC @` (сервисные команды модели, напр. калибровка) |

Дефолтный список `papers`: `43*25, 30*20, 40*30, 50*70, 58*40, 60*40, 75*120, 100*150`.

Важно:

- В репозитории `config.json` и `dist/config.json` содержат `checker: true`
  (переопределяет дефолт кода `false`) — это просто рабочий конфиг сборки.
- `features` в файл **не пишется**: `cfg_to_json()` (диск) и
  `cfg_to_api_json()` (API) — разные функции.
- Mini-JSON не полноценный: `json_key` ищет `"key"` и пропускает `:`, пробелы;
  числа читаются только с цифры (в кавычках тоже), отрицательные не
  поддерживаются; вложенность кроме `papers` не разбирается.
- Неизвестные ключи и значения неверного типа **игнорируются** (старое
  расширение не ломает новый сервер и наоборот).
- `papers: []` игнорируется (иначе не осталось бы вариантов выбора).
- **Дефолты применяются только к новому конфигу.** Уже сохранённый
  `%APPDATA%\PrintNum\config.json` имеет приоритет: если в нём
  `checker:false`, после обновления экзешника шахматка не включится сама.
  Варианты: переключить в popup или удалить `config.json` (создастся заново
  с дефолтами: `checker/outline/qrWithNumber = true`).

### 3.6. Логи и файлы

| Путь | Что |
|---|---|
| `%APPDATA%\PrintNum\config.json` | настройки |
| `%APPDATA%\PrintNum\log.txt` | лог (UTF-8, append): запуск, ошибки печати, bind, конфиг |
| `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PrintNum.cmd` | автозагрузка (создаётся `/service/install`) |

`PrintNum.cmd` содержит:

```bat
@echo off
start "" /min "<путь к exe>" --service
```

### 3.7. API-контракт (полный, проверен на живой службе)

Базовый URL: `http://127.0.0.1:5000`. Порт **не настраивается** в этой версии.
Сервер однопоточный, одно соединение = один запрос (`Connection: close`).

Каждый ответ содержит CORS-заголовки:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

| Метод | Путь | Тело запроса | Успех | Ошибки |
|---|---|---|---|---|
| GET | `/` | — | `200` `{"status": true}` | — |
| GET | `/status-printer` | — | `200` `{"printerOnline": true\|false}` | — |
| GET | `/listPrinters` | — | `200` `{"listPrinters":["..."]}` (до 8) | — |
| GET | `/papers` | — | `200` `{"papers":["43*25",...]}` | — |
| GET | `/config` | — | `200` полный конфиг + `"features":["shelf-dash","qr-number"]` | — |
| GET | `/service` | — | `200` `{"installed": true\|false}` | — |
| POST | `/config` | частичный JSON-объект | `200` полный конфиг + `features` | `400` `{"error": "ожидается JSON-объект"}` |
| POST | `/print-number` | `{"text":"163-1", "qr":"ii19382868529"}` (`qr` необязателен) | `200` `OK` (text/plain) | `400` `no text` / `not a cell number` / `empty` / `non-ascii qr`; `503` `stopped` / `no printer` / `printer offline`; `500` `print failed` |
| POST | `/print-barcode` | `{"text":"ii19382868529"}` | `200` `OK` | `400` `no text` / `non-ascii`; `503` как выше; `500` `print failed` |
| POST | `/service/install` | `{}` (тело не читается) | `200` `{"ok": true, "path": "..."}` | `500` `{"error":"ошибка установки"}` |
| POST | `/service/uninstall` | `{}` | `200` `{"ok": true}` | `500` `{"error":"ошибка удаления"}` |
| OPTIONS | любой | — | `204`, пустое тело | — |
| * | неизвестный путь | — | — | `404` `{"error": "not found"}` |

Особенности реализации, о которых нужно знать:

- Метод определяется по префиксу: `POST…` → POST, `OPTIONS…` → OPTIONS,
  **всё остальное считается GET** (поэтому `PUT /config` даст `404`).
- `Content-Type` не проверяется; тело читается после `\r\n\r\n` целиком.
- Query-строка отбрасывается: `GET /config?x=1` работает как `GET /config`.
- Лимиты: тело ≤ `BODY_MAX` (4096 wide-символов), буфер запроса 8192 байта,
  JSON-документ ≤ 8192, путь ≤ 255, `papers` ≤ 16.
- Авторизации нет: любой локальный процесс может менять конфиг и печатать.
  Сервер слушает только loopback (`INADDR_LOOPBACK`), backlog 8.
- `POST /config` применяет только валидные ключи, затем **сразу пишет файл**
  и возвращает полный конфиг (источник правды для UI).
- `POST /print-barcode` игнорирует поля `moduleMm`/`heightMm` (наследие
  Code128-контракта) — геометрия считается автоматически.

Примеры:

```bash
curl -s http://127.0.0.1:5000/
# {"status": true}

curl -s -X POST http://127.0.0.1:5000/config \
  -H 'Content-Type: application/json' -d '{"printer":"Zebra ZD230","hybrid":true}'
# полный конфиг + features

curl -s -X POST http://127.0.0.1:5000/print-number \
  -H 'Content-Type: application/json' -d '{"text":"163-1"}'
# OK

curl -s -X POST http://127.0.0.1:5000/print-number \
  -H 'Content-Type: application/json' -d '{"text":"-88"}'
# OK  (полка; при running=false или без принтера → 503)
```

### 3.8. Валидация `/print-number`

Порядок проверок (до санитизации) — аналог `is_printable` из Rust:

1. нет `text` → `400 no text`;
2. допустимы только `0-9`, `-`, пробел, и хотя бы одна цифра → иначе
   `400 not a cell number` (сюда попадают `Возврат-1`, `Прямой поток - 5`,
   `ii18725308927`, `---`);
3. санитизация: остаются только цифры и `-` (пробелы **удаляются**);
   пусто → `400 empty`;
   необязательный `qr` (штрихкод товара) проверяется на ASCII 32..127 →
   иначе `400 non-ascii qr`; пустой `qr` = печатать как обычно;
4. `running == false` → `503 stopped`;
5. `printer == ""` → `503 no printer`;
6. принтер offline/error/paper jam/paper out → `503 printer offline`;
7. печать → `200 OK` или `500 print failed`.

Следствия:

- `"163 1"` превратится в `"1631"` (пробел выброшен) — на этикетке будет `1631.`
- Полка кодируется ведущим дефисом: `-88` → этикетка `-88.` (или `-88`
  подчёркнутым при `endLine:true`). Отдельного эндпоинта для полок нет.
- Кириллица в `/print-number` невозможна, поэтому ветка `is_kgt()` в
  `prepare_label_data()` в этой сборке **недостижима** (КГТ печатался только
  старой Rust-версией). Не «исправлять» это, не изменив сначала валидацию.

### 3.9. Логика этикетки (`prepare_label_data`)

| Вход | `idNum`/`hybrid` | Результат |
|---|---|---|
| `163-1` | `idNum:false` | крупно `163.` |
| `163-1` | `idNum:true` | крупно `163.`, мелко `-1` справа сверху |
| `163-1` | `hybrid:true, expand:500` | крупно `163.`, мелко `-1` (163 < 500) |
| `600-1` | `hybrid:true, expand:500` | мелко `600-` слева сверху, крупно `1.` (рокировка) |
| `163-1` | `endLine:true` | крупно `163` с подчёркиванием |
| `-88` | любое | одной строкой `-88.` / `-88` (без разбиения по дефису) |
| `163` | `hybrid:*` | `163.` (нет дефиса → нет header) |

Алгоритм: разбить по **первому** дефису; `hybrid && все цифры && значение ≥
expand` → bold + рокировка (число в `main`, префикс в `header`, header слева,
дефис приклеен к header); иначе `main` = левая часть, `header` = правая
(показывается только при `idNum`, дефис перед ней); в конце — `endLine`
(подчёркивание) либо точка.

### 3.10. Рендер (`draw_label` / `draw_main_text`)

- Поля: 5% ширины/высоты с каждой стороны (`margin_x`, `margin_y`).
- Колонтитул: шрифт = 20% высоты этикетки, Arial, обычный; сверху справа
  (или слева при рокировке).
- Основной текст: подбор кегля **линейной экстраполяцией** от реперного
  размера 100 px (`by_w`, `by_h`), затем цикл уменьшения до вписывания,
  минимум 6 px; шрифт Arial, `FW_BOLD` при bold, `underline` при endLine.
  Это 2–3 GDI-вызова вместо ~50 шагов «+1 px» — важно для старого железа.
- `checker:true` + `outline:true` (`apply_checker_with_outline`):
  1. вся этикетка рисуется в memory-DC;
  2. читаются пиксели (`GetDIBits`, 24-bit top-down);
  3. чёрные пиксели, у которых в радиусе `outlineMm` есть белый/край,
     остаются сплошными (контур);
  4. внутренние заливаются «шахматкой» с клеткой `checkerMm` (гасится каждая
     вторая клетка), результат возвращается `BitBlt`.
  Контур точно повторяет глиф, включая низ `4`, и не выходит за границы.
- `checker:true` + `outline:false`: `checker_fill()` гасит **каждую вторую**
  клетку сетки по прямоугольнику текста (паритет — по абсолютным координатам
  DC, как и внутри обводки).
  > Раньше здесь заливались *все* клетки — `checker:true` без обводки печатал
  > пустую этикетку (цифры стирались). Исправлено в `checker_fill()`, общая
  > функция для обычной этикетки, демо и режима «номер + QR».
- В режиме «номер + QR» (`qrWithNumber`) текст рисуется в отдельный
  memory-DC шириной под номер, шахматка/обводка применяются там и результат
  переносится `BitBlt` — поэтому **оба эффекта работают вместе с QR** и не
  затирают код (раньше chessboard в этом режиме отключался).
- `PRINTNUM_DRY_RUN` на HTTP-печать **не влияет** — только на CLI `--print`.

### 3.11. Комбинированная QR-этикетка (`/print-barcode`)

Макет:

```
    [QR]    ii1938286    [QR]
              8529
```

- QR кодирует **всё** значение; Byte mode; **ECC Medium (~15%)**;
  версия — автоматически минимальная под длину (поддержаны 1–10,
  `PNQR_MAX_VERSION 10`); тихая зона 4 модуля.
- Два одинаковых QR: слева и справа.
- Текст по центру: последние 4 символа — **жирным на новой строке**,
  остальное — обычным.
- Геометрия: поля 0.5 мм, зазор 0.125 мм, текст 4 мм / суффикс 6 мм,
  минимум места под текст 88 px, модуль QR — авто (максимально крупный),
  зазор между QR и текстом = 2 модуля + gap, межстрочный зазор 2 px.
- Размер этикетки берётся из `paper` (`calc_sizes`), DPI — из драйвера.
- Допустимы только ASCII 32..127 → иначе `400 non-ascii`.
- Кодировщик — порт [ricmoo/QRCode](https://github.com/ricmoo/QRCode)
  (MIT, Richard Moore / Project Nayuki), адаптирован под no-CRT
  (`pnqr_*`, статические таблицы, свой `pnqr_memset/memcpy/strlen`).
  Матрица проверена побитово против оригинала.

### 3.12. Этикетка «номер + QR товара» (`qrWithNumber`)

Управляется флагом `qrWithNumber` (popup → «QR товара рядом с номером»),
**по умолчанию включён**. Печатается, только если в запросе есть `qr`
(штрихкод товара из ответа Ozon); если `qr` нет — обычная этикетка.

Раскладка (`draw_number_qr_core`):

```
┌─────────────────────────────┐
│                             │
│   163            ▓▓▓▓▓▓     │   номер слева (авто-кегль),
│                  ▓▓▓▓▓▓     │   QR справа (ECC Medium, авто-версия),
│                  ▓▓▓▓▓▓     │   точка в конце НЕ рисуется
└─────────────────────────────┘
```

- QR кодирует штрихкод товара целиком (`ii…`), тихая зона 4 модуля,
  квадрат ≤48% ширины и ≤ доступной высоты, модуль — авто (целое число px).
- Номер занимает область слева (зазор ~2 мм), кегль подбирается тем же
  `draw_main_text`, что и в обычной этикетке; `endLine` (подчёркивание)
  работает, точка — нет.
- `checker`/`outline` **работают и здесь**: текст рендерится в отдельный
  memory-DC под номер, там заливается шахматкой/обводится и переносится
  на этикетку — QR остаётся целым.
- В лог пишется, что именно напечатано:
  `Печать с QR выполнена: 163-1 / ii19382868529 [checker+outline]`
  (обычная — `Печать выполнена: 163-1 [checker]`).
  Если в запросе был `qr`, а флаг выключен:
  `QR не напечатан: qrWithNumber выключен (ii…)`.
- Проверить без принтера:

```bash
wine printnum-diag.exe --demo-cell-qr "163-1" "ii19382868529" label.bmp
wine printnum-diag.exe --demo-cell-qr "-88"   "ii8923223139"  shelf.bmp
sips -s format png label.bmp --out label.png && zbarimg -q --raw label.png
```

### 3.13. RAW-печать ESC/POS (`printerMode: "escpos"`)

Зачем: при печати через GDI размер «холста» задаёт драйвер Windows — в нём
нужно один раз выставить размер этикетки, иначе будет пусто/смещено.
В raw-режиме приложение **само** формирует поток команд и отдаёт его спулеру
с `pDatatype = "RAW"` (драйвер — просто труба) или шлёт в TCP `:9100`.
Ни драйверных настроек бумаги, ни статуса спулера не требуется.

Поток (80-мм ESC/POS-принтеры, 203 dpi, 576 точек печатной ширины):

```
ESC @                       сброс
[rawInitHex]                необязательные байты (калибровка/режим модели)
GS v 0 0 xL xH yL yH data   растр: bytes_per_row = ceil((offset+width)/8)
ESC J n (×N)                протяжка на зазор (labelGapMm)
```

- Картинка рисуется тем же кодом, что и GDI-печать: номер + QR + шахматка
  (`render_text_label` / `draw_number_qr_core`), `--print-barcode` —
  `draw_qr_label_core`.
- Размер этикетки — из `paper` (`Ш*В`), конвертация мм → точки по 203 dpi.
- `rawXOffsetMm` — сдвиг вправо (если этикетка на ленте не с краю).
- `labelGapMm` — протяжка после растра (die-cut зазор).
- `rawTransport: "spooler"` — `OpenPrinter` + `StartDocPrinter(DOC_INFO_1{
  pDatatype:"RAW"})` + `WritePrinter`; работает для USB/LAN/Bluetooth, если
  принтер установлен в Windows. `"tcp"` — прямой `connect` на `rawHost:rawPort`
  (нужен IP, не имя).
- В лог: `RAW ESC/POS: <N> байт отправлено: 163-1 / ii…`.
- Проверка без бумаги: `--raw-dump` / `--raw-dump-barcode` (см. §3.14).

> ⚠️ Die-cut лента без датчика зазора: printer сам зазор не ищет — позиция
> держится на точности протяжки. Если накапливается сдвиг, один раз
> откалибруйте принтер (кнопка/утилита производителя) и при необходимости
> доложите сервисные байты в `rawInitHex`, а протяжку подстройте `labelGapMm`.

### 3.14. CLI, демо-режимы, служба

| Команда | Поведение |
|---|---|
| `printnum-win7.exe` (без аргументов) | служба: HTTP-сервер, без окон — **режим по умолчанию** |
| `printnum-win7.exe --service` | то же явно (флаг для автозагрузки/`CreateProcess`); в лог пишется `Режим: служба (--service)` |
| `printnum-win7.exe --print "163-1"` | разовая печать; та же валидация; код выхода 0/1 |
| `set PRINTNUM_DRY_RUN=1` + `--print` | ничего не печатает, сразу `return 0` |
| `printnum-diag.exe --demo-file "45" label.bmp` | рендер обычной этикетки в BMP (344×200, 43×25 мм @203 dpi), без принтера |
| `printnum-diag.exe --demo-file "-88" shelf.bmp` | то же для полки |
| `printnum-diag.exe --demo-qr "ii19382868529" label.bmp` | рендер QR-этикетки в BMP |
| `printnum-diag.exe --demo-cell-qr "163-1" "ii19382868529" out.bmp` | рендер этикетки «номер + QR товара» в BMP |
| `printnum-diag.exe --raw-dump "163-1" "ii19382868529" label.bin` | готовый ESC/POS-поток в файл (`-` вместо ШК = без QR) |
| `printnum-diag.exe --raw-dump-barcode "ii19382868529" bc.bin` | ESC/POS-поток комбинированной QR-этикетки |

Демо использует **те же** GDI-функции, что и печать (`prepare_label_data`,
`draw_label`, `draw_qr_label_core`), поэтому это честный предпросмотр.
Формат BMP — 8-bit grayscale, top-down, единственный поддерживаемый.

Служба: `run_server()` блокирующий, `accept` в бесконечном цикле; ошибки
bind/listen/WSAStartup пишутся в лог и завершают процесс. `SO_REUSEADDR`
включён, чтобы перезапуск был мгновенным.

### 3.15. Ограничения сервера (важно для планирования правок)

| Ограничение | Следствие |
|---|---|
| Порт жёстко `DEFAULT_PORT 5000` | `PRINTNUM_PORT`/`.env` **не работают** (в отличие от старой Rust-версии) |
| Однопоточный `accept`-цикл | запросы строго последовательны; расширение сериализует печать (`printChain`) |
| Нет keep-alive | 1 запрос = 1 TCP-соединение |
| `BODY_MAX 4096` / `JSON_MAX 8192` | большие тела/конфиги обрезаются |
| Список принтеров ≤ 8, буфер 4096 | на машинах с десятками принтеров список усечён |
| Нет dry-run для HTTP | эмуляция печати возможна только через `--demo-*` |
| Нет native messaging | клиент работает только по HTTP (см. §4.13); `--native-host` не реализован |
| Нет очистки очереди спулера | `SetPrinter(PURGE)` не вызывается (нужны права ADMINISTER) |
| Нет аутентификации | доверять только loopback-периметру |

---

## 4. Клиент (расширение)

### 4.1. Стек и версии

`package.json` → `name: printnum`, `version: 2.1.0`, `type: module`.

| Компонент | Технология |
|---|---|
| Каркас | WXT 0.21 |
| UI | Preact 10 (+ `preact/compat` алиасы на `react`/`react-dom`) |
| Язык | TypeScript 5 (`npm run compile` = `tsc --noEmit`, проходит) |
| Стили | Tailwind 3 + `@thedutchcoder/postcss-rem-to-px` (в popup всё в px) |
| Иконки | lucide-preact |
| QR | qrcode-generator (typeNumber 0 = авто, ECC `M`, Byte) |
| Сборщик | Vite (внутри WXT), target es2022 |

Скрипты: `dev`, `dev:firefox`, `build`, `build:firefox`, `zip`,
`zip:firefox`, `compile`, `postinstall: wxt prepare`.

### 4.2. `wxt.config.ts`

- `filterEntrypoints` — **белый список** того, что попадает в сборку:
  `background`, `popup`, `sendPrintNum`, `labelCopy`, `pageHook`.
  Файлы вне списка остаются в `src/`, но не собираются и не регистрируются.
- `manifest.permissions`: `storage`, `scripting` (только то, что реально
  используется; `nativeMessaging` удалён — см. §4.13).
- `host_permissions`: `http://localhost/*`, `http://127.0.0.1/*`,
  `https://turbo-pvz.ozon.ru/*` (последнее — для `scripting.executeScript`
  в MAIN-мир).
- `srcDir: src`, `outDir: output` → `output/chrome-mv3`.
- `vite`: JSX automatic + `preact`, `target: es2022`,
  `modulePreload.polyfill: false` (CSP MV3 запрещает inline-скрипты),
  алиасы `react → preact/compat`.

### 4.3. Что реально попадает в сборку

Из `output/chrome-mv3/manifest.json` (проверено):

| Артефакт | Источник | Регистрация |
|---|---|---|
| `background.js` | `entrypoints/background.ts` | `background.service_worker` |
| `content-scripts/sendPrintNum.js` | `entrypoints/sendPrintNum.content.ts` | `content_scripts`, `document_start` |
| `content-scripts/labelCopy.js` | `entrypoints/labelCopy.content.ts` | `content_scripts` (idle) |
| `pageHook.js` | `entrypoints/pageHook.unlisted.ts` | **не** в manifest; инъекция из background |
| `popup.html` + `chunks/*` + `assets/*` | `entrypoints/popup/*` | `action.default_popup` |
| `icon/*.png` | `public/icon/*.png` | `manifest.icons` (автоподхват WXT) |

Других entrypoint'ов нет: всё, что не достижимо из `filterEntrypoints` и
`App.tsx`, удалено (см. §4.14, §9). `publicDir` у WXT — **корень проекта**
(`public/`), поэтому `src/public/` раньше не копировалась вообще.

### 4.4. Потоки данных

**A. Автопечать по ответам Ozon (рекомендуемый режим `xhr`)**

```
Ozon XHR/fetch (2xx)
  → pageHook.js (MAIN world): isInterestingUrl → parsePlacement
  → window.postMessage({source:"PrintNum", type:"PLACEMENT", payload})
  → sendPrintNum.content.ts (ISOLATED): проверка event.source/origin, normalizePlacement
  → chrome.runtime.sendMessage({action:"printAuto", payload})
  → background.ts: printChain → handleAutoPrint
      → настройки из chrome.storage (autoPrint)
      → проверка режима/полок/упаковки и дедупликации
      → GET /config (кэш features 30 с) — только для полок
      → POST /print-number {text, qr?}   # qr — ШК товара из того же ответа
      → запись lastAutoPrintEvent / lastAutoPrint
```

**B. DOM-режим (как раньше)**

```
страница /receiving-v2/main
  → MutationObserver(document.body)
  → SELECTORS.numprint = 'div[class^="_list_"] div[class^="_shelfTag_"]'
  → тексты фильтруются CELL_PRINTABLE_RE, первые 10
  → первый запуск = только запоминание; далее при изменении списка
    печатается первый текст (origin "dom", dedupe "none")
  → тот же sendMessage → background → POST /print-number
```

**C. Ручная QR-этикетка / настройки (popup)**

```
popup BarcodeGenerator → buildQrLabelSvg (локально, canvas-измерение)
  → «Печать через PrintNum»: HTTP POST /print-barcode
  → «Печать из браузера»: новый window с тем же SVG + window.print()
popup PrintSettingsPanel → GET /config,/papers,/listPrinters,/service
  → POST /config (частичный патч) / POST /service/install|uninstall
```

**D. Подхват штрихкода**

```
клик по кнопке «копировать» на Ozon
  → labelCopy.content.ts (capture): button → [class*="_copyButton_"] → textarea[class*="_textarea_"]
  → LABEL_BARCODE_RE ^ii\d{9,14}$ → chrome.storage.local["lastCopiedLabel"]
  → BarcodeGenerator читает при открытии + слушает storage.onChanged
```

### 4.5. HTTP-клиент (`src/utils/api.ts`)

```ts
const PORT = import.meta.env.VITE_PRINTNUM_PORT || "5000";
const API_BASE = `http://127.0.0.1:${PORT}`;
```

| Функция | Запрос | Возврат |
|---|---|---|
| `sendServer.get(domain?, endpoint?)` | `GET ${domain}/${endpoint}` | `Response` |
| `sendServer.post(endpoint, body)` | `POST ${API_BASE}/${endpoint}` с JSON | `Response` |
| `getSettings()` | `GET /config` | `PrintSettings \| null` (null при любой ошибке) |
| `saveSettings(patch)` | `POST /config` | `{ok:true, settings}` \| `{ok:false, error}` |
| `getPapers()` | `GET /papers` | `string[]` ([] при ошибке) |
| `getPrinters()` | `GET /listPrinters` | `string[]` |
| `getServiceStatus()` | `GET /service` | `boolean` |
| `installService()` | `POST /service/install` | `{ok, error?}` |
| `uninstallService()` | `POST /service/uninstall` | `{ok, error?}` |

`PrintSettings`: `printer`, `paper`, `idNum`, `endLine`, `hybrid`, `expand`,
`running`, `qrWithNumber`, `checker`, `checkerMm`, `outline`, `outlineMm`,
`printerMode`, `labelGapMm`, `rawXOffsetMm`, `rawTransport`, `rawHost`,
`rawPort`, `papers`, `features?` — имена совпадают с `config.json`.
Все функции «мягко» глотают сетевые ошибки: popup показывает
«Приложение PrintNum не запущено» вместо исключения.

### 4.6. Ключи `chrome.storage.local`

| Ключ | Пишет | Читает | Формат |
|---|---|---|---|
| `autoPrint` | background (`onInstalled`), AutoPrintPanel | sendPrintNum, background | `{mode, shelf, packing, dedupeMs, overlapGuardMs}` |
| `lastAutoPrint` | background | background (дедуп) | `{text, kind, at}` |
| `lastAutoPrintEvent` | background | AutoPrintPanel | `{text, kind, ok, status, error?, at}` |
| `lastCopiedLabel` | labelCopy | BarcodeGenerator | `string` (`ii…`) |

`autoPrint` дефолт (`DEFAULT_AUTO_PRINT`): `mode:"dom"`, `shelf:true`,
`packing:true`, `dedupeMs:5000`, `overlapGuardMs:1000`.
`onInstalled`: если ключа нет — новая установка получает `mode:"xhr"`,
обновление — `mode:"dom"`; если пользователь уже менял — не трогается.

### 4.7. Автопечать: правила фильтрации

`isAllowed(placement, settings)`:

| Условие | Результат |
|---|---|
| `mode === "off"` | не печатать |
| `placement.kind === "shelf"` и `!settings.shelf` | не печатать |
| `placement.endpoint === "transferPacking"` и `!settings.packing` | не печатать |
| `origin === "dom"` и `mode === "xhr"` | не печатать |
| `origin === "xhr"` и `mode === "dom"` | не печатать |

`isDuplicate()`:

- `Movement/put/v2` (ячейка, `dedupe:"consecutive"`): тот же `text`+`kind`
  в пределах `dedupeMs` — подавить;
- режим `both`: тот же `text` в пределах `overlapGuardMs` — подавить
  (DOM и XHR сообщают об одном размещении).

Печать **не ретраится** (повтор может напечатать лишнюю этикетку).
Полка перед печатью требует `features` c `shelf-dash`; если сервер старый —
событие с ошибкой «Обновите PrintNum: поддержка полок (-88) не найдена»,
ячейки продолжают печататься.

`background` дополнительно держит `printChain` (promise-цепочку), чтобы
этикетки уходили в порядке событий — сервер однопоточный.

### 4.8. `pageHook` (MAIN world)

- Зачем MAIN: перехват «нативных» `XMLHttpRequest`/`fetch` страницы нужен в её
  мире. Manifest-ключ `content_scripts[].world: "MAIN"` работает только с
  Chrome 111, а на Windows 7 максимум Chrome 109 → инъекция
  `chrome.scripting.executeScript({world:"MAIN", files:["pageHook.js"]})`
  (Chrome 95+).
- Инъекцию инициирует `sendPrintNum` сообщением `injectPageHook` (с backoff
  250·2ⁿ мс, до 5 попыток — service worker может ещё просыпаться).
- Guard от повторной инъекции: `window.__printNumHookV1`.
- Перехват: `XMLHttpRequest.prototype.open/send` (слушатель `load`,
  только 2xx, `responseURL`), `window.fetch` (клон ответа, `json()`).
- Фильтр URL — `isInterestingUrl()` по трём подстрокам; парсинг —
  `parsePlacement()`. Ошибки разбора глушатся, чтобы не ломать страницу.
- Dev: `window.PrintNumHook = {emit, parsePlacement, isInterestingUrl}`,
  лог `[PrintNum:hook] перехват установлен`.

Перехватываемые ответы (`src/utils/ozonPlacements.ts`):

| Эндпоинт Ozon (подстрока) | Поле | Результат |
|---|---|---|
| `/api2/address-storage/Movement/put/v2` | `articlePositions[0].address` | ячейка `163-1` |
| `…/MicroFFTransferApi/TransferByBarcodeArticle` | `transferSuccess.cell` | полка `-88` |
| `…/MicroFFTransferApi/TransferPackingArticle` | `success.cell` | полка `-57` (переупаковка) |

Дополнительно из **того же** ответа извлекается штрихкод товара
(`findBarcode`): обход JSON в глубину (≤6, ≤400 узлов) и первое совпадение
с `^ii\d{9,14}$`. Он попадает в `Placement.qr` и уходит в
`POST /print-number` — сервер печатает его как QR рядом с номером
(если включён `qrWithNumber`). Если ШК в ответе нет — печатается обычная
этикетка. В DOM-режиме `qr` нет (в разметке страницы ШК не берём).

`"Ozon Полка-88"` → `-88` (`shelfToCode`, поддерживает `Полка 88`,
`Полка—88` и т.п.). Тип (`cell`/`shelf`) определяется **по тексту**, а не по
сообщению страницы.

### 4.9. `sendPrintNum.content.ts`

- `runAt: "document_start"` — чтобы bridge был готов до первых XHR.
- `matches: https://turbo-pvz.ozon.ru/*`.
- Валидирует `postMessage`: `event.source === window`,
  `event.origin === location.origin`, `data.source === "PrintNum"`,
  `data.type === "PLACEMENT"`, затем `normalizePlacement`.
- Держит копию настроек `autoPrint` и слушает `storage.onChanged`.
- DOM-наблюдатель включается только на `workPathNames.recommendation`
  (`/receiving-v2/main`), при `mode` `xhr`/`off` не работает.
- При устаревшем контексте расширения (`!chrome.runtime.id`) молча выходит.
- Регистрирует эмулятор сканера (dev) и на `onSimulatedScan` отправляет номер
  в ту же цепочку (`origin:"scanner"`, антидубль 500 мс).

### 4.10. `labelCopy.content.ts`

- Слушает `click` в фазе capture на `document`.
- Поднимается от цели клика сразу к обёртке `[class*="_copyButton_"]`
  (`button` в цепочке не обязателен) и читает значение из
  `textarea[class*="_textarea_"]`.
- **Критично:** Ozon кладёт ШК в атрибут, а не в свойство:
  `<textarea value="ii8923223139">`. Для `<textarea>` content-атрибут `value`
  **не отражается** в `el.value` (там `""`), поэтому читается
  `el.value || el.getAttribute("value") || el.textContent`. Если textarea
  в разметке не окажется — ШК ищется регуляркой в тексте блока
  (`._target_` с видимым значением).
- Буфер обмена **не используется** (нет `clipboardRead`), текст уведомлений
  не парсится.
- Фильтр: только `^ii\d{9,14}$` (номер отправления `0114344617-0034-1` и
  название товара отсекаются) → `chrome.storage.local["lastCopiedLabel"]`.
- Селекторы частичные (`*=`) — имена классов Ozon содержат хэш сборки.
- Проверено на реплике разметки Ozon (все 6 кейсов: атрибут `value`, текст
  в textarea, отсутствие textarea, номер отправления, название товара,
  клик мимо блока).

### 4.11. Popup

`App.tsx` рендерит по порядку:

1. **StatusPrinting** — `GET /` → «Печать активна» / «Печать не активна»
   (подсказка «Проверьте, что приложение PrintNum запущено»).
2. **PrintSettingsPanel** — `GET /config`, `/papers`, `/listPrinters`,
   `/service`; переключатель `running`, принтер, размер этикетки, флаги
   `idNum`/`endLine`/`hybrid` + `expand` (порог виден только при `hybrid`),
   кнопка «Обновить», блок автозагрузки (`/service/install|uninstall`).
   Патчи оптимистичные: сначала локально, потом `POST /config`; при ошибке —
   перечитывание реального состояния. Fallback-список бумаги `["30*20"]`.
   Есть выбор **«Режим печати»** — `gdi` / `escpos` (raw ESC/POS) — и для
   `escpos`: «Зазор, мм», «Сдвиг вправо, мм», «Транспорт», «IP принтера».
   Есть чекбоксы **«QR товара рядом с номером»** (`qrWithNumber`),
   **«Шахматка (экономия термоголовки)»** (`checker` + `checkerMm`, мм) и
   **«Обводка по контуру»** (`outline` + `outlineMm`, мм).
3. **AutoPrintPanel** — режим (`xhr`/`dom`/`both`/`off`), «Полки (-88)»,
   «При упаковке», `dedupeMs`, предупреждение при старом сервере, последнее
   событие автопечати.
4. **BarcodeGenerator** — ввод текста, SVG-превью, кнопки «Печать через
   PrintNum» (HTTP POST `/print-barcode`) и «Печать из браузера», подхват
   `lastCopiedLabel`.

Тёмная тема: `App` ставит класс `dark` на `<html>` по
`prefers-color-scheme` (Tailwind `darkMode: ["class"]`).

Скриншоты для магазина в репозитории больше не хранятся (удалены как
неиспользуемые — `publish/*`, `light|dark/home.png`).

Иконки расширения лежат в `public/icon/` и попадают в `manifest.icons`.
Это важно: WXT ищет `publicDir` в **корне проекта**, поэтому прежняя
папка `src/public/` в сборку не попадала совсем (иконок в manifest не было).

### 4.12. `qrLabel.ts` — превью, совпадающее с C

`buildQrLabelSvg(text, {widthMm, heightMm, dpi, measureText})`:

- размеры из `paper` (`43*25` → 43×25 мм), DPI 203;
- `qrcode(0, "M")`, `addData(text, "Byte")` — как `PNQR_DEMO_ECC`;
- константы как в C: поля 0.5 мм, зазор 0.125 мм, префикс 4 мм,
  суффикс 6 мм, отношение min-текста `88/344`, тихая зона 4 модуля,
  сжатие текста до 8/10 px;
- отклоняет пустую строку и не-ASCII (32..127) — те же ошибки, что сервер;
- `createCanvasTextMeasurer()` — точное измерение, как GDI;
- `parsePaperSize("43*25")` → `{widthMm:43, heightMm:25}`.

Это **только превью**: реальную печать всегда делает C-служба.

### 4.13. Native Messaging — удалён (только HTTP)

Раньше в расширении был клиент native messaging (`utils/nativeMessaging.ts`,
host `ru.printnum.host`, разрешение `nativeMessaging` в manifest). C-служба
команду `--native-host` и регистрацию host-манифеста **никогда не реализовывала**,
поэтому каждый вызов «Печать через PrintNum» сначала падал в native, а потом
уходил на HTTP. Модуль, разрешение и native-ветка в `BarcodeGenerator` удалены:
единственный транспорт — HTTP на `127.0.0.1:5000`.

Если native messaging понадобится (печать без открытого порта):

1. вернуть `nativeMessaging` в `permissions` (`wxt.config.ts`);
2. добавить в `wWinMain` режим `--native-host`: 4-байтовый little-endian
   префикс длины + JSON в stdin/stdout;
3. зарегистрировать host-манифест (реестр Windows или
   `~/.config/google-chrome/NativeMessagingHosts/ru.printnum.host.json`);
4. поддержать команды `ping`, `print-number`, `print-barcode`,
   `status-printer`, `list-printers`;
5. вернуть клиентский модуль и fallback на HTTP в `BarcodeGenerator`.

### 4.14. Удалённые функции (история)

Раньше в проекте были **QR-команды**, **автоскрипты** и **настройки
видимости** для Ozon. Их код существовал только на страницах и никогда не
отображался в UI (popup-панели не были подключены к `App.tsx`), поэтому
функционал удалён вместе со вспомогательными модулями. Восстановить можно
только из git-истории (коммиты до `f0ba5e9`).

Что именно было (для понимания, если тянуть обратно):

| Функция | Раздел Ozon | Поведение |
|---|---|---|
| Выдать заказ/всё (без пакета, M, L) | `/orders`, `/orders/session` | «Взять в работу» → выбор пакета → «Выдать» |
| Оплатить заказ | `/orders/session` | выбор пакета → «Провести оплату» |
| Отказ от товара | `/orders/session` | «Проверить» → «На проверке» → «К выдаче» → причина |
| «С рекомендацией» | `/receiving-v2/main` | переключить тумблер |
| Автоскрипты | `/outbound` | «Упаковки Ozon нет» / «Перенести тарники» |
| Скрытие UI | все страницы | меню, уведомления, возвраты, баннеры |

Триггером служило сканирование QR-кода в нужном разделе (ID и таблицы
действий были в `constants.ts`), настройки — массивы имён в
`chrome.storage.local` (`other`, `autoscripts`, `qrCodes`, `returns`).

Удалено вместе с ними: 12 content-скриптов (`hide*`, `qr*`, `autoscript*`),
popup-панели (`Help`, `qrCommands`, `autoscript`, `SettingSection`, `hide/*`),
`components/{accordion,opeTabURL}.tsx`, `hooks/useStorageState.ts`,
`utils/{find,listener,code128}.ts`, печатные листы `qrCodes.pdf/docx`,
а также сидирование этих списков в `background.ts`.

### 4.15. Dev-инструменты

- **Эмулятор сканера** (`utils/scannerSimulator.ts`, только `import.meta.env.DEV`):
  ```js
  // консоль страницы Ozon, контекст "PrintNum" (иначе is not defined)
  PrintNumScanner.simulate("123-47");
  PrintNumScanner.simulateSequence(["123-47", "500-47"], 1500);
  ```
  Генерирует реальные `keydown` на `window` + Enter; в prod-сборке кода нет.
- **`window.PrintNumHook`** (dev, MAIN world): `emit`, `parsePlacement`,
  `isInterestingUrl`.
- Логи: `[PrintNum:auto]` (service worker), `[PrintNum:hook]` (страница),
  `[PrintNum:label]`, `[PrintNum:scanner]`.
- Порт: `extension/.env` → `VITE_PRINTNUM_PORT`, затем **пересборка**.

---

## 5. Связь сервер ↔ клиент

Это самый важный раздел: «полноценная связь» = совпадают адрес, порт, контракт
и версия API.

### 5.1. Транспорт и адресация

| Параметр | Сервер | Клиент |
|---|---|---|
| Транспорт | HTTP/1.1, без keep-alive | `fetch` из popup и service worker |
| Адрес | `INADDR_LOOPBACK` (`127.0.0.1`) | `http://127.0.0.1:${PORT}` |
| Порт | `DEFAULT_PORT 5000` (константа в C) | `VITE_PRINTNUM_PORT` (build-time), дефолт `5000` |
| Разрешения браузера | — | `host_permissions`: `http://localhost/*`, `http://127.0.0.1/*` |
| CORS | `Access-Control-Allow-Origin: *` + методы/заголовки | не требуется для host_permissions, но не мешает |
| Авторизация | отсутствует | отсутствует |

Следствия:

- `127.0.0.1` покрыт `host_permissions`; IPv6 (`[::1]`) — нет.
- Смена порта требует правки **двух** мест: `DEFAULT_PORT` в C + пересборка,
  `VITE_PRINTNUM_PORT` + `npm run build`. Порт расширения вшивается в бандл.
- На macOS порт 5000 часто занят AirPlay Receiver (`ControlCenter`) -
  он отвечает `403` на `/`. `wine-ctl.sh status` различает это по ответу
  `{"status": true}`; сервер всё равно может забиндиться на `127.0.0.1:5000`.
- **Никогда не менять `API_BASE` на `localhost`**: на macOS `localhost`
  резолвится в `::1`, где слушает AirPlay (ControlCenter) и отвечает `403`.
  Проверено на Chrome 158: `fetch("http://127.0.0.1:5000/")` из popup и
  service worker расширения работает (200), `fetch("http://localhost:5000/")`
  даёт `403` от ControlCenter. LNA/PNA в Chrome 158 запрос к `127.0.0.1` из
  расширения с `host_permissions` не блокируют.
- `./wine-ctl.sh stop` / `wineserver -k` гасят службу полностью: после этого
  popup честно показывает «Печать не активна». Перед проверкой связи —
  `./wine-ctl.sh start` (или запустить exe на Windows).

### 5.2. Полный список запросов клиента

| Кто | Когда | Запрос | Ожидание | Поведение при ошибке |
|---|---|---|---|---|
| `StatusPrinting` | открытие popup | `GET /` | `200` | «Печать не активна» |
| `PrintSettingsPanel` | открытие popup | `GET /config`, `/papers`, `/listPrinters`, `/service` | `200` | «Приложение PrintNum не запущено», поля заблокированы |
| `PrintSettingsPanel` | любое изменение | `POST /config` (частичный) | `200` + полный конфиг | текст ошибки, перечитывание `GET /config` |
| `PrintSettingsPanel` | кнопка автозагрузки | `POST /service/install` \| `/service/uninstall` | `200` | текст ошибки |
| `AutoPrintPanel` | открытие popup | `GET /config` | `200`, `features` | `shelfSupported = null` (без предупреждения) |
| `autoPrint.handleAutoPrint` | размещение товара | `GET /config` (кэш 30 с) | `features` | `null` — возможности неизвестны: полка всё равно печатается, ячейки печатаются без проверки |
| `autoPrint.handleAutoPrint` | размещение товара | `POST /print-number` (`text`, `qr?`) | `200 OK` | событие с `ok:false` + `lastAutoPrintEvent` |
| `BarcodeGenerator` | «Печать через PrintNum» | `POST /print-barcode` | `200 OK` | «PrintNum недоступен…» / «вернул ошибку N» |

Ответы `503` (служба выключена, принтер не выбран/offline) расширение
показывает как ошибку печати — это нормальный сценарий, а не «нет связи».

### 5.3. Матрица совместимости

| Сервер | Расширение | Что работает |
|---|---|---|
| новый (`features:["shelf-dash"]`) | новый | всё: ячейки, полки, QR, настройки, автозагрузка |
| старый (без `features`) | новый | ячейки и QR работают; полки блокируются с подсказкой «Обновите PrintNum»; в AutoPrintPanel — предупреждение |
| новый | старый | всё, что умел старый (ячейки, QR); новые поля конфига сервер принимает, но старое расширение их не показывает |
| нет сервера | любой | popup: «Печать не активна»; печать: сетевые ошибки в `lastAutoPrintEvent`; настройки не редактируются |
| сервер, порт ≠ порт расширения | любой | связи нет (fetch на закрытый порт) |

Версионирование: сервер объявляет возможности через `features` в
`GET /config` и ответе `POST /config`; расширение проверяет их перед
использованием нового поведения. Это единственный механизм feature-flag.

### 5.4. Диагностика: симптом → причина → что делать

| Симптом | Вероятная причина | Проверка | Решение |
|---|---|---|---|
| popup «Печать не активна» | служба не запущена / другой порт / AirPlay на 5000 | `curl -s http://127.0.0.1:5000/` | запустить exe; `./wine-ctl.sh start` + `status`; не путать с `403` от ControlCenter |
| «не видит сервер» после `wine-ctl.sh stop` | `wineserver -k` убил службу (это не «перезапуск») | `lsof -nP -iTCP:5000 -sTCP:LISTEN` | снова `./wine-ctl.sh start` |
| пустой ответ / `403` при запросе | в конфиге клиента `localhost` вместо `127.0.0.1` | `curl -s http://localhost:5000/` → `403` | использовать `127.0.0.1` (как в `api.ts`) |
| `503 stopped` | `running:false` | `GET /config` → `running` | включить в popup/`POST /config {"running":true}` |
| `503 no printer` | `printer:""` | `GET /config`, `GET /listPrinters` | выбрать принтер в popup |
| `503 printer offline` | spooler: OFFLINE/ERROR/paper out/jam, или `WORK_OFFLINE` | `GET /status-printer` | включить принтер/убрать offline |
| `400 not a cell number` | в `/print-number` ушёл текст с кириллицей/ШК | лог `lastAutoPrintEvent`, консоль | печатать только ячейки/полки; QR — через `/print-barcode` |
| `400 non-ascii` | в QR-этикетку попала кириллица | текст в BarcodeGenerator | только ASCII 32..127 |
| полки не печатают, подсказка «Обновите PrintNum» | нет `features:["shelf-dash"]` | `GET /config` | обновить exe |
| автопечать молчит | `autoPrint.mode = off`, не та страница, выключены `shelf`/`packing`, дедуп | `chrome.storage.local.autoPrint`, `lastAutoPrintEvent` | выбрать режим `xhr`, открыть нужный раздел |
| после обновления расширения ничего не ловится | старые content scripts/pageHook в открытой вкладке | консоль: `Extension context invalidated` | перезагрузить вкладку Ozon (F5) |
| нет QR на этикетке | `qrWithNumber` выключен, расширение не перезагружено или в ответе Ozon не было ШК | лог: `QR не напечатан: qrWithNumber выключен` / `Печать с QR выполнена` | включить чекбокс в popup, перезагрузить расширение и вкладку; в логе проверить строку печати |
| raw-печать: `500 print failed` | спулер не открыл принтер (`OpenPrinter`) или не соединился TCP | лог: `RAW ESC/POS: N байт — ошибка отправки` | проверить имя принтера в Windows (spooler) или `rawHost`/`rawPort` (tcp) |
| raw-печать: этикетка съезжает | неверный зазор или сдвиг | `labelGapMm`, `rawXOffsetMm` | подстроить в popup; при накоплении сдвига откалибровать принтер |
| нет шахматной заливки | `checker:false` в конфиге | `GET /config` → `checker` | включить «Шахматка» в popup (раньше этого не было в UI) |
| шахматка есть, но цифры пропали | `checker:true` + `outline:false` (старый баг: заливались все клетки) | демо `--demo-file` /`--demo-cell-qr` | обновить exe (исправлено в `checker_fill`); либо включить «Обводка по контуру» |
| ШК не подставляется в поле генератора | значение лежит в атрибуте `value`, а код читал только `.value`; либо старый content script | консоль вкладки: `[PrintNum:label] подхвачен штрихкод: ii…` | обновить сборку, перезагрузить расширение и вкладку; проверить `chrome.storage.local.lastCopiedLabel` |
| этикетка пустая/смещена | размер бумаги в драйвере ≠ `paper` | настройки принтера Windows | выставить тот же размер |
| popup показывает «не запущено», а `curl` работает | порт расширения ≠ порт сервера | `extension/.env`, `DEFAULT_PORT` | синхронизировать и пересобрать расширение |
| `POST /config` «ничего не меняет» | ключ/тип не поддержан mini-JSON | `GET /config` после патча | см. §3.5 (только известные ключи, числа без минуса) |

### 5.5. Чек-лист «связь полная»

```bash
# 1. Сервер поднят и отвечает контрактом
cd cPrintNum
./wine-ctl.sh start
curl -s http://127.0.0.1:5000/            # {"status": true}
curl -s http://127.0.0.1:5000/config      # ... "features":["shelf-dash"]

# 2. Контракт целиком (21 проверка, включая CORS/валидацию/полки)
./wine-ctl.sh test

# 3. Расширение собирается и типизируется
cd extension && npm run compile && npm run build
python3 -c "import json;m=json.load(open('output/chrome-mv3/manifest.json'));print(m['host_permissions']);print([c['js'] for c in m['content_scripts']])"

# 4. В браузере
#  - chrome://extensions → загрузить output/chrome-mv3 (или npm run dev)
#  - открыть popup: «Печать активна», принтер и размер подтянулись из /config
#  - Ozon → размещение товара → lastAutoPrintEvent = ok, принтер печатает
```

---

## 6. Инварианты и подводные камни

1. **Сервер не должен требовать CRT.** Любой новый вызов (`malloc`, `printf`,
   `qsort`, `snprintf`) сломает сборку/совместимость с Win7. Использовать
   `HeapAlloc`, `wsprintfW`, свои утилиты; проверять `objdump -p | grep crt`.
2. **`build.sh` не должен получить `-fdata-sections`** — PE раздувается.
3. **Порт 5000 зашит в C.** Меняя его, менять `VITE_PRINTNUM_PORT` и
   пересобирать расширение.
4. **`/print-number` принимает только цифры/дефис/пробел.** Любая новая
   семантика (полки, КГТ) должна проходить эту валидацию или менять её
   осознанно (и тогда обновлять `features`).
5. **Полка = ведущий дефис.** Не вводить отдельный эндпоинт, не сломав
   обратную совместимость; новый сервер обязан отдавать `shelf-dash`.
6. **Печать не ретраится.** Повтор HTTP-запроса = лишняя этикетка.
   Порядок обеспечивает `printChain` в background.
7. **Один запрос — одно соединение.** Не рассчитывать на keep-alive/сессии.
8. **Тело ≤ 4096, JSON ≤ 8192, принтеров ≤ 8, papers ≤ 16.** Большие данные
   (например, список принтеров на терминальном сервере) усекаются.
9. **`features` не сохраняется в `config.json`** — только в API-ответах.
10. **`filterEntrypoints` — единственный переключатель сборки** content-скриптов.
    Файл в `src/entrypoints/` сам по себе в сборку не попадает.
11. **`pageHook` — MAIN world через `executeScript`**, потому что Chrome 109
    (Win7) не умеет `world` в manifest. Не «оптимизировать» до manifest-ключа.
12. **`sendPrintNum` работает с `document_start`**, поэтому любой код не должен
    трогать `document.body` без проверки (иначе TypeError до `main`).
13. **Все сетевые вызовы клиента «мягкие»**: отсутствие сервера — штатное
    состояние, а не исключение. Сохранять это поведение.
14. **Popup не должен зависеть от disabled-модулей**: `App.tsx` импортирует
    только 4 панели; возврат функций = импорт + запись в `filterEntrypoints`.
15. **Кириллица нигде в печати не поддерживается** (ни Code128, ни QR, ни
    `/print-number`). Текстовые ячейки (`Возврат-1`) отбрасываются на клиенте
    (`CELL_PRINTABLE_RE`) и на сервере.
16. **Селекторы Ozon хэшируются** (`_copyButton_o3a5g_142`) — использовать
    частичные (`*=`), все они собраны в `utils/constants.ts`.

---

## 7. Рецепты изменений

| Задача | Где менять | Не забыть |
|---|---|---|
| Новый эндпоинт | `handle_request()` в C (+ `read_request`, если нужны поля) | обновить §3.7 и `api.ts`; прогнать `wine-ctl.sh test` |
| Новая настройка печати | `Config` + `cfg_defaults` + `cfg_load`/`cfg_apply_json` + `cfg_to_json` | UI в `PrintSettingsPanel`, тип `PrintSettings`, дефолт в `config.json`/`dist` |
| Новая возможность API | `cfg_to_api_json()` → `features` | проверка в `autoPrint.ts`/панелях |
| Новый перехват Ozon | `ozonPlacements.ts` (`OZON_ENDPOINTS`, `parsePlacement`) | `isInterestingUrl` покрывает URL; тест через `PrintNumHook.emit` |
| Новый DOM-селектор | `utils/constants.ts` (`SELECTORS`) | проверить на `example.html` (дамп Ozon) |
| Новая панель popup | `entrypoints/popup/*` + импорт в `App.tsx` | стили Tailwind, тёмная тема |
| Включить QR/автоскрипты/скрытие | `wxt.config.ts` `INCLUDED_ENTRYPOINTS` (+ панель в `App.tsx`) | перезагрузить вкладки Ozon |
| Поменять геометрию QR-этикетки | `draw_qr_label_core` (C) **и** `qrLabel.ts` (preview) | держать константы синхронными (0.5/0.125/4/6 мм, 88 px) |
| Поменять формат номера ячейки | `is_printable`-блок в `handle_request` + `prepare_label_data` | клиент: `CELL_PRINTABLE_RE`, `normalizePlacement` |
| Вернуть native messaging | `wWinMain` (`--native-host`) + клиентский модуль + `permissions` (см. §4.13) | host-манифест, реестр/каталог хостов |

---

## 8. Проверка и тесты

Автотестов в проекте нет. Практический минимум:

| Что | Команда |
|---|---|
| Сборка сервера + расширения + 2 zip | `./build.sh` (`SKIP_EXTENSION=1` — только exe) |
| Живой сервер | `./wine-ctl.sh start` / `stop` / `status` / `logs` / `reset` |
| Контракт API (21 проверка) | `./wine-ctl.sh test` (проверено: `21 passed, 0 failed`) |
| Типы расширения | `cd extension && npm run compile` (сейчас 0 ошибок) |
| Сборка расширения | `npm run build` → `output/chrome-mv3` |
| Демо-этикетка без принтера | `wine printnum-diag.exe --demo-file "45" label.bmp` |
| Демо QR-этикетки | `wine printnum-diag.exe --demo-qr "ii19382868529" label.bmp` |
| Демо «номер + QR товара» | `wine printnum-diag.exe --demo-cell-qr "163-1" "ii19382868529" label.bmp` → `zbarimg` декодирует ШК |
| Разбор ответов Ozon + `findBarcode` | esbuild-бандл теста в node: 13 проверок (ячейка, полка, без ШК, глубокий ШК, мусор, бюджет обхода) |
| RAW-поток ESC/POS | `--raw-dump "163-1" "ii…" label.bin` → разобрать байты: `ESC @`, `GS v 0` (344×200), `ESC J` (2 мм); растр декодируется `zbarimg` |
| Предупреждения C (`-Wextra`) | `x86_64-w64-mingw32-gcc … -Wall -Wextra …` → **0 предупреждений** |
| Корректность QR-энкодера | `sips -s format png label.bmp --out q.png && zbarimg -q --raw q.png` → `ii19382868529` |
| Типы без мёртвых locals | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` → 0 ошибок |
| Сквозной тест без сканера | dev-сборка + `PrintNumScanner.simulate("123-47")` |

Проверено на текущем состоянии: `./build.sh` — 0 ошибок/0 предупреждений
(`-Wall -Wextra`), `./wine-ctl.sh test` — `21 passed, 0 failed`,
`npm run compile` и `npm run build` — без ошибок, `manifest.icons` на месте,
QR-этикетка декодируется `zbarimg` в исходное значение.

Покрытие `wine-ctl.sh test`: `GET /`, `/config`, `/papers`, `/listPrinters`,
`/status-printer`, `/service`; `POST /config`; полка `-88` (доходит до `503`,
т.е. валидна); отказы `Возврат-1`, `Прямой поток - 5`, `ii…`, `---`, пусто,
`--`, `-`, `-8a` (все `400`); `OPTIONS` → `204`; `404`; наличие
`features:["shelf-dash"]`.

---

## 9. История, устаревшее, мёртвый код

Что изменилось и почему в README больше нет старых обещаний:

- **Rust/Slint/tiny_http версия** (`src-printnum/`) и **Python/Flask**
  (`amvera/`) удалены из рабочей папки. Графический интерфейс (окно Slint)
  больше не поддерживается: приложение — только служба, окно не создаётся. Этот README описывает **только**
  C-службу и расширение. Упоминания `printnum.exe` относятся к прежнему
  Rust-бинарнику — сейчас артефакты называются `printnum-win7.exe` /
  `printnum-diag.exe`.
- **`PRINTNUM_PORT`, `.env`, `--dry-run`, `--tui`, `--service-status`,
  `--install-autostart`** — возможности Rust-версии. В C-сборке их **нет**:
  порт фиксирован, dry-run только через `PRINTNUM_DRY_RUN` для CLI,
  автозагрузка ставится через API `POST /service/install`.
- **Code128 удалён**: `/print-barcode` печатает комбинированную QR-этикетку.
  Поля `moduleMm`/`heightMm` игнорируются.
- **`docs/*`** (`first-run.md`, `emulation-testing.md`, `native-messaging.md`,
  `frontend-reference.md`, `preact-vs-vanilla.md`) удалены; их актуальные
  части перенесены сюда.
- **Native Messaging** описано в старом README как рабочее — в C-службе оно
  **не реализовано**, поэтому клиент и разрешение `nativeMessaging` удалены:
  работаем только через HTTP (см. §4.13).
- **КГТ-логика** (`is_kgt`) в C присутствует, но недостижима из-за валидации
  `/print-number`.
- **Шахматка без обводки** (`checker:true, outline:false`) раньше заливала
  белым все клетки прямоугольника — этикетка выходила без цифр. Исправлено:
  `checker_fill()` гасит только каждую вторую клетку.
- **Удалённый код расширения** (недостижим из пяти собираемых entrypoint'ов):
  12 content-скриптов (`hide*`, `qr*`, `autoscript*`), popup-панели
  (`Help`, `qrCommands`, `autoscript`, `SettingSection`, `hide/*`),
  `components/{accordion,opeTabURL}.tsx`, `hooks/useStorageState.ts`,
  `utils/{find,listener,code128}.ts`, `src/main.css`, `components.json`,
  `eslint.config.js` (без зависимостей не запускался), `pnpm-lock.yaml`,
  `src/public/*` (иконки, скриншоты, `qrCodes.pdf/docx`) и сидирование
  legacy-списков в `background.ts`.
- **Иконки**: WXT ищет `publicDir` в корне проекта, поэтому прежняя
  `src/public/` не попадала в сборку — `manifest.icons` отсутствовал.
  Иконки перенесены в `public/icon/` и теперь попадают в manifest.
- **`example.html` / `example_files/`** — дамп реальной страницы Ozon
  (600+ КБ, 120+ CSS), нужен только для изучения разметки; в `.gitignore`.
  Оставлен намеренно (не восстанавливается из git).
- **`compile_commands.json` / `generate_compile_commands.py`** — для clangd;
  пути внутри устарели (`src-printnum-c`, `test-min.c` отсутствует).
  Регенерировать при необходимости.
- **Один лок-файл** (`package-lock.json`, npm); `pnpm-lock.yaml` удалён.
  `esbuild` остаётся в devDependencies: без него `tsc --noEmit` падает на
  типах `vite.esbuild` в `wxt.config.ts` (проверено).

---

## 10. Глоссарий

| Термин | Значение |
|---|---|
| **Ячейка** | место хранения Ozon, печатается как `163-1`; на этикетке крупно `163.` (+ `-1` при `idNum`) |
| **Полка** | `Ozon Полка-88` → `-88`; ведущий дефис = маркер полки, отдельного эндпоинта нет |
| **КГТ** | крупногабаритный товар, `КГТ-123`; в C-сборке недостижимо (валидация) |
| **`hybrid`** | гибридный формат: при номере ≥ `expand` печатается крупно вторая часть (`600-1` → крупно `1.`) |
| **`expand`** | порог `hybrid` (по умолчанию 500) |
| **`endLine`** | `false` — точка в конце, `true` — подчёркивание |
| **`idNum`** | показывать часть после дефиса мелким шрифтом |
| **`checker` / `checkerMm`** | шахматная заливка цифры и размер клетки (экономия термоголовки) |
| **`outline` / `outlineMm`** | сплошной контур по краю глифа и его толщина |
| **`features`** | список возможностей сервера в API (`["shelf-dash"]`), в файл не пишется |
| **`Placement`** | нормализованное событие печати: `{text, kind: cell\|shelf, endpoint, origin, dedupe, raw}` |
| **`origin`** | источник события: `xhr` (pageHook), `dom` (наблюдатель), `scanner` (эмулятор/dev) |
| **`runAt: document_start`** | content script запускается до разбора DOM страницы |
| **MAIN / ISOLATED world** | мир страницы (перехват XHR) / изолированный мир расширения |
| **`filterEntrypoints`** | белый список WXT: какие файлы `src/entrypoints` попадут в сборку |

---

## Лицензия и авторы

- Проект: **MIT**.
- QR-энкодер: порт [ricmoo/QRCode](https://github.com/ricmoo/QRCode) — MIT,
  © Richard Moore / Project Nayuki.
- Расширение: автор **Кирилл** (Telegram: `@aim_stars`).
- Chrome Web Store: «PrintNum — Печать Ячеек (Ozon)».
