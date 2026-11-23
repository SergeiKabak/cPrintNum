// printnum-win7.c — PrintNum в виде чистой службы для Windows 7 x64.
//
// Один файл, без CRT (-nostartfiles -nodefaultlibs), только системные DLL.
// Заменяет Rust-версию printnum.exe на машинах, где нельзя собрать Rust.
//
// Режим работы: HTTP-сервер на 127.0.0.1:5000 (Winsock), управляется
// браузерным расширением. Контракт API 1:1 с Rust-сервером (server.rs):
//
//   GET  /                  -> {"status": true}
//   GET  /status-printer    -> {"printerOnline": bool}
//   GET  /listPrinters      -> {"listPrinters": [...]}
//   GET  /papers            -> {"papers": [...]}
//   GET  /config            -> полный конфиг
//   GET  /service           -> {"installed": bool}
//   POST /config            -> частичный JSON, возвращает полный конфиг
//   POST /print-number      -> "OK"  (тело: {"text": "..."})
//   POST /print-barcode     -> "OK"  (тело: {"text", "moduleMm", "heightMm"})
//   POST /service/install   -> {"ok": true, "path": "..."}
//   POST /service/uninstall -> {"ok": true}
//   OPTIONS *               -> 204 (CORS preflight)
//
// Конфиг: %APPDATA%\PrintNum\config.json (совместим с Rust/Python версиями).
// Автозагрузка: %APPDATA%\...\Startup\PrintNum.cmd (без прав администратора).
//
// Сборка (см. build.sh):
//   x86_64-w64-mingw32-gcc -mwindows -municode -O2 -s printnum-win7.c
//     -o printnum-win7.exe
//     -lkernel32 -luser32 -lgdi32 -lwinspool -lws2_32 -lshell32

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winspool.h>     // PRINTER_INFO_2, PRINTER_STATUS_*
#include <shellapi.h>     // CommandLineToArgvW
#include <winsock2.h>
#include <ws2tcpip.h>

#define DEFAULT_PORT 5000
#define MAX_PAPERS   16
#define JSON_MAX     8192
#define BODY_MAX     4096

// CREATE_PROCESS флаг: не показывать окно консоли у службы.
#define CREATE_NO_WINDOW_FLAG 0x08000000u

// ============================================================
// Мини-утилиты wide-строк (CRT запрещён)
// ============================================================

static int slen(const wchar_t *s) {
    int n = 0;
    while (s[n]) n++;
    return n;
}

static void scpy(wchar_t *dst, int cap, const wchar_t *src) {
    int i = 0;
    if (cap <= 0) return;
    for (; i < cap - 1 && src[i]; i++) dst[i] = src[i];
    dst[i] = 0;
}

static void scat(wchar_t *dst, int cap, const wchar_t *src) {
    int n = slen(dst);
    scpy(dst + n, cap - n, src);
}

static BOOL seq(const wchar_t *a, const wchar_t *b) {
    int i = 0;
    while (a[i] && b[i] && a[i] == b[i]) i++;
    return a[i] == 0 && b[i] == 0;
}

static BOOL sascii(const wchar_t *a, const char *b) {
    int i = 0;
    while (a[i] && b[i] && a[i] == (wchar_t)(unsigned char)b[i]) i++;
    return a[i] == 0 && b[i] == 0;
}

static const wchar_t *sstr(const wchar_t *hay, const wchar_t *needle) {
    if (!*needle) return hay;
    for (const wchar_t *p = hay; *p; p++) {
        const wchar_t *h = p, *n = needle;
        while (*h && *n && *h == *n) { h++; n++; }
        if (!*n) return p;
    }
    return NULL;
}

static long long stoi(const wchar_t *s) {
    long long v = 0;
    BOOL neg = FALSE;
    if (*s == L'-') { neg = TRUE; s++; }
    while (*s >= L'0' && *s <= L'9') { v = v * 10 + (*s - L'0'); s++; }
    return neg ? -v : v;
}


static void itos(long long v, wchar_t *out, int cap) {
    wchar_t tmp[32];
    int i = 0, j = 0;
    BOOL neg = v < 0;
    unsigned long long u = neg ? (unsigned long long)(-v) : (unsigned long long)v;
    if (u == 0) tmp[i++] = L'0';
    while (u > 0) { tmp[i++] = L'0' + (wchar_t)(u % 10); u /= 10; }
    if (neg && j < cap - 1) out[j++] = L'-';
    while (i > 0 && j < cap - 1) out[j++] = tmp[--i];
    out[j] = 0;
}

static BOOL utf8_to_wide(const char *src, int src_bytes, wchar_t *dst, int dst_cap) {
    int n = MultiByteToWideChar(CP_UTF8, 0, src, src_bytes, dst, dst_cap - 1);
    if (n <= 0) { if (dst_cap > 0) dst[0] = 0; return FALSE; }
    dst[n] = 0;
    return TRUE;
}

static BOOL wide_to_utf8(const wchar_t *src, char *dst, int dst_cap) {
    int n = WideCharToMultiByte(CP_UTF8, 0, src, -1, dst, dst_cap - 1, NULL, NULL);
    if (n <= 0) { if (dst_cap > 0) dst[0] = 0; return FALSE; }
    return TRUE;
}

// Экранирование для встраивания в JSON (кавычки и обратные слэши).
static void jesc(const wchar_t *src, wchar_t *dst, int cap) {
    int j = 0;
    for (int i = 0; src[i] && j < cap - 3; i++) {
        if (src[i] == L'\\' || src[i] == L'"') dst[j++] = L'\\';
        dst[j++] = src[i];
    }
    dst[j] = 0;
}

// ============================================================
// Конфигурация
// ============================================================

typedef struct {
    wchar_t printer[256];
    wchar_t paper[32];
    BOOL    id_num;
    BOOL    end_line;
    BOOL    hybrid;
    BOOL    checker;        // шахматная заливка цифры (экономия термоголовки)
    long    checker_mm_x10; // размер клетки шахматки, 0.1 мм (10 = 1.0 мм)
    BOOL    outline;        // сплошная обводка по контуру цифры
    long    outline_mm_x10; // толщина обводки, 0.1 мм (5 = 0.5 мм)
    long    expand;
    BOOL    running;
    wchar_t papers[MAX_PAPERS][32];
    int     papers_count;
} Config;

static Config g_cfg;

static void cfg_defaults(Config *c) {
    c->printer[0] = 0;
    scpy(c->paper, 32, L"43*25");
    c->id_num = FALSE;
    c->end_line = FALSE;
    c->hybrid = FALSE;
    c->checker = FALSE;          // по умолчанию сплошная заливка (как раньше)
    c->checker_mm_x10 = 10;      // 1.0 мм клетка шахматки
    c->outline = TRUE;           // обводка по контуру включена
    c->outline_mm_x10 = 5;       // 0.5 мм тонкая линия
    c->expand = 500;
    c->running = TRUE;
    static const wchar_t *def[] = {
        L"43*25", L"30*20", L"40*30", L"50*70",
        L"58*40", L"60*40", L"75*120", L"100*150",
    };
    c->papers_count = 8;
    for (int i = 0; i < c->papers_count; i++)
        scpy(c->papers[i], 32, def[i]);
}

static void app_dir(wchar_t *out, int cap) {
    wchar_t appdata[MAX_PATH];
    out[0] = 0;
    if (!GetEnvironmentVariableW(L"APPDATA", appdata, MAX_PATH)) return;
    scpy(out, cap, appdata);
    scat(out, cap, L"\\PrintNum");
    CreateDirectoryW(out, NULL);
}

static void cfg_path(wchar_t *out, int cap) {
    wchar_t dir[MAX_PATH];
    app_dir(dir, MAX_PATH);
    scpy(out, cap, dir);
    scat(out, cap, L"\\config.json");
}

static BOOL read_text_file(const wchar_t *path, wchar_t *out, int out_cap) {
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return FALSE;
    static char buf[JSON_MAX];
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, JSON_MAX - 1, &got, NULL);
    CloseHandle(h);
    if (!ok || got == 0) return FALSE;
    buf[got] = 0;
    return utf8_to_wide(buf, (int)got, out, out_cap);
}

static void write_text_file(const wchar_t *path, const wchar_t *text) {
    static char buf[JSON_MAX];
    if (!wide_to_utf8(text, buf, JSON_MAX)) return;
    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD need = 0;
    while (buf[need]) need++;
    DWORD wrote = 0;
    WriteFile(h, buf, need, &wrote, NULL);
    CloseHandle(h);
}

// --- Логирование в файл ---

// Пишет строку в %APPDATA%\PrintNum\log.txt (UTF-8, добавление в конец).
static void log_line(const wchar_t *msg) {
    // Путь к логу считаем один раз (кеш) — не дёргаем APPDATA/CreateDirectory
    // на каждую строку.
    static wchar_t path[MAX_PATH];
    static int path_ready = 0;
    if (!path_ready) {
        wchar_t dir[MAX_PATH];
        app_dir(dir, MAX_PATH);
        if (dir[0]) {
            scpy(path, MAX_PATH, dir);
            scat(path, MAX_PATH, L"\\log.txt");
        }
        path_ready = 1;
    }
    if (!path[0]) return; // нет APPDATA — логировать некуда

    HANDLE h = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ, NULL,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;

    SYSTEMTIME st;
    GetLocalTime(&st);
    wchar_t line[JSON_MAX];
    wsprintfW(line, L"[%02d.%02d.%04d %02d:%02d:%02d] %s\r\n",
              st.wDay, st.wMonth, st.wYear,
              st.wHour, st.wMinute, st.wSecond, msg);

    static char buf[JSON_MAX];
    if (wide_to_utf8(line, buf, JSON_MAX)) {
        DWORD need = 0;
        while (buf[need]) need++;
        DWORD wrote = 0;
        WriteFile(h, buf, need, &wrote, NULL);
    }
    CloseHandle(h);
}

