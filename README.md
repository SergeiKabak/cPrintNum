# PrintNum

Печать номеров ячеек и складских этикеток Ozon: desktop-служба для Windows +
браузерное расширение для `turbo-pvz.ozon.ru`.

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
