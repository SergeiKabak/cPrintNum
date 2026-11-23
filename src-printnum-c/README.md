# PrintNum C версия — Win7 single-file

Минимальная портация PrintNum на C для Windows 7 x64. **Один исходный файл**, **один исполняемый файл (22 KB)**, **ноль CRT зависимостей**.

## Структура

```
src-printnum-c/
├── printnum-win7.c     # Единственный исходник (~42 KB)
├── build.sh            # Скрипт сборки (2 варианта exe)
└── dist/
    ├── printnum-win7.exe   # GUI служба
    ├── printnum-diag.exe   # Консольный диагностический
    ├── config.json         # Конфиг по умолчанию
    └── PrintNum-win7.zip   # Готовый архив для переноса на Win7
```

## Сборка

```bash
./build.sh
```

**Результат:**
- `printnum-win7.exe` — **22 KB**, GUI служба (HTTP-сервер на порту 5000)
- `printnum-diag.exe` — **22 KB**, консольный диагностический вариант

**Зависимости:** только 6 системных DLL Windows 7:
```
GDI32.dll, KERNEL32.dll, SHELL32.dll, USER32.dll, WINSPOOL.DRV, WS2_32.dll
```
**CRT зависимостей нет** (`api-ms-win-crt-*` отсутствуют).

### Зачем нужна каждая DLL

Программа собрана без C-рантайма (`-nostdlib -e wWinMain`), поэтому все операции — от работы с файлами до рисования — идут напрямую через системные API Windows. Ниже — роль каждой DLL и конкретные функции, которые из неё используются.

#### GDI32.dll — отрисовка этикетки

Графический subsystem Windows. Через неё рисуется содержимое этикетки:
- `CreateFontW` — шрифт Arial с автоподбором размера (`make_font`).
- `GetTextExtentPoint32W` — измерение ширины/высоты текста для центрирования и подбора кегля.
- `TextOutW` — вывод номера ячейки и колонтитула.
- `CreateCompatibleDC` / `CreateCompatibleBitmap` / `SelectObject` / `DeleteObject` — памятный DC для шахматной заливки (`apply_checker_with_outline`).
- `GetDIBits` / `SetDIBits` — чтение и запись пикселей глифа: поиск граничных пикселей (сплошной контур) и превращение внутренних в шахматку.
- `PatBlt` — заливка белым (фон, пропуски шахматки), `BitBlt` — перенос готового изображения на DC принтера.
- `GetDeviceCaps` — получение DPI (`LOGPIXELSX`, `LOGPIXELSY`) для перевода миллиметров в пиксели и размеров клетки 1 мм / линии 0.5 мм.
- `SetBkMode` — прозрачный фон текста.
- `StartDocW` / `StartPage` / `EndPage` / `EndDoc` / `AbortDoc` / `CreateDCW` — управление печатной страницей (DC создаётся здесь же, хотя принтер открывается через WINSPOOL).

Без GDI32 невозможно нарисовать ни номер, ни шахматку, ни демо-BMP.

#### KERNEL32.dll — ядро системы: файлы, память, процесс, время

Базовые системные сервисы, которые заменяют缺失ную CRT:
- `CreateFileW` / `ReadFile` / `WriteFile` / `CloseHandle` — чтение и запись `config.json`, лог-файла, демо-BMP.
- `CreateDirectoryW` / `GetFileAttributesW` / `DeleteFileW` — создание `%APPDATA%\PrintNum`, установка/удаление автозагрузки.
- `GetEnvironmentVariableW` — получение `%APPDATA%` и флага `PRINTNUM_DRY_RUN`.
- `GetModuleFileNameW` — путь к自己的 exe для автозапуска и `CreateProcessW`.
- `CreateProcessW` — запуск скрытой копии службы (`--service`, `CREATE_NO_WINDOW`).
- `GetProcessHeap` / `HeapAlloc` / `HeapFree` — выделение памяти вместо `malloc/free` (CRT нет).
- `GetLocalTime` — метки времени в логе.
- `MultiByteToWideChar` / `WideCharToMultiByte` — преобразование UTF-8 ↔ UTF-16 (HTTP-тело, JSON, конфиг).
- `GetCommandLineW` — получение исходной командной строки (передаётся в `CommandLineToArgvW` из SHELL32).
- `LocalFree` — освобождение массива `argv`; **внимание**: после этого указатели недействительны, поэтому строки копируются в статические буферы до вызова.

#### SHELL32.dll — разбор командной строки

Используется ровно одной функцией:
- `CommandLineToArgvW` — разбирает строку от `GetCommandLineW()` на аргументы (`--print "45"`, `--demo-file "45" out.bmp`). Живёт в SHELL32, поэтому без неё CLI-флаги не работают.

Освобождает полученный массив `LocalFree` — уже из KERNEL32.

#### USER32.dll — форматирование строк