// --- Мини-JSON парсер (чтение) ---

// Позиция значения ключа: после `"key":` с пробелами.
static const wchar_t *json_key(const wchar_t *json, const wchar_t *key) {
    wchar_t pat[96];
    scpy(pat, 96, L"\"");
    scat(pat, 96, key);
    scat(pat, 96, L"\"");
    const wchar_t *p = sstr(json, pat);
    if (!p) return NULL;
    p += slen(pat);
    while (*p == L' ' || *p == L':' || *p == L'\n' || *p == L'\r' || *p == L'\t') p++;
    return p;
}

static BOOL json_str(const wchar_t *json, const wchar_t *key, wchar_t *out, int cap) {
    const wchar_t *p = json_key(json, key);
    if (!p || *p != L'"') return FALSE;
    p++;
    int i = 0;
    while (*p && *p != L'"' && i < cap - 1) out[i++] = *p++;
    out[i] = 0;
    return TRUE;
}

static BOOL json_bool(const wchar_t *json, const wchar_t *key, BOOL *out) {
    const wchar_t *p = json_key(json, key);
    if (!p) return FALSE;
    if (p[0] == L't' && p[1] == L'r' && p[2] == L'u' && p[3] == L'e') { *out = TRUE; return TRUE; }
    if (p[0] == L'f' && p[1] == L'a' && p[2] == L'l' && p[3] == L's' && p[4] == L'e') { *out = FALSE; return TRUE; }
    return FALSE;
}

static BOOL json_long(const wchar_t *json, const wchar_t *key, long *out) {
    const wchar_t *p = json_key(json, key);
    if (!p) return FALSE;
    if (*p == L'"') p++;                       // значение в кавычках тоже берём
    if (*p < L'0' || *p > L'9') return FALSE;
    *out = (long)stoi(p);
    return TRUE;
}

// Дробное значение (moduleMm, heightMm): [-]digits[.digits]
static BOOL json_double(const wchar_t *json, const wchar_t *key, double *out) {
    const wchar_t *p = json_key(json, key);
    if (!p) return FALSE;
    if (*p == L'"') p++;
    BOOL neg = FALSE, any = FALSE;
    double v = 0.0, frac = 0.1;
    if (*p == L'-') { neg = TRUE; p++; }
    while (*p >= L'0' && *p <= L'9') { v = v * 10.0 + (double)(*p - L'0'); any = TRUE; p++; }
    if (*p == L'.') {
        p++;
        while (*p >= L'0' && *p <= L'9') {
            v += (double)(*p - L'0') * frac;
            frac *= 0.1;
            any = TRUE;
            p++;
        }
    }
    if (!any) return FALSE;
    *out = neg ? -v : v;
    return TRUE;
}


// Массив строк "papers": ["30*20", ...]
static BOOL json_papers(const wchar_t *json, Config *c) {
    const wchar_t *p = json_key(json, L"papers");
    if (!p || *p != L'[') return FALSE;
    p++;
    int count = 0;
    while (*p && *p != L']' && count < MAX_PAPERS) {
        while (*p == L' ' || *p == L',' || *p == L'\n' || *p == L'\r' || *p == L'\t') p++;
        if (*p == L'"') {
            p++;
            int i = 0;
            while (*p && *p != L'"' && i < 31) {
                // Убираем пробелы по краям значения.
                c->papers[count][i++] = *p++;
            }
            c->papers[count][i] = 0;
            count++;
            while (*p && *p != L'"') p++;
            if (*p) p++;
        } else if (*p) {
            p++;
        }
    }
    if (count > 0) c->papers_count = count;
    return TRUE;
}

static void cfg_load(void) {
    cfg_defaults(&g_cfg);
    wchar_t path[MAX_PATH];
    cfg_path(path, MAX_PATH);

    static wchar_t json[JSON_MAX];
    if (!read_text_file(path, json, JSON_MAX)) {
        wchar_t m[MAX_PATH + 64];
        scpy(m, MAX_PATH + 64, L"cfg_load: не удалось прочитать ");
        scat(m, MAX_PATH + 64, path);
        log_line(m);
        return;
    }

    wchar_t tmp[256];
    if (json_str(json, L"printer", tmp, 256)) scpy(g_cfg.printer, 256, tmp);
    if (json_str(json, L"paper", tmp, 32))    scpy(g_cfg.paper, 32, tmp);
    json_bool(json, L"idNum",   &g_cfg.id_num);
    json_bool(json, L"endLine", &g_cfg.end_line);
    json_bool(json, L"hybrid",  &g_cfg.hybrid);
    json_bool(json, L"checker", &g_cfg.checker);
    {
        long v = g_cfg.checker_mm_x10;
        if (json_long(json, L"checkerMm", &v)) g_cfg.checker_mm_x10 = v < 1 ? 1 : v;
    }
    json_bool(json, L"outline", &g_cfg.outline);
    {
        long v = g_cfg.outline_mm_x10;
        if (json_long(json, L"outlineMm", &v)) g_cfg.outline_mm_x10 = v < 1 ? 1 : v;
    }
    json_bool(json, L"running", &g_cfg.running);
    {
        long e = g_cfg.expand;
        if (json_long(json, L"expand", &e)) g_cfg.expand = e < 1 ? 1 : e;
    }
    json_papers(json, &g_cfg);
}

// --- Мини-JSON сериализация (запись) ---

static void cfg_to_json(Config *c, wchar_t *out, int cap) {
    wchar_t esc[512];
    wchar_t num[32];
    out[0] = 0;

    scat(out, cap, L"{\"printer\":\"");
    jesc(c->printer, esc, 512); scat(out, cap, esc);
    scat(out, cap, L"\",\"paper\":\"");
    jesc(c->paper, esc, 512); scat(out, cap, esc);
    scat(out, cap, L"\",\"idNum\":");
    scat(out, cap, c->id_num ? L"true" : L"false");
    scat(out, cap, L",\"endLine\":");
    scat(out, cap, c->end_line ? L"true" : L"false");
    scat(out, cap, L",\"hybrid\":");
    scat(out, cap, c->hybrid ? L"true" : L"false");
    scat(out, cap, L",\"checker\":");
    scat(out, cap, c->checker ? L"true" : L"false");
    itos(c->checker_mm_x10, num, 32);
    scat(out, cap, L",\"checkerMm\":");
    scat(out, cap, num);
    scat(out, cap, L",\"outline\":");
    scat(out, cap, c->outline ? L"true" : L"false");
    itos(c->outline_mm_x10, num, 32);
    scat(out, cap, L",\"outlineMm\":");
    scat(out, cap, num);
    itos(c->expand, num, 32);
    scat(out, cap, L",\"expand\":");
    scat(out, cap, num);
    scat(out, cap, L",\"running\":");
    scat(out, cap, c->running ? L"true" : L"false");
    scat(out, cap, L",\"papers\":[");

    for (int i = 0; i < c->papers_count; i++) {
        if (i) scat(out, cap, L",");
        scat(out, cap, L"\"");
        jesc(c->papers[i], esc, 512);
        scat(out, cap, esc);
        scat(out, cap, L"\"");
    }
    scat(out, cap, L"]}");
}

// Применение частичного JSON из расширения: меняются только переданные ключи.
static void cfg_apply_json(const wchar_t *body) {
    wchar_t tmp[256];
    if (json_str(body, L"printer", tmp, 256)) scpy(g_cfg.printer, 256, tmp);
    if (json_str(body, L"paper", tmp, 32))    scpy(g_cfg.paper, 32, tmp);
    json_bool(body, L"idNum",   &g_cfg.id_num);
    json_bool(body, L"endLine", &g_cfg.end_line);
    json_bool(body, L"hybrid",  &g_cfg.hybrid);
    json_bool(body, L"checker", &g_cfg.checker);
    {
        long v = g_cfg.checker_mm_x10;
        if (json_long(body, L"checkerMm", &v)) g_cfg.checker_mm_x10 = v < 1 ? 1 : v;
    }
    json_bool(body, L"outline", &g_cfg.outline);
    {
        long v = g_cfg.outline_mm_x10;
        if (json_long(body, L"outlineMm", &v)) g_cfg.outline_mm_x10 = v < 1 ? 1 : v;
    }
    json_bool(body, L"running", &g_cfg.running);
    {
        long e;
        if (json_long(body, L"expand", &e)) g_cfg.expand = e < 1 ? 1 : e;
    }
    json_papers(body, &g_cfg);
}

static void cfg_save(void) {
    wchar_t path[MAX_PATH];
    cfg_path(path, MAX_PATH);
    static wchar_t json[JSON_MAX];
    cfg_to_json(&g_cfg, json, JSON_MAX);
    write_text_file(path, json);
}

// ============================================================
// Принтеры (Win32 Spooler API, аналог printer.rs)
// ============================================================

