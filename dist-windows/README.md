# Сборка архива для Windows 7

Заготовка релизного архива PrintNum для Windows 7 x64.

## Способы получить готовый архив

### Вариант 1. Автоматически (рекомендуется)

**На Windows** (там есть MSVC-линкер для `.exe`):

```bat
cd dist-windows
build-release.bat
```

Скрипт:
1. соберёт `printnum.exe`;
2. соберёт расширение (`npm run build` + `npm run zip`);
3. сложит всё в `package\`;
4. упакует в `PrintNum-win7-x64-v<версия>.zip`.

Требования: Rust + MSVC Build Tools, Node.js 18+.

### Вариант 2. Вручную

1. Соберите приложение на Windows:
   ```bat
   cd src-printnum
   build-windows.bat
   ```
2. Скопируйте `printnum.exe` из
   `src-printnum\target\x86_64-pc-windows-msvc\release\` в корень архива.
3. Соберите расширение:
   ```bash
   cd extension
   npm install
   npm run build && npm run zip
   ```

## Что попадает в архив

| Файл | Назначение |
| ---- | ---------- |
| `printnum.exe` | Приложение PrintNum |
| `INSTALL-WINDOWS-7.md` | Инструкция по установке (рус.) |
| `READ-ME-FIRST.txt` | Краткая памятка |
| `extension\chromium\` | Расширение (распакованное) |
| `extension\printnum-chrome.zip` | Расширение (zip) |
| `native-host\` | Манифест и скрипт native messaging |
| `docs\` | Подробная документация |
| `README.md` | Описание проекта |

## Почему нельзя собрать архив на macOS/Linux

`printnum.exe` — Windows-бинарник. Для его сборки нужен MSVC-линкер
(`link.exe`), которого нет вне Windows.

## Содержимое этой папки

- `INSTALL-WINDOWS-7.md` — пользовательская инструкция (попадает в архив).
- `build-release.bat` — сборщик архива (запускать на Windows).
- `README.md` — этот файл.

## Шаблон архива

`PrintNum-win7-x64-SHABLON.zip` в корне проекта — архив **без `printnum.exe`**
(всё остальное готово). На Windows достаточно собрать `.exe` и добавить
его в архив, либо воспользоваться `build-release.bat`.