#!/usr/bin/env bash
#
# Сборка PrintNum для macOS.
#
# ВНИМАНИЕ: сборка под macOS предназначена ТОЛЬКО для разработки и тестов.
# Печать реализована через Win32 GDI/Spooler и на macOS недоступна — приложение
# запускается, показывает GUI и отвечает на API, но на принтер не печатает.
# В режиме эмуляции (--dry-run) выводит разбор номера в консоль.
#
# Результат:
#   target/release/printnum                    — исполняемый файл
#   target/release/bundle/osx/PrintNum.app     — .app-бандл
#   target/release/bundle/dmg/PrintNum.dmg     — .dmg-образ
#
# Требования:
#   - Rust (rustup)
#   - Xcode Command Line Tools
#   - cargo-bundle:  cargo install cargo-bundle

set -euo pipefail
cd "$(dirname "$0")"

echo "[1/3] Обычный бинарник (target/release/printnum)..."
cargo build --release

echo
echo "[2/3] .app-бандл и .dmg..."
if command -v cargo-bundle >/dev/null 2>&1; then
    cargo bundle --release
    echo
    echo "Готово:"
    echo "  target/release/bundle/osx/PrintNum.app"
    echo "  target/release/bundle/dmg/PrintNum.dmg"
else
    echo "cargo-bundle не установлен — пропускаю .app/.dmg."
    echo "Установить: cargo install cargo-bundle"
    echo
    echo "Готово: target/release/printnum"
fi