// Список локальных и подключённых принтеров (EnumPrintersW, level 4).
static int list_printers(wchar_t out[][256], int max_count) {
    DWORD needed = 0, returned = 0;
    EnumPrintersW(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS, NULL, 4,
                  NULL, 0, &needed, &returned);
    if (needed == 0) return 0;

    static unsigned char buf[4096];
    if (needed > sizeof(buf)) needed = sizeof(buf);
    if (!EnumPrintersW(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS, NULL, 4,
                       buf, needed, &needed, &returned))
        return 0;

    PRINTER_INFO_4W *info = (PRINTER_INFO_4W *)buf;
    int count = 0;
    for (DWORD i = 0; i < returned && count < max_count; i++) {
        if (info[i].pPrinterName && info[i].pPrinterName[0]) {
            scpy(out[count], 256, info[i].pPrinterName);
            count++;
        }
    }
    return count;
}

// Доступен ли принтер: OpenPrinter + GetPrinter(level 2) + флаги статуса.
static BOOL status_printer(const wchar_t *name) {
    HANDLE h = NULL;
    PRINTER_DEFAULTSW pd;
    pd.pDatatype = NULL;
    pd.pDevMode = NULL;
    pd.DesiredAccess = PRINTER_ACCESS_USE;
    if (!OpenPrinterW((LPWSTR)name, &h, &pd)) return FALSE;

    DWORD needed = 0;
    GetPrinterW(h, 2, NULL, 0, &needed);
    if (needed == 0) { ClosePrinter(h); return FALSE; }

    static unsigned char buf[4096];
    if (needed > sizeof(buf)) needed = sizeof(buf);
    BOOL ok = GetPrinterW(h, 2, buf, needed, &needed);
    ClosePrinter(h);
    if (!ok) return FALSE;

    PRINTER_INFO_2W *p2 = (PRINTER_INFO_2W *)buf;
    const DWORD status = p2->Status;
    const DWORD attr = p2->Attributes;

    if (attr & 0x00000400) return FALSE;              // WORK_OFFLINE
    if (status & PRINTER_STATUS_ERROR) return FALSE;
    if (status & PRINTER_STATUS_OFFLINE) return FALSE;
    if (status & PRINTER_STATUS_PAPER_JAM) return FALSE;
    if (status & PRINTER_STATUS_PAPER_OUT) return FALSE;
    return TRUE;
}

// ============================================================
// Автозагрузка (аналог service.rs)
// ============================================================

static void autostart_path(wchar_t *out, int cap) {
    wchar_t appdata[MAX_PATH];
    out[0] = 0;
    if (!GetEnvironmentVariableW(L"APPDATA", appdata, MAX_PATH)) return;
    scpy(out, cap, appdata);
    scat(out, cap,
         L"\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\PrintNum.cmd");
}

