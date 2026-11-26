#!/bin/bash
# wine-ctl.sh — запуск/остановка/проверка PrintNum C-службы через Wine на macOS.
#
# Использование:
#   ./wine-ctl.sh start     # собрать (если нет exe) и запустить сервер в фоне
#   ./wine-ctl.sh stop      # остановить сервер (wineserver -k)
#   ./wine-ctl.sh restart   # stop + start
#   ./wine-ctl.sh status    # проверить, что на порту 5000 именно НАШ сервер
#   ./wine-ctl.sh logs      # показать log.txt из wine-префикса
#   ./wine-ctl.sh test      # прогнать smoke-тест эндпоинтов curl'ом
#   ./wine-ctl.sh reset     # удалить config.json в префиксе (дефолты при старте)
#
# Порядок: первый запуск создаёт префикс ~/.wine-printnum (~1-2 минуты).
#
# `test` не требует Wine: это обычные curl-запросы к уже запущенной службе.
# Адрес задаётся PRINTNUM_URL — можно проверить сборку на другой машине:
#
#   PRINTNUM_URL=http://192.168.1.20:5000 ./wine-ctl.sh test
#   PRINTNUM_URL=http://127.0.0.1:5000 ./wine-ctl.sh test   # Windows, exe запущен вручную

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export WINEPREFIX="${WINEPREFIX:-$HOME/.wine-printnum}"
export WINEDEBUG=-all

PORT=5000
# Адрес службы для проверок. `test` работает с любой машиной, не только с Wine.
BASE_URL="${PRINTNUM_URL:-http://127.0.0.1:$PORT}"
EXE_GUI="printnum-win7.exe"
EXE_DIAG="printnum-diag.exe"

# --- helpers ---------------------------------------------------------------

die() { echo "❌ $*" >&2; exit 1; }

need_wine() {
    command -v wine >/dev/null 2>&1 || \
        die "wine не найден. Установите: brew install --cask wine-stable"
}

