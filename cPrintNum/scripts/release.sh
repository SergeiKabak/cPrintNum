#!/bin/bash
# release.sh — сборка файлов для GitHub Releases (self-hosted распространение).
#
#   ./scripts/release.sh              # собрать всё и сложить в dist/release/
#   SKIP_BUILD=1 ./scripts/release.sh # не пересобирать (взять готовые exe/расширение)
#
# Результат в dist/release/:
#   PrintNum-<ver>-windows.zip          всё в одной папке: extension/ + exe + config + README.txt
#   printnum-extension-<ver>.zip        только расширение (manifest.json в корне) — Chrome/Edge/Opera
#   printnum-win7.exe / printnum-diag.exe   служба печати (Windows 7 x64)
#   config.json                         конфиг службы по умолчанию
#   install.ps1                         установка одной командой (Windows)
#   SHA256SUMS.txt                      контрольные суммы
#
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

EXT_OUT="$ROOT_DIR/extension/output/chrome-mv3"
DIST="$ROOT_DIR/dist"
OUT="$DIST/release"

# ---------- сборка ----------
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  ./build.sh
fi

if [ ! -f "$EXT_OUT/manifest.json" ]; then
  echo "❌ Нет сборки расширения: $EXT_OUT/manifest.json"
  echo "   Запустите ./build.sh или соберите extension: npm run build"
  exit 1
fi

VER="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$EXT_OUT/manifest.json" \
  | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
if [ -z "$VER" ]; then
  echo "❌ Не удалось прочитать version из manifest.json"
  exit 1
fi
NAME="printnum-$VER"
echo "=== GitHub Release: версия $VER ==="

rm -rf "$OUT"
mkdir -p "$OUT"

# ---------- 1. только расширение ----------
# manifest.json обязан быть в корне архива — иначе «Загрузить распакованное»
# и магазины не поймут пакет.
( cd "$EXT_OUT" && zip -X -r -9 "$OUT/printnum-extension-$VER.zip" . -x '*.map' '.DS_Store' >/dev/null )
echo "✅ printnum-extension-$VER.zip"

# ---------- 2. exe + конфиг ----------
cp -f printnum-win7.exe printnum-diag.exe "$OUT"/
if [ -f config.json ]; then cp -f config.json "$OUT"/; fi
echo "✅ exe + config.json"

# ---------- 3. всё в одной папке (для «распаковал и работает») ----------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/PrintNum"
mkdir -p "$PKG"

cp -R "$EXT_OUT" "$PKG/extension"
rm -rf "$PKG/extension/.DS_Store"
cp -f printnum-win7.exe printnum-diag.exe "$PKG"/
if [ -f config.json ]; then cp -f config.json "$PKG"/; fi
cp -f scripts/install.ps1 "$PKG"/ 2>/dev/null || true

cat > "$PKG/README.txt" <<'TXT'
PrintNum — печать этикеток ячеек и QR для ПВЗ Ozon
==================================================

В папке:
  printnum-win7.exe   служба печати (запустить один раз, окна нет)
  printnum-diag.exe   то же + консоль (диагностика)
  config.json         настройки службы (принтер, режим GDI/ESC-POS)
  extension\          расширение для браузера
  install.ps1         автоматическая установка (правый клик -> Выполнить с PowerShell)

Быстрый старт
-------------
1. Запустить printnum-win7.exe (можно из этой папки).
   Появится запрос брандмауэра — разрешить для частных сетей.
   Проверка: откройте http://127.0.0.1:5000/ в браузере.

2. Установить расширение:
   • Chrome/Edge/Opera: chrome://extensions (или edge://extensions, opera://extensions)
   • включить «Режим разработчика» / Developer mode
   • «Загрузить распакованное» / Load unpacked
   • выбрать папку extension (ту, что рядом с этим файлом)

3. Открыть https://turbo-pvz.ozon.ru, войти как обычно.
   В панели браузера появится иконка PrintNum.

4. В popup: выбрать принтер, бумагу (43*25), проверить печать.

Обновление
----------
Скачать новый архив, распаковать поверх этой папки (config.json можно не
перезаписывать), в chrome://extensions нажать «Обновить» у PrintNum.

Если не печатает
----------------
• http://127.0.0.1:5000/status-printer — видит ли служба принтер;
• принтер должен быть установлен в Windows (драйвер), имя — в config.json
  или в popup расширения;
• подробности: https://github.com/SergeiKabak/cPrintNum
TXT

( cd "$STAGE" && zip -X -r -9 "$OUT/PrintNum-$VER-windows.zip" "PrintNum" >/dev/null )
echo "✅ PrintNum-$VER-windows.zip"

# ---------- 4. установщик ----------
cp -f scripts/install.ps1 "$OUT"/
echo "✅ install.ps1"

# ---------- 5. контрольные суммы ----------
( cd "$OUT" && shasum -a 256 *.zip *.exe *.ps1 2>/dev/null | sed 's/  /  /' > SHA256SUMS.txt )
echo "✅ SHA256SUMS.txt"

echo ""
echo "=== Готово: $OUT ==="
ls -lh "$OUT" | awk 'NR>1 {printf "  %-34s %s\n", $9, $5}'
echo ""
echo "Дальше:"
echo "  git tag v$VER && git push origin v$VER     # CI соберёт релиз сам"
echo "  или вручную: gh release create v$VER $OUT/* --generate-notes"