static BOOL autostart_installed(void) {
    wchar_t path[MAX_PATH];
    autostart_path(path, MAX_PATH);
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

static BOOL install_autostart(wchar_t *out_path, int cap) {
    wchar_t exe[MAX_PATH];
    GetModuleFileNameW(NULL, exe, MAX_PATH);

    wchar_t path[MAX_PATH];
    autostart_path(path, MAX_PATH);
    if (out_path) scpy(out_path, cap, path);

    static wchar_t cmd[1024];
    cmd[0] = 0;
    scat(cmd, 1024, L"@echo off\r\nstart \"\" /min \"");
    scat(cmd, 1024, exe);
    scat(cmd, 1024, L"\" --service\r\n");

    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return FALSE;
    static char utf8[2048];
    wide_to_utf8(cmd, utf8, 2048);
    DWORD need = 0;
    while (utf8[need]) need++;
    DWORD wrote = 0;
    WriteFile(h, utf8, need, &wrote, NULL);
    CloseHandle(h);
    return TRUE;
}

static BOOL uninstall_autostart(void) {
    wchar_t path[MAX_PATH];
    autostart_path(path, MAX_PATH);
    if (GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES) return TRUE;
    return DeleteFileW(path) != 0;
}

// Запуск самого себя с --service в отдельном процессе без окна.
static BOOL spawn_detached_service(void) {
    wchar_t exe[MAX_PATH];
    GetModuleFileNameW(NULL, exe, MAX_PATH);

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    int i = 0;
    while (i < (int)sizeof(si)) ((unsigned char *)&si)[i++] = 0;
    i = 0;
    while (i < (int)sizeof(pi)) ((unsigned char *)&pi)[i++] = 0;
    si.cb = sizeof(si);

    // Командная строка: "exe" --service
    static wchar_t cmdline[1100];
    cmdline[0] = 0;
    scat(cmdline, 1100, L"\"");
    scat(cmdline, 1100, exe);
    scat(cmdline, 1100, L"\" --service");

    return CreateProcessW(NULL, cmdline, NULL, NULL, FALSE,
                          CREATE_NO_WINDOW_FLAG, NULL, NULL, &si, &pi);
}

// ============================================================
// Бизнес-логика этикетки (аналог prepare_label_data из print.rs)
// ============================================================

typedef struct {
    wchar_t main_text[256];
    wchar_t header_text[256];
    BOOL    show_header;
    BOOL    force_left_header;
    BOOL    is_underlined;
    BOOL    is_bold;
} LabelData;

static BOOL is_all_digits(const wchar_t *s) {
    if (!s[0]) return FALSE;
    for (int i = 0; s[i]; i++)
        if (s[i] < L'0' || s[i] > L'9') return FALSE;
    return TRUE;
}

// Проверка "КГТ-N" (и "кгт-N").
static BOOL is_kgt(const wchar_t *main, const wchar_t *header) {
    BOOL kgt = (main[0] == L'К' || main[0] == L'к') &&
               (main[1] == L'Г' || main[1] == L'г') &&
               (main[2] == L'Т' || main[2] == L'т') && main[3] == 0;
    return kgt && header[0] && is_all_digits(header);
}

static void prepare_label_data(const wchar_t *text, const Config *c, LabelData *d) {
    wchar_t raw_main[256], raw_header[256];
    raw_main[0] = 0;
    raw_header[0] = 0;

    // Разбиваем по первому дефису.
    const wchar_t *dash = text;
    while (*dash && *dash != L'-') dash++;
    if (*dash == L'-') {
        int n = (int)(dash - text);
        int i = 0;
        for (; i < n && i < 255; i++) raw_main[i] = text[i];
        raw_main[i] = 0;
        scpy(raw_header, 256, dash + 1);
    } else {
        scpy(raw_main, 256, text);
    }

    BOOL numeric = is_all_digits(raw_main);
    long long main_val = numeric ? stoi(raw_main) : 0;
    BOOL bold = (c->hybrid && numeric && main_val >= (long long)c->expand)
                || is_kgt(raw_main, raw_header);

    if (bold) {
        // Рокировка: КГТ -> header, номер -> main.
        scpy(d->header_text, 256, raw_main);
        scpy(d->main_text, 256, raw_header);
        d->force_left_header = TRUE;
        d->show_header = TRUE;
    } else {
        scpy(d->main_text, 256, raw_main);
        d->show_header = raw_header[0] && c->id_num;
        if (d->show_header) scpy(d->header_text, 256, raw_header);
        else d->header_text[0] = 0;
        d->force_left_header = FALSE;
    }

    // Дефис у header (слева/справа по рокировке).
    if (d->show_header && d->header_text[0]) {
        static wchar_t t[260];
        t[0] = 0;
        if (d->force_left_header) { scat(t, 260, d->header_text); scat(t, 260, L"-"); }
        else                      { scat(t, 260, L"-"); scat(t, 260, d->header_text); }
        scpy(d->header_text, 256, t);
    }

    // endLine -> подчёркивание, иначе точка в конце.
    if (c->end_line) {
        d->is_underlined = TRUE;
    } else {
        d->is_underlined = FALSE;
        static wchar_t t[260];
        t[0] = 0;
        scat(t, 260, d->main_text);
        scat(t, 260, L".");
        scpy(d->main_text, 256, t);
    }
    d->is_bold = bold;
}

// ============================================================
// Штрихкоды Code128 (порт barcode.rs: Auto B/C)
// ============================================================

// Паттерны 0..105: по 6 чисел — ширины чередующихся штрихов/пробелов.
static const unsigned char PATTERNS[106][6] = {
    {2,1,2,2,2,2},{2,2,2,1,2,2},{2,2,2,2,2,1},{1,2,1,2,2,3},
    {1,2,1,3,2,2},{1,3,1,2,2,2},{1,2,2,2,1,3},{1,2,2,3,1,2},
    {1,3,2,2,1,2},{2,2,1,2,1,3},{2,2,1,3,1,2},{2,3,1,2,1,2},
    {1,1,2,2,3,2},{1,2,2,1,3,2},{1,2,2,2,3,1},{1,1,3,2,2,2},
    {1,2,3,1,2,2},{1,2,3,2,2,1},{2,2,3,2,1,1},{2,2,1,1,3,2},
    {2,2,1,2,3,1},{2,1,3,2,1,2},{2,2,3,1,1,2},{3,1,2,1,3,1},
    {3,1,1,2,2,2},{3,2,1,1,2,2},{3,2,1,2,2,1},{3,1,2,2,1,2},
    {3,2,2,1,1,2},{3,2,2,2,1,1},{2,1,2,1,2,3},{2,1,2,3,2,1},
    {2,3,2,1,2,1},{1,1,1,3,2,3},{1,3,1,1,2,3},{1,3,1,3,2,1},
    {1,1,2,3,1,3},{1,3,2,1,1,3},{1,3,2,3,1,1},{2,1,1,3,1,3},
    {2,3,1,1,1,3},{2,3,1,3,1,1},{1,1,2,1,3,3},{1,1,2,3,3,1},
    {1,3,2,1,3,1},{1,1,3,1,2,3},{1,1,3,3,2,1},{1,3,3,1,2,1},
    {3,1,3,1,2,1},{2,1,1,3,3,1},{2,3,1,1,3,1},{2,1,3,1,1,3},
    {2,1,3,3,1,1},{2,1,3,1,3,1},{3,1,1,1,2,3},{3,1,1,3,2,1},
    {3,3,1,1,2,1},{3,1,2,1,1,3},{3,1,2,3,1,1},{3,3,2,1,1,1},
    {3,1,4,1,1,1},{2,2,1,4,1,1},{4,3,1,1,1,1},{1,1,1,2,2,4},
    {1,1,1,4,2,2},{1,2,1,1,2,4},{1,2,1,4,2,1},{1,4,1,1,2,2},
    {1,4,1,2,2,1},{1,1,2,2,1,4},{1,1,2,4,1,2},{1,2,2,1,1,4},
    {1,2,2,4,1,1},{1,4,2,1,1,2},{1,4,2,2,1,1},{2,4,1,2,1,1},
    {2,2,1,1,1,4},{4,1,3,1,1,1},{2,4,1,1,1,2},{1,3,4,1,1,1},
    {1,1,1,2,4,2},{1,2,1,1,4,2},{1,2,1,2,4,1},{1,1,4,2,1,2},
    {1,2,4,1,1,2},{1,2,4,2,1,1},{4,1,1,2,1,2},{4,2,1,1,1,2},
    {4,2,1,2,1,1},{2,1,2,1,4,1},{2,1,4,1,2,1},{4,1,2,1,2,1},
    {1,1,1,1,4,3},{1,1,1,3,4,1},{1,3,1,1,4,1},{1,1,4,1,1,3},
    {1,1,4,3,1,1},{4,1,1,1,1,3},{4,1,1,3,1,1},{1,1,3,1,4,1},
    {1,1,4,1,3,1},{3,1,1,1,4,1},{4,1,1,1,3,1},{2,1,1,4,1,2},
    {2,1,1,2,1,4},{2,1,1,2,3,2},
};
static const unsigned char STOP_PATTERN[7] = {2,3,3,1,1,1,2};

#define BC_START_B 104
#define BC_START_C 105
#define BC_CODE_B  100
#define BC_CODE_C  99
#define BC_MAX_TEXT 64          // ii + 11 цифр — с большим запасом
#define BC_MAX_MOD  1024        // (1 + 64 + 1) * 11 + 13 = 739 максимум

typedef struct {
    unsigned char modules[BC_MAX_MOD];  // 1 = штрих, 0 = пробел
    int count;
} Barcode128;

static BOOL bc_isdig(char c) { return c >= '0' && c <= '9'; }

static int bc_leading_digits(const char *s, int len, int pos) {
    int n = 0;
    while (pos + n < len && bc_isdig(s[pos + n])) n++;
    return n;
}

// Кодирует ASCII-строку (32..127) в Code128: C для цифровых пар, B для остального.
static BOOL encode_code128(const char *s, Barcode128 *out) {
    int len = 0;
    while (s[len]) len++;
    if (len == 0 || len > BC_MAX_TEXT) return FALSE;
    for (int i = 0; i < len; i++)
        if ((unsigned char)s[i] < 32 || (unsigned char)s[i] > 127) return FALSE;

    unsigned char codes[BC_MAX_TEXT + 8];
    int nc = 0, pos = 0;

    // Стартовый набор: C — если строка начинается с 4+ цифр, иначе B.
    BOOL cur_c = bc_leading_digits(s, len, 0) >= 4;
    codes[nc++] = cur_c ? BC_START_C : BC_START_B;

    while (pos < len) {
        if (cur_c) {
            if (pos + 1 < len && bc_isdig(s[pos]) && bc_isdig(s[pos + 1])) {
                codes[nc++] = (unsigned char)((s[pos] - '0') * 10 + (s[pos + 1] - '0'));
                pos += 2;
            } else {
                codes[nc++] = BC_CODE_B;
                cur_c = FALSE;
            }
        } else {
            int run = bc_leading_digits(s, len, pos);
            BOOL at_end = (pos + run >= len);
            if (run >= 4 && (at_end || run % 2 == 0)) {
                codes[nc++] = BC_CODE_C;
                cur_c = TRUE;
                continue;
            }
            codes[nc++] = (unsigned char)(s[pos] - 32);
            pos++;
        }
    }

    // Контрольная сумма: start + Σ(value_i * i), mod 103.
    unsigned int sum = codes[0];
    for (int i = 1; i < nc; i++) sum += (unsigned int)codes[i] * (unsigned int)i;
    codes[nc++] = (unsigned char)(sum % 103);

    // Разворачиваем коды в модули (каждый паттерн начинается со штриха).
    out->count = 0;
    for (int i = 0; i < nc; i++) {
        const unsigned char *pat = PATTERNS[codes[i]];
        BOOL bar = TRUE;
        for (int w = 0; w < 6; w++) {
            for (int k = 0; k < pat[w]; k++)
                out->modules[out->count++] = (unsigned char)bar;
            bar = !bar;
        }
    }
    {
        BOOL bar = TRUE;
        for (int w = 0; w < 7; w++) {
            for (int k = 0; k < STOP_PATTERN[w]; k++)
                out->modules[out->count++] = (unsigned char)bar;
            bar = !bar;
        }
    }
    return TRUE;
}

// ============================================================
// GDI-печать (аналог print.rs)
// ============================================================

static HFONT make_font(int px, int weight, BOOL underline) {
    return CreateFontW(px, 0, 0, 0, weight, FALSE, underline, FALSE,
                       DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                       CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Arial");
}

static void text_extent(HDC hdc, const wchar_t *text, int *w, int *h) {
    SIZE sz;
    GetTextExtentPoint32W(hdc, text, slen(text), &sz);
    *w = sz.cx;
    *h = sz.cy;
}

// "30*20" -> (30, 20)
static BOOL parse_paper(const wchar_t *s, int *w, int *h) {
    *w = 0; *h = 0;
    const wchar_t *p = s;
    while (*p >= L'0' && *p <= L'9') { *w = *w * 10 + (*p - L'0'); p++; }
    if (*p != L'*') return FALSE;
    p++;
    while (*p >= L'0' && *p <= L'9') { *h = *h * 10 + (*p - L'0'); p++; }
    return *h > 0 && *w > 0;
}

typedef struct {
    int width_px, height_px, margin_x, margin_y, max_allowed_w;
} Sizes;

static BOOL calc_sizes(HDC hdc, const wchar_t *paper, Sizes *s) {
    int w_mm, h_mm;
    if (!parse_paper(paper, &w_mm, &h_mm)) return FALSE;
    int dx = GetDeviceCaps(hdc, LOGPIXELSX);
    int dy = GetDeviceCaps(hdc, LOGPIXELSY);
    s->width_px  = (int)((w_mm / 25.4) * dx);
    s->height_px = (int)((h_mm / 25.4) * dy);
    s->margin_x  = (int)(s->width_px * 0.05);
    s->margin_y  = (int)(s->height_px * 0.05);
    s->max_allowed_w = s->width_px - s->margin_x * 2;
    return TRUE;
}

// Колонтитул. Возвращает Y после него.
static int draw_header(HDC hdc, const wchar_t *text, const Sizes *s, BOOL force_left) {
    HFONT f = make_font((int)(s->height_px * 0.20), FW_NORMAL, FALSE);
    HGDIOBJ old = SelectObject(hdc, f);

    int tw, th;
    text_extent(hdc, text, &tw, &th);

    int x = force_left ? s->margin_x : s->width_px - tw - s->margin_x;
    int y = s->margin_y;
    TextOutW(hdc, x, y, text, slen(text));

    SelectObject(hdc, old);
    DeleteObject(f);
    return y + th;
}

// Параметры размещения основного текста (нужны для обводки и шахматки).
typedef struct {
    int x, y;          // левый верхний угол текста
    int w, h;          // размер текста в пикселях
    int size;          // размер шрифта
    int weight;        // FW_NORMAL / FW_BOLD
} TextLayout;

// Центральный текст с автоподбором размера.
// Текст масштабируется почти линейно по размеру шрифта, поэтому вместо цикла
// «+1 px» (50+ GDI-вызовов) делаем одно измерение при реперном размере 100 px
// и линейную экстраполяцию, затем один контрольный проход с коррекцией вниз
// (метрики шрифта не идеально линейны).
static void draw_main_text(HDC hdc, const wchar_t *text, const Sizes *s,
                           int y_start, BOOL underline, BOOL bold, TextLayout *out) {
    int avail_h = s->height_px - y_start - s->margin_y;
    int weight = bold ? FW_BOLD : FW_NORMAL;

    HFONT f = make_font(100, weight, underline);
    HGDIOBJ old = SelectObject(hdc, f);
    int w100, h100;
    text_extent(hdc, text, &w100, &h100);
    SelectObject(hdc, old);
    DeleteObject(f);

    int size = 10;
    if (w100 > 0 && h100 > 0) {
        int by_w = (int)((long long)100 * s->max_allowed_w / w100);
        int by_h = (int)((long long)100 * avail_h / h100);
        size = by_w < by_h ? by_w : by_h;
    }
    if (size < 6) size = 6;

    if (out) { out->x = 0; out->y = y_start; out->w = 0; out->h = 0; out->size = size; out->weight = weight; }

    for (;;) {
        HFONT f2 = make_font(size, weight, underline);
        old = SelectObject(hdc, f2);
        int w, h;
        text_extent(hdc, text, &w, &h);
        if (w <= s->max_allowed_w && h <= avail_h) {
            int x = (s->width_px - w) / 2;
            int y = y_start + (avail_h - h) / 2;
            TextOutW(hdc, x, y, text, slen(text));
            if (out) { out->x = x; out->y = y; out->w = w; out->h = h; out->size = size; out->weight = weight; }
            SelectObject(hdc, old);
            DeleteObject(f2);
            return;
        }
        SelectObject(hdc, old);
        DeleteObject(f2);
        if (--size < 6) return;
    }
}

// Шахматная заливка + сплошная обводка по рельефу цифры.
// Рисуем цифру в память, находим граничные пиксели (сосед с белым) —
// они остаются чёрными (сплошной контур), а внутренние пиксели
// превращаются в шахматку. Контур точно повторяет форму глифа, включая
// низ цифры 4, и не выходит за границы.
static void apply_checker_with_outline(HDC hdc, const wchar_t *text,
                                       const TextLayout *tl, const Sizes *s,
                                       int y_start, const Config *c) {
    if (!tl || tl->w < 1 || tl->h < 1 || !s) return;

    // Работаем со ВСЕЙ этикеткой — иначе часть текста за пределами tl
    // остаётся сплошной (второй '0' и точка в "100.").
    int w = s->width_px, h = s->height_px;
    HDC mem = CreateCompatibleDC(hdc);
    if (!mem) return;
    HBITMAP bmp = CreateCompatibleBitmap(mem, w, h);
    if (!bmp) { DeleteDC(mem); return; }
    HGDIOBJ old = SelectObject(mem, bmp);
    PatBlt(mem, 0, 0, w, h, WHITENESS);

    // Рисуем текст на те же координаты, что и на основном HDC.
    HFONT f = make_font(tl->size, tl->weight, FALSE);
    HGDIOBJ oldf = SelectObject(mem, f);
    TextOutW(mem, tl->x, tl->y, text, slen(text));
    SelectObject(mem, oldf);
    DeleteObject(f);

    // Читаем пиксели (24-bit, top-down).
    BITMAPINFO bi;
    int z = 0;
    while (z < (int)sizeof(bi)) ((BYTE *)&bi)[z++] = 0;
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 24;
    bi.bmiHeader.biCompression = BI_RGB;
    int stride = (w * 3 + 3) & ~3;
    BYTE *bits = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (size_t)stride * h);
    if (!bits) { SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem); return; }
    int got = GetDIBits(mem, bmp, 0, h, bits, &bi, DIB_RGB_COLORS);

    if (got) {
        int dpi = GetDeviceCaps(hdc, LOGPIXELSX);
        int cell = (int)((c->checker_mm_x10 / 10.0) / 25.4 * dpi + 0.5);
        if (cell < 1) cell = 1;
        int pen = (int)((c->outline_mm_x10 / 10.0) / 25.4 * dpi + 0.5);
        if (pen < 1) pen = 1;

        // Карта чёрных пикселей.
        BYTE *black = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (size_t)w * h);
        if (black) {
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    BYTE *px = bits + (size_t)y * stride + (size_t)x * 3;
                    black[y * w + x] = (*px < 128) ? 1 : 0;
                }
            }

            // Граничные пиксели: чёрный, рядом (в радиусе pen) есть белый.
            BYTE *edge = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (size_t)w * h);
            if (edge) {
                for (int y = 0; y < h; y++) {
                    for (int x = 0; x < w; x++) {
                        size_t idx = (size_t)y * w + x;
                        edge[idx] = 0;
                        if (!black[idx]) continue;
                        int is_edge = 0;
                        for (int dy = -pen; dy <= pen && !is_edge; dy++) {
                            int yy = y + dy;
                            if (yy < 0 || yy >= h) { is_edge = 1; break; }
                            for (int dx = -pen; dx <= pen; dx++) {
                                int xx = x + dx;
                                if (xx < 0 || xx >= w || !black[(size_t)yy * w + xx]) {
                                    is_edge = 1;
                                    break;
                                }
                            }
                        }
                        edge[idx] = (BYTE)is_edge;
                    }
                }

                // Итог: контур чёрный, внутренние пиксели — шахматка.
                for (int y = 0; y < h; y++) {
                    for (int x = 0; x < w; x++) {
                        size_t idx = (size_t)y * w + x;
                        BYTE *px = bits + (size_t)y * stride + (size_t)x * 3;
                        if (!black[idx]) continue;
                        if (edge[idx]) {
                            px[0] = px[1] = px[2] = 0;      // сплошной контур
                        } else {
                            int cx = x / cell, cy = y / cell;
                            if (((cx + cy) & 1) == 0) {
                                px[0] = px[1] = px[2] = 255; // пропуск
                            }
                        }
                    }
                }
                SetDIBits(mem, bmp, 0, h, bits, &bi, DIB_RGB_COLORS);
                HeapFree(GetProcessHeap(), 0, edge);
            }
            HeapFree(GetProcessHeap(), 0, black);
        }
    }

    HeapFree(GetProcessHeap(), 0, bits);

    // Переносим результат на исходный HDC (вся этикетка).
    BitBlt(hdc, 0, 0, w, h, mem, 0, 0, SRCCOPY);

    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
}