# Путь к %APPDATA%\PrintNum внутри префикса (юзер в wine = macOS-юзер).
appdata_dir() {
    ls -d "$WINEPREFIX"/drive_c/users/*/AppData/Roaming/PrintNum 2>/dev/null | head -1
}

# Наш ли сервер на порту? AirPlay Receiver на macOS тоже слушает 5000 и
# отвечает 403 — отличаем по фирменному ответу {"status": true}.
our_server_up() {
    [ "$(curl -s -m 3 "$BASE_URL/" 2>/dev/null)" = '{"status": true}' ]
}

port_owner() {
    lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1}' | head -1
}

ensure_built() {
    [ -f "$EXE_DIAG" ] && [ -f "$EXE_GUI" ] && return 0
    echo "exe не найдены — собираю..."
    ./build.sh || die "сборка не удалась"
}

wait_up() {
    for i in $(seq 1 10); do
        if our_server_up; then return 0; fi
        sleep 2
    done
    return 1
}

# --- commands --------------------------------------------------------------

cmd_start() {
    need_wine
    ensure_built

    if our_server_up; then
        echo "✅ Сервер уже запущен: http://127.0.0.1:$PORT"
        return 0
    fi

    owner="$(port_owner)"
    if [ -n "$owner" ]; then
        echo "⚠️  Порт $PORT занят процессом '$owner'."
        echo "   Если это ControlCenter (AirPlay Receiver на macOS) — наш сервер"
        echo "   всё равно сможет забиндить 127.0.0.1:$PORT (более специфичный bind)."
    fi

    # Первый запуск — инициализация префикса.
    if [ ! -d "$WINEPREFIX/drive_c" ]; then
        echo "Первый запуск: инициализация префикса $WINEPREFIX ..."
        wine wineboot --init >/dev/null 2>&1
    fi

    echo "Запуск $EXE_DIAG через Wine (префикс: $WINEPREFIX)..."
    nohup wine "$EXE_DIAG" > /tmp/printnum-wine.log 2>&1 &
    disown

    if wait_up; then
        echo "✅ Сервер поднялся: http://127.0.0.1:$PORT"
        curl -s "http://127.0.0.1:$PORT/config"
        echo ""
    else
        echo "❌ Сервер не отвечает на 127.0.0.1:$PORT за 20 секунд."
        echo "   Лог wine: /tmp/printnum-wine.log (последние строки):"
        tail -5 /tmp/printnum-wine.log 2>/dev/null | sed 's/^/   /'
        d="$(appdata_dir)"; [ -n "$d" ] && { echo "   Лог службы:"; tail -5 "$d/log.txt" | sed 's/^/   /'; }
        exit 1
    fi
}

cmd_stop() {
    if command -v wineserver >/dev/null 2>&1; then
        wineserver -k 2>/dev/null
        sleep 1
    fi
    if our_server_up; then
        die "сервер всё ещё отвечает — что-то пошло не так"
    fi
    echo "✅ Сервер остановлен"
}

cmd_status() {
    if our_server_up; then
        echo "✅ НАШ сервер слушает http://127.0.0.1:$PORT"
        curl -s "http://127.0.0.1:$PORT/config"; echo ""
    else
        owner="$(port_owner)"
        if [ "$owner" = "ControlCe" ] || [ "$owner" = "ControlCenter" ]; then
            echo "❌ На порту $PORT — AirPlay Receiver (macOS), наш сервер НЕ запущен."
            echo "   Запустите: $0 start"
        elif [ -n "$owner" ]; then
            echo "❌ Порт $PORT занят процессом '$owner' (не наш сервер)."
        else
            echo "❌ Сервер не запущен. Запустите: $0 start"
        fi
        exit 1
    fi
}

cmd_logs() {
    d="$(appdata_dir)"
    [ -n "$d" ] && [ -f "$d/log.txt" ] || die "лог не найден (сервер ни разу не запускался?)"
    echo "=== $d/log.txt ==="
    cat "$d/log.txt"
}

cmd_reset() {
    d="$(appdata_dir)"
    if [ -n "$d" ] && [ -f "$d/config.json" ]; then
        rm -f "$d/config.json"
        echo "✅ config.json удалён — при следующем запуске будут дефолты (paper 43*25)"
    else
        echo "config.json в префиксе отсутствует — уже дефолты"
    fi
}

cmd_test() {
    our_server_up || die "служба не отвечает на $BASE_URL/
   Запустите её: $0 start (Wine) или printnum-win7.exe (Windows);
   для чужой машины: PRINTNUM_URL=http://host:5000 $0 test"
    [ "$BASE_URL" = "http://127.0.0.1:$PORT" ] || echo "Проверяю: $BASE_URL"

    local pass=0 fail=0
    t() { # t <описание> <ожидаемый_код> <метод> <путь> [тело]
        local name="$1" want="$2" method="$3" path="$4" body="${5:-}"
        local args=(-s -o /tmp/pn-test-body -w "%{http_code}" -X "$method")
        [ -n "$body" ] && args+=(-H "Content-Type: application/json" -d "$body")
        local code
        code="$(curl -m 5 "${args[@]}" "$BASE_URL$path")"
        if [ "$code" = "$want" ]; then
            printf "  ✅ %-26s HTTP %s\n" "$name" "$code"; pass=$((pass+1))
        else
            printf "  ❌ %-26s HTTP %s (ожидали %s): %s\n" \
                "$name" "$code" "$want" "$(head -c 80 /tmp/pn-test-body)"
            fail=$((fail+1))
        fi
    }

    echo "Smoke-тест эндпоинтов:"
    t "GET /"                200 GET  /
    t "GET /config"          200 GET  /config
    t "GET /papers"          200 GET  /papers
    t "GET /listPrinters"    200 GET  /listPrinters
    t "GET /status-printer"  200 GET  /status-printer
    t "GET /service"         200 GET  /service
    t "POST /config"         200 POST /config '{"paper":"43*25"}'

    # Полка (-88) должна пройти валидацию /print-number и упереться
    # в проверку готовности, а не в 400. Поэтому временно выключаем службу.
    t "config running=false" 200 POST /config '{"running":false}'
    t "shelf -88 (валидна)"  503 POST /print-number '{"text":"-88"}'
    # Ограничение: не больше 4 цифр в номере ячейки (максимум 9999).
    t "cell 1234 (валидна)"  503 POST /print-number '{"text":"1234"}'
    t "cell 12345 (>4)"      400 POST /print-number '{"text":"12345"}'
    t "cell 1234-1234"       503 POST /print-number '{"text":"1234-1234"}'
    t "cell 12345-1 (>4)"    400 POST /print-number '{"text":"12345-1"}'
    t "cell 1-12345 (>4)"    400 POST /print-number '{"text":"1-12345"}'
    t "shelf -12345 (>4)"    400 POST /print-number '{"text":"-12345"}'

    t "config running=true"  200 POST /config '{"running":true}'

    t "print Возврат-1"      400 POST /print-number '{"text":"Возврат-1"}'
    t "print Прямой поток-5" 400 POST /print-number '{"text":"Прямой поток - 5"}'
    t "print ii-штрихкод"    400 POST /print-number '{"text":"ii18725308927"}'
    t "print ---"            400 POST /print-number '{"text":"---"}'
    t "print пусто"          400 POST /print-number '{"text":""}'
    t "shelf --"             400 POST /print-number '{"text":"--"}'
    t "shelf -"              400 POST /print-number '{"text":"-"}'
    t "shelf -8a"            400 POST /print-number '{"text":"-8a"}'
    t "OPTIONS preflight"    204 OPTIONS /config
    t "404"                  404 GET  /nonexistent

    # Возможности API: расширение проверяет их перед печатью полок.
    if curl -s -m 5 "$BASE_URL/config" | grep -q '"shelf-dash"'; then
        printf "  ✅ %-26s\n" "features shelf-dash"; pass=$((pass+1))
    else
        printf "  ❌ %-26s\n" "features shelf-dash"; fail=$((fail+1))
    fi
    echo ""
    echo "Итого: $pass passed, $fail failed"
    [ "$fail" -eq 0 ]
}

# --- main ------------------------------------------------------------------

case "${1:-}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_stop; cmd_start ;;
    status)  cmd_status ;;
    logs)    cmd_logs ;;
    reset)   cmd_reset ;;
    test)    cmd_test ;;
    *)
        echo "Использование: $0 {start|stop|restart|status|logs|reset|test}"
        exit 2
        ;;
esac