Несмотря на то что служба работает без окон, USER32 нужна только для двух функций форматирования:
- `wsprintfW` — форматирование wide-строк (Запись JSON, лог, сообщения об ошибках, имена документов). Заменяет `swprintf` из CRT, которого нет.
- `wsprintfA` — форматирование узких (UTF-8) строк, например HTTP-заголовков в `send_response`.

Точка входа `wWinMain` сама по себе не требует импорта из USER32 — достаточно флага `-municode` при сборке.

#### WINSPOOL.DRV — драйвер спулера печати

Ключевая DLL для печати. Через неё программа взаимодействует с принтером:
- `OpenPrinterW` / `ClosePrinter` — открытие принтера по имени из конфига.
- `GetPrinterW` (level 2) — чтение `PRINTER_INFO_2`, статуса (`PRINTER_STATUS_ERROR`, `OFFLINE`, `PAPER_JAM`, `PAPER_OUT`) и атрибута `WORK_OFFLINE` для проверки «принтер в сети».
- `EnumPrintersW` (level 4) — получение списка локальных и сетевых принтеров для `GET /listPrinters`.
- `CreateDCW` — создание контекста устройства принтера (реализован в GDI32, но работает только вместе с драйвером спулера); именно на нём рисуется этикетка.
- Управление страницей (`StartDocW`, `StartPage`, `EndPage`, `EndDoc`) — также в GDI32, но передаётся драйверу спулера.

Без WINSPOOL.DRV программа не сможет ни увидеть принтеры, ни открыть их, ни проверить статус.

#### WS2_32.dll — Winsock, HTTP-сервер

Сетевой слой. На нём работает встроенный HTTP-сервер на `127.0.0.1:5000`, через который браузерное расширение управляет печатью:
- `WSAStartup` / `WSACleanup` — инициализация Winsock 2.2.
- `socket` / `bind` / `listen` / `accept` / `closesocket` — слушающий сокет на loopback с `SO_REUSEADDR` (быстрый рестарт службы).
- `recv` / `send` — чтение HTTP-запросов и отправка ответов (JSON/CORS).
- `htons` / `htonl` — преобразование порта и адреса в сетевой порядок байтов.
- `setsockopt` — включение `SO_REUSEADDR`.

Все 11 эндпоинтов (`/`, `/status-printer`, `/listPrinters`, `/papers`, `/config`, `/service`, `/print-number`, `/print-barcode`, `/service/install`, `/service/uninstall`, `OPTIONS`) работают поверх WS2_32.

> **Зачем это важно:** каждая из этих DLL входит в состав Windows 7 SP1, поэтому архив переносится на чистую машину без установки Runtime, .NET или Visual C++ Redistributable. Именно отсутствие `api-ms-win-crt-*` и делает возможной работу на Win7 без дополнительных компонентов.

## Архитектура

- **Single-file**: весь код в `printnum-win7.c` (HTTP-сервер, JSON-парсер, GDI-печать, конфиг).
- **Без CRT**: `-nostdlib -e wWinMain`, свои `strlen/memcpy/memset`.
- **Win7 совместимость**: только системные DLL, которые есть в чистой Win7 SP1.

### Оптимизации для старого железа

| Оптимизация | Эффект |
|-------------|--------|
| Автоподбор шрифта — линейная экстраполяция от реперного размера 100 px | 2–3 GDI-вызова вместо ~50 циклов «+1 px» |
| `BODY_MAX` 4 KB (тела запросов расширения ≤ 1 KB) | −48 KB BSS, −72 KB стека |
| `Content-Length` парсится в char-буфере без wide-конверсии | −64 KB стека на запрос |
| Буферы спулера 4 KB, список принтеров до 8 шт. | −36 KB BSS |
| Кеш пути лога | нет лишних обращений к FS при логировании |
| `-Os -ffunction-sections -Wl,--gc-sections` | exe 26.6 KB → **18.9 KB** |

**Итого:** resident-память ~176 KB → ~92 KB BSS, стек на запрос ~130 KB → ~20 KB.

> ⚠️ `-fdata-sections` **не использовать**: множество static-буферов в отдельных
> секциях раздувает PE из-за выравнивания (exe вырастает до 132 KB).

## Использование на Windows 7