static BOOL draw_label(HDC hdc, const Config *c, const LabelData *d) {
    SetBkMode(hdc, TRANSPARENT);
    Sizes s;
    if (!calc_sizes(hdc, c->paper, &s)) return FALSE;

    int y_start = s.margin_y;
    if (d->show_header && d->header_text[0])
        y_start = draw_header(hdc, d->header_text, &s, d->force_left_header);

    TextLayout tl;
    draw_main_text(hdc, d->main_text, &s, y_start, d->is_underlined, d->is_bold, &tl);

    if (c->checker && tl.w > 0 && tl.h > 0) {
        if (c->outline) {
            apply_checker_with_outline(hdc, d->main_text, &tl, &s, y_start, c);
        } else {
            int dpi_x = GetDeviceCaps(hdc, LOGPIXELSX);
            int cell = (int)((c->checker_mm_x10 / 10.0) / 25.4 * dpi_x + 0.5);
            if (cell < 1) cell = 1;
            for (int y = tl.y; y < tl.y + tl.h; y += cell) {
                for (int x = tl.x; x < tl.x + tl.w; x += cell) {
                    PatBlt(hdc, x, y, cell, cell, WHITENESS);
                }
            }
        }
    }
    return TRUE;
}

// Печать текстовой этикетки.
static BOOL print_text(const wchar_t *text, const Config *c) {
    if (!c->printer[0]) {
        log_line(L"ОШИБКА печати: принтер не выбран (config.json → printer пустой)");
        return FALSE;
    }

    // Очистка очереди принтера (аналог clear_printer_queue) — упрощённо
    // пропускаем: SetPrinter(PURGE) требует прав ADMINISTER и часто не нужен.

    HDC hdc = CreateDCW(c->printer, c->printer, NULL, NULL);
    if (!hdc) {
        wchar_t m[320];
        scpy(m, 320, L"ОШИБКА печати: CreateDCW не удался для принтера ");
        scat(m, 320, c->printer);
        log_line(m);
        return FALSE;
    }

    static wchar_t doc[300];
    doc[0] = 0;
    scat(doc, 300, L"Ячейка: ");
    scat(doc, 300, text);

    DOCINFOW di;
    int i = 0;
    while (i < (int)sizeof(di)) ((unsigned char *)&di)[i++] = 0;
    di.cbSize = sizeof(DOCINFOW);
    di.lpszDocName = doc;

    if (StartDocW(hdc, &di) <= 0) {
        log_line(L"ОШИБКА печати: StartDocW не удался");
        DeleteDC(hdc); return FALSE;
    }
    if (StartPage(hdc) <= 0) {
        log_line(L"ОШИБКА печати: StartPage не удался");
        AbortDoc(hdc); DeleteDC(hdc); return FALSE;
    }

    LabelData d;
    prepare_label_data(text, c, &d);
    BOOL ok = draw_label(hdc, c, &d);

    EndPage(hdc);
    EndDoc(hdc);
    DeleteDC(hdc);
    if (ok) {
        wchar_t m[320];
        scpy(m, 320, L"Печать выполнена: ");
        scat(m, 320, text);
        log_line(m);
    } else {
        log_line(L"ОШИБКА печати: draw_label вернул FALSE");
    }
    return ok;
}

