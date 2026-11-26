#!/bin/bash
# release.sh — сборка файлов для GitHub Releases (self-hosted распространение).
#
#   ./scripts/release.sh              # собрать всё и сложить в dist/release/
#   SKIP_BUILD=1 ./scripts/release.sh # не пересобирать (взять готовые exe/расширение)
#
# Единый windows-архив собирает build.sh (dist/PrintNum-<ver>-windows.zip),
# здесь он только копируется в dist/release/ — переупаковки нет.
#
# Результат в dist/release/:
#   PrintNum-<ver>-windows.zip          extension/ + exe + config + install.ps1 + README.txt
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

# ---------- 3. windows-архив из build.sh ----------
WINDOWS_ZIP="$DIST/PrintNum-$VER-windows.zip"
if [ ! -f "$WINDOWS_ZIP" ]; then
  echo "❌ Нет $WINDOWS_ZIP — build.sh не собрал архив (SKIP_EXTENSION=1?)"
  exit 1
fi
cp -f "$WINDOWS_ZIP" "$OUT"/
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
