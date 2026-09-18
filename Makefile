# PrintNum — сборка приложения и расширения.
#
# Основные команды:
#   make            — собрать всё (приложение + расширение)
#   make app        — собрать только приложение (Rust)
#   make ext        — собрать только расширение
#   make run        — запустить приложение (dry-run)
#   make test       — тесты приложения
#   make clean      — очистить артефакты сборки
#   make help       — список всех команд
#
# Переменные:
#   PROFILE=debug|release   профиль сборки приложения (по умолчанию release)
#   TARGET=<triple>         target для приложения (например,
#                           x86_64-pc-windows-msvc для Windows)

APP_DIR   := src-printnum
EXT_DIR   := extension
PROFILE   ?= release

ifeq ($(PROFILE),release)
CARGO_FLAGS := --release
BIN_PATH    := $(APP_DIR)/target/release/printnum
else
CARGO_FLAGS :=
BIN_PATH    := $(APP_DIR)/target/debug/printnum
endif

# Если задан TARGET — добавляем --target и уточняем путь к бинарнику.
ifdef TARGET
CARGO_FLAGS += --target $(TARGET)
BIN_PATH    := $(APP_DIR)/target/$(TARGET)/$(PROFILE)/printnum
endif

.PHONY: all app ext ext-install ext-zip run run-dry test check clean clean-all help

## all: собрать приложение и расширение (по умолчанию)
all: app ext

## app: собрать приложение (Rust)
app:
	@echo "==> Сборка приложения ($(PROFILE)$(if $(TARGET), target=$(TARGET),))"
	cd $(APP_DIR) && cargo build $(CARGO_FLAGS)
	@echo "==> Готово: $(BIN_PATH)"

## ext-install: установить зависимости расширения (нужно один раз)
ext-install:
	@echo "==> Установка зависимостей расширения"
	cd $(EXT_DIR) && npm install

## ext: собрать расширение
ext:
	@echo "==> Сборка расширения"
	cd $(EXT_DIR) && npm run build
	@echo "==> Готово: $(EXT_DIR)/output/chrome-mv3"

## ext-zip: собрать и упаковать расширение в .zip
ext-zip:
	@echo "==> Сборка и упаковка расширения"
	cd $(EXT_DIR) && npm run zip
	@echo "==> Готово: $(EXT_DIR)/output/*.zip"

## run: собрать и запустить приложение
run: app
	@echo "==> Запуск приложения"
	$(BIN_PATH)

## run-dry: собрать и запустить приложение в режиме эмуляции печати
run-dry: app
	@echo "==> Запуск приложения в режиме эмуляции (dry-run)"
	$(BIN_PATH) --dry-run

## test: тесты приложения
test:
	@echo "==> Тесты приложения"
	cd $(APP_DIR) && cargo test

## check: проверить типы/сборку (без полной сборки)
check:
	@echo "==> Проверка приложения"
	cd $(APP_DIR) && cargo check $(CARGO_FLAGS)
	@echo "==> Проверка типов расширения"
	cd $(EXT_DIR) && npm run compile

## clean: очистить артефакты сборки
clean:
	@echo "==> Очистка"
	cd $(APP_DIR) && cargo clean
	rm -rf $(EXT_DIR)/output

## clean-all: очистка + удаление node_modules
clean-all: clean
	rm -rf $(EXT_DIR)/node_modules

## help: показать список команд
help:
	@echo "PrintNum — доступные команды:"
	@echo ""
	@echo "  make              собрать всё (приложение + расширение)"
	@echo "  make app          собрать только приложение (Rust)"
	@echo "  make ext          собрать только расширение"
	@echo "  make ext-install  установить зависимости расширения (один раз)"
	@echo "  make ext-zip      собрать и упаковать расширение в .zip"
	@echo "  make run          запустить приложение"
	@echo "  make run-dry      запустить приложение в режиме dry-run"
	@echo "  make test         тесты приложения"
	@echo "  make check        проверить типы/сборку"
	@echo "  make clean        очистить артефакты сборки"
	@echo "  make clean-all    очистка + удаление node_modules"
	@echo ""
	@echo "Переменные:"
	@echo "  PROFILE=debug|release   профиль сборки приложения (по умолчанию release)"
	@echo "  TARGET=<triple>         target для приложения"
	@echo ""
	@echo "Примеры:"
	@echo "  make app PROFILE=debug"
	@echo "  make app TARGET=x86_64-pc-windows-msvc"