// Отрисовка Code128: белый фон, полоски через PatBlt, HRI-текст под ШК.
static void draw_barcode(HDC hdc, const Barcode128 *bc, const wchar_t *text,
                         double module_mm, double height_mm) {
    int dpi_x = GetDeviceCaps(hdc, LOGPIXELSX);
    int dpi_y = GetDeviceCaps(hdc, LOGPIXELSY);

    int module_px = (int)(module_mm / 25.4 * dpi_x + 0.5);
    if (module_px < 1) module_px = 1;
    int bars_h = (int)(height_mm / 25.4 * dpi_y + 0.5);
    if (bars_h < 1) bars_h = 1;

    // Тихая зона: 10 модулей с каждой стороны (по стандарту).
    int quiet = module_px * 10;
    int total_w = module_px * bc->count + quiet * 2;

    // Компоновка: ШК сверху, текст (HRI) снизу, отступ 1 мм.
    int text_h = (int)(bars_h * 0.35);
    int gap = (int)(dpi_y / 25.4);
    int total_h = bars_h + gap + text_h;

    PatBlt(hdc, 0, 0, total_w, total_h, WHITENESS);

    int x = quiet;
    for (int i = 0; i < bc->count; ) {
        if (bc->modules[i]) {
            int run = 1;
            while (i + run < bc->count && bc->modules[i + run]) run++;
            PatBlt(hdc, x, 0, module_px * run, bars_h, BLACKNESS);
            x += module_px * run;
            i += run;
        } else {
            x += module_px;
            i++;
        }
    }

    // HRI-текст по центру под штрихкодом.
    if (text_h > 4) {
        HFONT f = make_font(text_h, FW_NORMAL, FALSE);
        HGDIOBJ old = SelectObject(hdc, f);
        int tw, th;
        text_extent(hdc, text, &tw, &th);
        TextOutW(hdc, (total_w - tw) / 2, bars_h + gap + (text_h - th) / 2,
                 text, slen(text));
        SelectObject(hdc, old);
        DeleteObject(f);
    }
}

// Печать штрихкода Code128 (аналог print::print_barcode).
static BOOL print_barcode(const wchar_t *text, double module_mm, double height_mm,
                          const Config *c) {
    // В ASCII для кодирования (Code128B: только 32..127).
    char ascii[BC_MAX_TEXT + 1];
    int i = 0;
    for (; text[i] && i < BC_MAX_TEXT; i++) {
        if (text[i] < 32 || text[i] > 127) {
            log_line(L"ОШИБКА ШК: не-ASCII символ в тексте");
            return FALSE;
        }
        ascii[i] = (char)text[i];
    }
    ascii[i] = 0;

    Barcode128 bc;
    if (!encode_code128(ascii, &bc)) {
        log_line(L"ОШИБКА ШК: не удалось закодировать текст");
        return FALSE;
    }

    HDC hdc = CreateDCW(c->printer, c->printer, NULL, NULL);
    if (!hdc) {
        wchar_t m[320];
        scpy(m, 320, L"ОШИБКА ШК: CreateDCW не удался для принтера ");
        scat(m, 320, c->printer);
        log_line(m);
        return FALSE;
    }

    static wchar_t doc[300];
    doc[0] = 0;
    scat(doc, 300, L"Штрихкод: ");
    scat(doc, 300, text);

    DOCINFOW di;
    i = 0;
    while (i < (int)sizeof(di)) ((unsigned char *)&di)[i++] = 0;
    di.cbSize = sizeof(DOCINFOW);
    di.lpszDocName = doc;

    if (StartDocW(hdc, &di) <= 0) {
        log_line(L"ОШИБКА ШК: StartDocW не удался");
        DeleteDC(hdc);
        return FALSE;
    }
    if (StartPage(hdc) <= 0) {
        log_line(L"ОШИБКА ШК: StartPage не удался");
        AbortDoc(hdc);
        DeleteDC(hdc);
        return FALSE;
    }

    draw_barcode(hdc, &bc, text, module_mm, height_mm);

    EndPage(hdc);
    EndDoc(hdc);
    DeleteDC(hdc);

    wchar_t m[320];
    scpy(m, 320, L"Печать ШК выполнена: ");
    scat(m, 320, text);
    log_line(m);
    return TRUE;
}

// ============================================================
// HTTP-сервер (Winsock)
// ============================================================

// Отправка ответа с CORS-заголовками. body — UTF-8.
static void send_response(SOCKET s, int status, const char *ctype,
                          const char *body, int body_len) {
    static char head[512];
    const char *status_text =
        (status == 200) ? "OK" :
        (status == 204) ? "No Content" :
        (status == 400) ? "Bad Request" :
        (status == 404) ? "Not Found" :
        (status == 405) ? "Method Not Allowed" :
        (status == 503) ? "Service Unavailable" : "Internal Server Error";

    int hl = wsprintfA(head,
        "HTTP/1.1 %d %s\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %d\r\n"
        "Connection: close\r\n\r\n",
        status, status_text, ctype, body_len);

    // send может отправить не всё за раз — крутим цикл.
    const char *parts[2] = { head, body };
    int lens[2] = { hl, body_len };
    for (int p = 0; p < 2; p++) {
        int off = 0;
        while (off < lens[p]) {
            int n = send(s, parts[p] + off, lens[p] - off, 0);
            if (n <= 0) return;
            off += n;
        }
    }
}

static void send_json(SOCKET s, int status, const wchar_t *json_wide) {
    static char body[JSON_MAX];
    int len = 0;
    if (wide_to_utf8(json_wide, body, JSON_MAX))
        while (body[len]) len++;
    send_response(s, status, "application/json; charset=utf-8", body, len);
}

static void send_text(SOCKET s, int status, const char *text) {
    int len = 0;
    while (text[len]) len++;
    send_response(s, status, "text/plain; charset=utf-8", text, len);
}

// Чтение одного HTTP-запроса. Возвращает: метод (0=GET,1=POST,2=OPTIONS),
// путь (wide), тело (wide, UTF-8 конверсия внутри).
typedef struct {
    int     method;               // 0 GET, 1 POST, 2 OPTIONS
    wchar_t path[256];
    wchar_t body[BODY_MAX];
    int     body_len;             // символов
} Request;

static BOOL read_request(SOCKET s, Request *r) {
    static char buf[BODY_MAX * 2];
    int total = 0;

    // Читаем заголовки (+ тело по Content-Length).
    while (total < (int)sizeof(buf) - 1) {
        int n = recv(s, buf + total, (int)sizeof(buf) - 1 - total, 0);
        if (n <= 0) break;
        total += n;
        buf[total] = 0;

        // Конец заголовков?
        char *hdr_end = 0;
        for (int i = 0; i + 3 < total; i++) {
            if (buf[i] == '\r' && buf[i + 1] == '\n' &&
                buf[i + 2] == '\r' && buf[i + 3] == '\n') { hdr_end = buf + i + 4; break; }
        }
        if (!hdr_end) continue;

        // Content-Length — ищем прямо в char-буфере, без wide-конверсии
        // заголовка (экономия 64 KB стека на запрос + ускорение).
        int content_len = 0;
        {
            static const char key[] = "ontent-Length:";  // 14 символов после 'C'
            int hdr_len = (int)(hdr_end - buf);
            for (int i = 0; i + 15 <= hdr_len; i++) {
                if (buf[i] != 'C' && buf[i] != 'c') continue;
                int j = 0;
                while (j < 14 && buf[i + 1 + j] == key[j]) j++;
                if (j == 14) {
                    const char *p = buf + i + 15;
                    const char *end = buf + hdr_len;
                    while (p < end && *p == ' ') p++;
                    while (p < end && *p >= '0' && *p <= '9')
                        content_len = content_len * 10 + (*p++ - '0');
                    break;
                }
            }
        }

        int body_avail = total - (int)(hdr_end - buf);
        if (body_avail >= content_len) break;   // всё прочитано
    }
    if (total == 0) return FALSE;
    buf[total] = 0;

    // Метод.
    r->method = 0;
    if (buf[0] == 'P' && buf[1] == 'O' && buf[2] == 'S' && buf[3] == 'T') r->method = 1;
    else if (buf[0] == 'O' && buf[1] == 'P' && buf[2] == 'T' && buf[3] == 'I') r->method = 2;

    // Путь: после первого пробела до второго.
    {
        wchar_t wfirst[BODY_MAX];
        int line_end = 0;
        while (line_end < total && buf[line_end] != '\r' && buf[line_end] != '\n') line_end++;
        if (!utf8_to_wide(buf, line_end, wfirst, BODY_MAX)) return FALSE;

        // "GET /path HTTP/1.1"
        int i = 0;
        while (wfirst[i] && wfirst[i] != L' ') i++;
        if (wfirst[i] != L' ') return FALSE;
        i++;
        int j = 0;
        while (wfirst[i] && wfirst[i] != L' ' && wfirst[i] != L'?' && j < 255)
            r->path[j++] = wfirst[i++];
        r->path[j] = 0;
    }

    // Тело.
    r->body[0] = 0;
    r->body_len = 0;
    {
        // После пустой строки.
        for (int i = 0; i + 3 < total; i++) {
            if (buf[i] == '\r' && buf[i + 1] == '\n' &&
                buf[i + 2] == '\r' && buf[i + 3] == '\n') {
                utf8_to_wide(buf + i + 4, total - i - 4, r->body, BODY_MAX);
                break;
            }
        }
        r->body_len = slen(r->body);
    }
    return TRUE;
}

