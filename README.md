# PrintNum

[![CI](https://github.com/SergeiKabak/cPrintNum/actions/workflows/ci.yml/badge.svg)](https://github.com/SergeiKabak/cPrintNum/actions/workflows/ci.yml)
[![Release](https://github.com/SergeiKabak/cPrintNum/actions/workflows/release.yml/badge.svg)](https://github.com/SergeiKabak/cPrintNum/releases/latest)
[![Pages](https://github.com/SergeiKabak/cPrintNum/actions/workflows/pages.yml/badge.svg)](https://sergeikabak.github.io/cPrintNum/)

Печать номеров ячеек и складских этикеток Ozon: desktop-служба для Windows +
браузерное расширение для `turbo-pvz.ozon.ru`.

> 📋 **Статус и план работ:** [`cPrintNum/docs/status-and-roadmap.md`](./cPrintNum/docs/status-and-roadmap.md)
> — что сделано, что делаем в 2.2.0, бэклог и известные проблемы.
>
> 📘 **Вся документация проекта — в [`cPrintNum/README.md`](./cPrintNum/README.md).**
> Это единая база знаний (для людей и ИИ-агентов): карта файлов, контракт API,
> логика этикеток и QR, автопечать, диагностика связи сервер ↔ клиент,
> инварианты и рецепты изменений.

## Структура репозитория

```
PrintNum/
├── cPrintNum/            # весь проект
│   ├── printnum-win7.c   # сервер: HTTP + GDI-печать + QR (single-file, без CRT)
│   ├── build.sh          # кросс-сборка под Windows 7 x64 (MinGW-w64)
│   ├── wine-ctl.sh       # запуск/тест службы под Wine на macOS
│   ├── dist/             # готовые exe + zip
│   └── extension/        # клиент: WXT + Preact + TypeScript
└── README.md             # этот файл (точка входа)
```

## Быстрый старт

```bash
# сервер (кросс-компиляция, macOS/Linux)
cd cPrintNum
brew install mingw-w64
./build.sh
./wine-ctl.sh start        # живой прогон под Wine
./wine-ctl.sh test         # smoke-тест API

# клиент
cd extension
npm install
npm run dev                # → output/chrome-mv3
```

На Windows: распаковать `cPrintNum/dist/PrintNum-win7.zip`, запустить
`printnum-win7.exe`, установить расширение, выбрать принтер и размер этикетки
в popup. Служба слушает `http://127.0.0.1:5000`.

## Установка (для оператора ПВЗ)

Готовые сборки — в [Releases](https://github.com/SergeiKabak/cPrintNum/releases/latest):

| Файл | Что это |
|---|---|
| `install.ps1` | установка одной командой: скачивает, распаковывает в `%LOCALAPPDATA%\PrintNum`, запускает службу, открывает `chrome://extensions` |
| `PrintNum-<ver>-windows.zip` | всё в одной папке: `extension/` + exe + `config.json` + `README.txt` |
| `printnum-extension-<ver>.zip` | только расширение, `manifest.json` в корне (Chrome / Edge / Opera) |
| `printnum-win7.exe`, `config.json` | только служба печати |
| `SHA256SUMS.txt` | контрольные суммы |

Пошаговая инструкция с картинками:
**<https://sergeikabak.github.io/cPrintNum/install.html>** ·
[политика конфиденциальности](https://sergeikabak.github.io/cPrintNum/privacy.html)

Windows 7 SP1 x64 и новее, Chrome/Edge 109+, принтер этикеток в системе.
Права администратора не нужны, установка службы Windows не выполняется.

### Как выпустить релиз

```bash
cd cPrintNum
./scripts/release.sh          # → dist/release/ (архивы + SHA256SUMS)
git tag v2.1.0 && git push origin v2.1.0   # CI соберёт и опубликует сам
```

`.github/workflows/release.yml` на тег `v*` собирает exe (MinGW), расширение
(WXT), прогоняет `tsc`, проверяет архивы (manifest в корне, нет CRT-зависимостей)
и публикует GitHub Release с файлами и текстом установки.

## CI/CD

| Workflow | Триггер | Что делает |
|---|---|---|
| [`ci.yml`](./.github/workflows/ci.yml) | push в любую ветку, PR | exe (MinGW) без CRT и без предупреждений `-Wall -Wextra`; prettier-проверка, `tsc` + сборка расширения + валидация манифеста |
| [`release.yml`](./.github/workflows/release.yml) | тег `v*` | сборка + GitHub Release с архивами, exe, `install.ps1`, `SHA256SUMS.txt` |
| [`pages.yml`](./.github/workflows/pages.yml) | изменения в `docs/` | деплой `docs/` на GitHub Pages (`install.html`, `privacy.html`) |

Проверки в CI не «на глаз»: предупреждение компилятора валит job `server`,
сломанный манифест или типы — job `extension`.

Smoke-тесты API (`./wine-ctl.sh test`, 27 проверок) в CI **не запускаются**:
wine ставится на раннер минутами и часто висит на `apt`, а окружение ПВЗ
(принтер этикеток, драйвер Windows) всё равно не воспроизвести. Их место —
локальная машина разработчика.

## Связь компонентов

```
расширение (Ozon) ── HTTP ──► printnum-win7.exe ── GDI/Spooler ──► принтер
```

- Порт по умолчанию — `5000` (в C-службе зашит; в расширении задаётся
  `VITE_PRINTNUM_PORT` при сборке).
- Возможности сервера объявляются через `features` в `GET /config`
  (`shelf-dash` — поддержка полок `-88`).
- Подробный контракт, коды ответов и диагностика — в
  [`cPrintNum/README.md` §5](./cPrintNum/README.md#5-связь-сервер--клиент).

## Лицензия

MIT. QR-энкодер — порт [ricmoo/QRCode](https://github.com/ricmoo/QRCode)
(MIT, Richard Moore / Project Nayuki).