1. Распакуйте `dist/PrintNum-win7.zip` в любую папку (например, `C:\PrintNum\`).
2. Запустите `printnum-win7.exe` (двойной клик) — стартует HTTP-сервер на `127.0.0.1:5000` без окон.
3. Расширение браузера подключается автоматически (порт 5000 по умолчанию).
4. Лог пишется в `%APPDATA%\PrintNum\log.txt`.

### Консольный диагностический режим
```cmd
printnum-diag.exe
echo Код выхода: %ERRORLEVEL%
```

### Одноразовая печать из командной строки
```cmd
printnum-win7.exe --print "123-456"
```
Печатается **только номер ячейки**: цифры, дефис, пробел + минимум одна цифра.
`Возврат-1`, `Прямой поток - 5`, штрихкоды `ii...` — отклоняются (exit 1 + лог).

## API (совместим с Rust-версией)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/` | `{"status": true}` |
| GET | `/status-printer` | `{"printerOnline": bool}` |
| GET | `/listPrinters` | `{"listPrinters": [...]}` (до 8) |
| GET | `/papers` | `{"papers": [...]}` |
| GET | `/config` | Текущий конфиг |
| GET | `/service` | `{"installed": bool}` |
| POST | `/config` | Частичное обновление, возвращает полный конфиг |
| POST | `/print-number` | Печать `{"text": "123-456"}`; не-номер → `400 not a cell number` |
| POST | `/print-barcode` | Печать Code128 `{"text":"ii123456789","moduleMm":0.25,"heightMm":17}` |
| POST | `/service/install` | Автозагрузка + запуск скрытой копии (`CREATE_NO_WINDOW`) |
| POST | `/service/uninstall` | Удаление из автозагрузки |
| OPTIONS | `*` | 204 (CORS preflight) |

## Конфиг (`%APPDATA%\PrintNum\config.json`)

```json
{
  "printer": "",
  "paper": "43*25",
  "idNum": false,
  "endLine": false,
  "hybrid": false,
  "checker": true,
  "checkerMm": 10,
  "outline": true,
  "outlineMm": 5,
  "expand": 500,
  "running": true,
  "papers": ["43*25","30*20","40*30","50*70","58*40","60*40","75*120","100*150"]
}
```

Размер бумаги по умолчанию: **43×25 мм**.

### Демо-режим: печать в BMP без принтера

```bash
wine printnum-diag.exe --demo-file "45" label.bmp
```

Генерирует `label.bmp` (344×200 px, 43×25 мм @ 203 dpi) с текущими настройками заливки — удобно для проверки перед печатью. Файл создаётся в текущей директории (можно указать и полный путь).

### Экономия термоголовки: шахматная заливка + обводка по контуру

Цифры заливаются шахматкой (чередующиеся белые квадраты), а по рельефу цифры проходит **сплошная тонкая линия** — форма цифры остаётся чёткой и читаемой, но термоголовка греется меньше.

| Ключ | Тип | По умолчанию | Назначение |
|------|-----|--------------|------------|
| `checker` | `bool` | `false` | `true` — шахматная заливка цифры (экономия термоголовки) |
| `checkerMm` | `number` (0.1 мм) | `10` | Размер клетки шахматки, 10 = 1.0 мм |
| `outline` | `bool` | `true` | `true` — сплошная обводка по контуру цифры |
| `outlineMm` | `number` (0.1 мм) | `5` | Толщина обводки, 5 = 0.5 мм |

Пример (шахматка 1 мм + обводка 0.5 мм):
```json
"checker": true, "checkerMm": 10, "outline": true, "outlineMm": 5
```

Обводка строится по растру глифа: чёрные пиксели на границе с белыми остаются сплошными, а внутренние превращаются в шахматку. Линия точно повторяет форму цифры (включая низ `4`) и не выходит за её границы.

## Сборка на macOS/Linux (кросс-компиляция)

Требуется MinGW-w64:
```bash
brew install mingw-w64
./build.sh
```

Флаги (см. `build.sh`):
```bash
x86_64-w64-mingw32-gcc -municode -Os -s -Wall -static \
  -nostdlib -e wWinMain -ffreestanding -fno-builtin \
  -ffunction-sections -Wl,--gc-sections \
  printnum-win7.c -o printnum-win7.exe \
  -lgcc -lkernel32 -luser32 -lgdi32 -lwinspool -lws2_32 -lshell32
```

## Проверено через Wine 11.0 (macOS)

- ✅ Все 11 эндпоинтов отвечают по контракту Rust-версии
- ✅ `EnumPrintersW` видит принтеры (через CUPS)
- ✅ Реальная GDI-печать прошла на сетевой принтер (HTTP 200)
- ✅ Code128 совпадает с тест-векторами Rust (1234→57, A→46, ii18725308927→145 модулей)
- ✅ Фильтр номеров: `Возврат-1` → 400, `123-456` → печать
- ✅ Автозагрузка: install/uninstall создают/удаляют `Startup\PrintNum.cmd`
- ✅ Конфиг персистентен (POST /config → запись на диск)

## Статус

- ✅ HTTP-сервер (Winsock, 127.0.0.1:5000)
- ✅ GDI-печать текста с автоподбором шрифта (экстраполяция)
- ✅ JSON-парсер (конфиг + запросы)
- ✅ Фильтр «только номер ячейки» (как `cell.rs::is_printable` в Rust)
- ✅ Автозагрузка через Startup-папку + скрытый перезапуск службы
- ✅ Логирование в `%APPDATA%\PrintNum\log.txt` (с кешем пути)
- ✅ Штрихкоды Code128 (порт barcode.rs: Auto B/C, PatBlt + HRI-текст)
- ❌ Эмуляция (dry-run) — только флаг `PRINTNUM_DRY_RUN` для CLI

## Лицензия

MIT