// Обработка одного запроса (роутинг, аналог handle в server.rs).
static void handle_request(SOCKET s, Request *r) {
    static wchar_t json[JSON_MAX];
    static wchar_t tmp[1024];

    if (r->method == 2) {                       // CORS preflight
        send_response(s, 204, "text/plain", "", 0);
        return;
    }

    // ---- GET ----
    if (r->method == 0) {
        if (sascii(r->path, "/")) {
            send_json(s, 200, L"{\"status\": true}");
            return;
        }
        if (sascii(r->path, "/status-printer")) {
            BOOL online = g_cfg.printer[0] && status_printer(g_cfg.printer);
            send_json(s, 200, online ? L"{\"printerOnline\": true}"
                                     : L"{\"printerOnline\": false}");
            return;
        }
        if (sascii(r->path, "/listPrinters")) {
            static wchar_t printers[8][256];
            int count = list_printers(printers, 8);

            json[0] = 0;
            scat(json, JSON_MAX, L"{\"listPrinters\":[");
            for (int i = 0; i < count; i++) {
                if (i) scat(json, JSON_MAX, L",");
                scat(json, JSON_MAX, L"\"");
                jesc(printers[i], tmp, 1024);
                scat(json, JSON_MAX, tmp);
                scat(json, JSON_MAX, L"\"");
            }
            scat(json, JSON_MAX, L"]}");
            send_json(s, 200, json);
            return;
        }
        if (sascii(r->path, "/papers")) {
            json[0] = 0;
            scat(json, JSON_MAX, L"{\"papers\":[");
            for (int i = 0; i < g_cfg.papers_count; i++) {
                if (i) scat(json, JSON_MAX, L",");
                scat(json, JSON_MAX, L"\"");
                scat(json, JSON_MAX, g_cfg.papers[i]);
                scat(json, JSON_MAX, L"\"");
            }
            scat(json, JSON_MAX, L"]}");
            send_json(s, 200, json);
            return;
        }
        if (sascii(r->path, "/config")) {
            cfg_to_json(&g_cfg, json, JSON_MAX);
            send_json(s, 200, json);
            return;
        }
        if (sascii(r->path, "/service")) {
            json[0] = 0;
            scat(json, JSON_MAX, L"{\"installed\": ");
            scat(json, JSON_MAX, autostart_installed() ? L"true" : L"false");
            scat(json, JSON_MAX, L"}");
            send_json(s, 200, json);
            return;
        }
        send_json(s, 404, L"{\"error\": \"not found\"}");
        return;
    }

    // ---- POST ----
    if (r->method == 1) {
        if (sascii(r->path, "/config")) {
            // Тело должно быть JSON-объектом (начинается с '{').
            const wchar_t *b = r->body;
            while (*b == L' ') b++;
            if (*b != L'{') {
                send_json(s, 400, L"{\"error\": \"ожидается JSON-объект\"}");
                return;
            }
            cfg_apply_json(b);
            cfg_save();
            cfg_to_json(&g_cfg, json, JSON_MAX);
            send_json(s, 200, json);
            return;
        }
        if (sascii(r->path, "/print-number")) {
            wchar_t text[256];
            if (!json_str(r->body, L"text", text, 256)) {
                send_text(s, 400, "no text");
                return;
            }
            // Проверка исходного текста ДО санитизации (аналог is_printable
            // из cell.rs): только цифры, дефис, пробел + минимум одна цифра.
            // «Возврат-1», «Прямой поток - 5» и прочая кириллица отсекаются —
            // печатаем только номер ячейки.
            {
                BOOL has_digit = FALSE;
                BOOL ok_chars = text[0] != 0;
                for (int i = 0; text[i] && ok_chars; i++) {
                    wchar_t c = text[i];
                    if (c >= L'0' && c <= L'9') has_digit = TRUE;
                    else if (c != L'-' && c != L' ') ok_chars = FALSE;
                }
                if (!ok_chars || !has_digit) {
                    send_text(s, 400, "not a cell number");
                    return;
                }
            }
            // Санитизация: цифры и дефис (аналог sanitize_cell_number).
            static wchar_t clean[256];
            int j = 0;
            for (int i = 0; text[i] && j < 255; i++)
                if ((text[i] >= L'0' && text[i] <= L'9') || text[i] == L'-')
                    clean[j++] = text[i];
            clean[j] = 0;

            if (!clean[0]) { send_text(s, 400, "empty"); return; }
            if (!g_cfg.running) { send_text(s, 503, "stopped"); return; }
            if (!g_cfg.printer[0]) { send_text(s, 503, "no printer"); return; }
            if (!status_printer(g_cfg.printer)) { send_text(s, 503, "printer offline"); return; }

            if (print_text(clean, &g_cfg)) send_text(s, 200, "OK");
            else send_text(s, 500, "print failed");
            return;
        }
        if (sascii(r->path, "/print-barcode")) {
            wchar_t text[BC_MAX_TEXT + 1];
            if (!json_str(r->body, L"text", text, BC_MAX_TEXT + 1) || !text[0]) {
                send_text(s, 400, "no text");
                return;
            }
            // Только ASCII 32..127 (Code128B) — кириллица отклоняется.
            BOOL ascii_ok = TRUE;
            for (int i = 0; text[i]; i++)
                if (text[i] < 32 || text[i] > 127) { ascii_ok = FALSE; break; }
            if (!ascii_ok) { send_text(s, 400, "non-ascii"); return; }

            // Параметры ШК с дефолтами (module_mm как в Rust, height_mm=17).
            double module_mm = 0.25, height_mm = 17.0;
            json_double(r->body, L"moduleMm", &module_mm);
            json_double(r->body, L"heightMm", &height_mm);
            if (module_mm < 0.1) module_mm = 0.1;
            if (height_mm < 1.0) height_mm = 1.0;

            if (!g_cfg.running) { send_text(s, 503, "stopped"); return; }
            if (!g_cfg.printer[0]) { send_text(s, 503, "no printer"); return; }
            if (!status_printer(g_cfg.printer)) { send_text(s, 503, "printer offline"); return; }

            if (print_barcode(text, module_mm, height_mm, &g_cfg))
                send_text(s, 200, "OK");
            else
                send_text(s, 500, "print failed");
            return;
        }
        if (sascii(r->path, "/service/install")) {
            if (!install_autostart(tmp, 1024)) {
                send_json(s, 500, L"{\"error\": \"ошибка установки\"}");
                return;
            }
            spawn_detached_service();  // ошибка не фатальна (как в GUI-версии)

            wchar_t esc[1100];
            jesc(tmp, esc, 1100);
            json[0] = 0;
            scat(json, JSON_MAX, L"{\"ok\": true, \"path\": \"");
            scat(json, JSON_MAX, esc);
            scat(json, JSON_MAX, L"\"}");
            send_json(s, 200, json);
            return;
        }
        if (sascii(r->path, "/service/uninstall")) {
            if (uninstall_autostart()) send_json(s, 200, L"{\"ok\": true}");
            else send_json(s, 500, L"{\"error\": \"ошибка удаления\"}");
            return;
        }
        send_json(s, 404, L"{\"error\": \"not found\"}");
        return;
    }

    send_json(s, 405, L"{\"error\": \"method not allowed\"}");
}

// Запуск сервера (блокирующий, аналог server::spawn + бесконечный цикл).
static void run_server(void) {
    cfg_load();
    log_line(L"=== Служба запущена ===");

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        log_line(L"ОШИБКА: WSAStartup не удался");
        return;
    }

    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) {
        log_line(L"ОШИБКА: socket() не удался");
        WSACleanup();
        return;
    }

    struct sockaddr_in addr;
    int i = 0;
    while (i < (int)sizeof(addr)) ((unsigned char *)&addr)[i++] = 0;
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   // только 127.0.0.1
    addr.sin_port = htons(DEFAULT_PORT);

    // SO_REUSEADDR — чтобы служба перезапускалась сразу.
    BOOL reuse = TRUE;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, (char *)&reuse, sizeof(reuse));

    if (bind(listener, (struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR) {
        wchar_t m[128];
        wsprintfW(m, L"ОШИБКА: bind() на порт %d не удался (порт занят?)", DEFAULT_PORT);
        log_line(m);
        closesocket(listener);
        WSACleanup();
        return;
    }
    if (listen(listener, 8) == SOCKET_ERROR) {
        log_line(L"ОШИБКА: listen() не удался");
        closesocket(listener);
        WSACleanup();
        return;
    }

    wchar_t m[128];
    wsprintfW(m, L"Сервер слушает http://127.0.0.1:%d", DEFAULT_PORT);
    log_line(m);

    for (;;) {
        SOCKET client = accept(listener, NULL, NULL);
        if (client == INVALID_SOCKET) continue;

        Request req;
        if (read_request(client, &req))
            handle_request(client, &req);

        closesocket(client);
    }
    // Недостижимо: служба работает до выключения машины.
}

// ============================================================
// Демо: рендер этикетки в файл без принтера (--demo-file)
// ============================================================

// Запись 8-битного grayscale BMP.
static BOOL demo_bmp_save(const wchar_t *path, const BYTE *gray, int w, int h) {
    int row_bytes = (w + 3) & ~3;
    int image_size = row_bytes * h;
    int dib_size = 40 + 256 * 4;
    int file_size = 14 + dib_size + image_size;

    BYTE *buf = (BYTE *)HeapAlloc(GetProcessHeap(), 0, file_size);
    if (!buf) return FALSE;
    for (int i = 0; i < file_size; i++) buf[i] = 0;

    BYTE *p = buf;
    p[0] = 'B'; p[1] = 'M';
    *(DWORD *)(p + 2) = (DWORD)file_size;
    *(DWORD *)(p + 10) = (DWORD)(14 + dib_size);
    p += 14;
    *(DWORD *)(p + 0) = 40;
    *(LONG *)(p + 4) = w;
    *(LONG *)(p + 8) = -h;   // top-down
    *(WORD *)(p + 12) = 1;
    *(WORD *)(p + 14) = 8;   // 8-bit grayscale
    *(DWORD *)(p + 20) = (DWORD)image_size;
    *(DWORD *)(p + 32) = 256;
    p += 40;
    for (int i = 0; i < 256; i++) {
        p[0] = (BYTE)i; p[1] = (BYTE)i; p[2] = (BYTE)i; p[3] = 0;
        p += 4;
    }
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) *p++ = gray[(size_t)y * w + x];
        int pad = row_bytes - w;
        while (pad-- > 0) *p++ = 0;
    }

    HANDLE hf = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, NULL);
    if (hf == INVALID_HANDLE_VALUE) {
        HeapFree(GetProcessHeap(), 0, buf);
        return FALSE;
    }
    DWORD wrote = 0;
    BOOL ok = WriteFile(hf, buf, file_size, &wrote, NULL);
    CloseHandle(hf);
    HeapFree(GetProcessHeap(), 0, buf);
    return ok;
}

// Рендерит номер ячейки в BMP через те же GDI-функции, что и реальная печать.
static BOOL demo_render_bmp(const wchar_t *text, const wchar_t *path, const Config *c) {
    const int dpi = 203;
    int w = (int)(43.0 / 25.4 * dpi + 0.5);   // 344
    int h = (int)(25.0 / 25.4 * dpi + 0.5);   // 200

    HDC hdc = CreateCompatibleDC(NULL);
    if (!hdc) return FALSE;
    HBITMAP hbm = CreateCompatibleBitmap(hdc, w, h);
    if (!hbm) { DeleteDC(hdc); return FALSE; }
    HGDIOBJ old = SelectObject(hdc, hbm);
    PatBlt(hdc, 0, 0, w, h, WHITENESS);

    // Те же размеры и подготовка данных, что в print_text/draw_label.
    Sizes s;
    s.width_px = w;
    s.height_px = h;
    s.margin_x = (int)(w * 0.05);
    s.margin_y = (int)(h * 0.05);
    s.max_allowed_w = w - s.margin_x * 2;

    LabelData d;
    prepare_label_data(text, c, &d);

    SetBkMode(hdc, TRANSPARENT);
    int y_start = s.margin_y;
    if (d.show_header && d.header_text[0])
        y_start = draw_header(hdc, d.header_text, &s, d.force_left_header);
    TextLayout tl;
    draw_main_text(hdc, d.main_text, &s, y_start, d.is_underlined, d.is_bold, &tl);
    if (c->checker && tl.w > 0 && tl.h > 0) {
        if (c->outline) {
            apply_checker_with_outline(hdc, d.main_text, &tl, &s, y_start, c);
        } else {
            int cell = (int)((c->checker_mm_x10 / 10.0) / 25.4 * 203 + 0.5);
            if (cell < 1) cell = 1;
            for (int y = tl.y; y < tl.y + tl.h; y += cell) {
                for (int x = tl.x; x < tl.x + tl.w; x += cell) {
                    PatBlt(hdc, x, y, cell, cell, WHITENESS);
                }
            }
        }
    }

    // Считываем пиксели обратно (bottom-up DIB → top-down строками).
    BITMAPINFO bi;
    int z = 0;
    while (z < (int)sizeof(bi)) ((BYTE *)&bi)[z++] = 0;
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 24;
    bi.bmiHeader.biCompression = BI_RGB;

    BYTE *bits = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (size_t)w * h * 3);
    BYTE *gray = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (size_t)w * h);
    if (!bits || !gray) {
        if (bits) HeapFree(GetProcessHeap(), 0, bits);
        if (gray) HeapFree(GetProcessHeap(), 0, gray);
        SelectObject(hdc, old); DeleteObject(hbm); DeleteDC(hdc);
        return FALSE;
    }

    int got = GetDIBits(hdc, hbm, 0, h, bits, &bi, DIB_RGB_COLORS);
    if (got) {
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                BYTE *px = bits + ((size_t)y * w + x) * 3;
                gray[(size_t)y * w + x] =
                    (BYTE)((30 * px[0] + 59 * px[1] + 11 * px[2]) / 100);
            }
        }
    } else {
        for (size_t i = 0; i < (size_t)w * h; i++) gray[i] = 255;
    }

    SelectObject(hdc, old);
    DeleteObject(hbm);
    DeleteDC(hdc);

    BOOL ok = demo_bmp_save(path, gray, w, h);
    HeapFree(GetProcessHeap(), 0, bits);
    HeapFree(GetProcessHeap(), 0, gray);
    return ok;
}

// Демо-рендер в BMP (единственный поддерживаемый формат).
static BOOL demo_file(const wchar_t *text, const wchar_t *path, const Config *c) {
    return demo_render_bmp(text, path, c);
}

// ============================================================
// Точка входа
// ============================================================

// Режим эмуляции: PRINTNUM_DRY_RUN=1 → печать не выполняется.
static BOOL is_dry_run(void) {
    wchar_t v[32];
    DWORD n = GetEnvironmentVariableW(L"PRINTNUM_DRY_RUN", v, 32);
    if (n == 0 || n > 31) return FALSE;
    // Приводим к нижнему регистру.
    for (DWORD i = 0; i < n && v[i]; i++)
        if (v[i] >= L'A' && v[i] <= L'Z') v[i] += 32;
    return seq(v, L"1") || seq(v, L"true") || seq(v, L"yes") || seq(v, L"on");
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, LPWSTR cmdline, int show) {
    (void)hInst; (void)hPrev; (void)show; (void)cmdline;

    // Самая первая строка лога — подтверждение запуска процесса.
    // Если её нет в %APPDATA%\PrintNum\log.txt — exe даже не стартует.
    log_line(L"===== PrintNum.exe запущен =====");

    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);

    static wchar_t arg_print[256], arg_demo_text[256], arg_demo_path[MAX_PATH];
    const wchar_t *print_arg = NULL;
    const wchar_t *demo_text = NULL, *demo_path = NULL;

    if (argv) {
        for (int i = 1; i < argc; i++) {
            if (seq(argv[i], L"--print") && i + 1 < argc) {
                scpy(arg_print, 256, argv[++i]);
                print_arg = arg_print;
            } else if (seq(argv[i], L"--demo-file") && i + 2 < argc) {
                scpy(arg_demo_text, 256, argv[++i]);
                scpy(arg_demo_path, MAX_PATH, argv[++i]);
                demo_text = arg_demo_text;
                demo_path = arg_demo_path;
            }
        }
        LocalFree(argv);
    }

    cfg_load();

    // Демо-режим: отрисовать номер ячейки в BMP-файл без принтера.
    if (demo_text && demo_path) {
        BOOL has_digit = FALSE, ok_chars = demo_text[0] != 0;
        for (int i = 0; demo_text[i] && ok_chars; i++) {
            wchar_t ch = demo_text[i];
            if (ch >= L'0' && ch <= L'9') has_digit = TRUE;
            else if (ch != L'-' && ch != L' ') ok_chars = FALSE;
        }
        if (!ok_chars || !has_digit) {
            log_line(L"ОТКАЗ демо: не номер ячейки");
            return 1;
        }
        if (demo_file(demo_text, demo_path, &g_cfg)) {
            wchar_t m[MAX_PATH + 64];
            scpy(m, MAX_PATH + 64, L"Демо-этикетка сохранена: ");
            scat(m, MAX_PATH + 64, demo_path);
            log_line(m);
            return 0;
        }
        log_line(L"ОШИБКА демо: не удалось сохранить файл");
        return 1;
    }

    // По умолчанию (без аргументов или с --service) — чистый режим службы:
    // HTTP-сервер без окон и консоли. Одноразовая печать — только по флагам.
    if (!print_arg) {
        run_server();
        return 0;
    }

    if (print_arg) {
        // CLI: та же проверка — печатаем только номер ячейки.
        BOOL has_digit = FALSE;
        BOOL ok_chars = print_arg[0] != 0;
        for (int i = 0; print_arg[i] && ok_chars; i++) {
            wchar_t c = print_arg[i];
            if (c >= L'0' && c <= L'9') has_digit = TRUE;
            else if (c != L'-' && c != L' ') ok_chars = FALSE;
        }
        if (!ok_chars || !has_digit) {
            wchar_t m[320];
            scpy(m, 320, L"ОТКАЗ печати: не номер ячейки: ");
            scat(m, 320, print_arg);
            log_line(m);
            return 1;
        }
        if (is_dry_run()) return 0;
        LabelData d;
        prepare_label_data(print_arg, &g_cfg, &d);
        BOOL ok = g_cfg.printer[0] && print_text(print_arg, &g_cfg);
        return ok ? 0 : 1;
    }

    return 0;
}

/* ===== Мини-CRT: только то, что реально нужно, без msvcrt.dll ===== */
size_t my_strlen(const char *s) {
    const char *p = s;
    while (*p) p++;
    return (size_t)(p - s);
}
int my_strcmp(const char *a, const char *b) {
    while (*a && *a == *b) { a++; b++; }
    return (unsigned char)*a - (unsigned char)*b;
}
void *my_memcpy(void *dst, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    while (n--) *d++ = *s++;
    return dst;
}
void *my_memset(void *dst, int c, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    while (n--) *d++ = (unsigned char)c;
    return dst;
}
/* Псевдонимы, чтобы линкер находил стандартные имена */
size_t strlen(const char *s)        { return my_strlen(s); }
int strcmp(const char *a, const char *b) { return my_strcmp(a, b); }
void *memcpy(void *d, const void *s, size_t n) { return my_memcpy(d, s, n); }
void *memset(void *d, int c, size_t n)         { return my_memset(d, c, n); }
