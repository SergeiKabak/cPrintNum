// PrintNum — нативный Rust GUI (Slint) + HTTP backend.
// Целевая платформа: Windows 7 x64+ (без WebView2, без Python, без Node.js).
//
// На macOS/Linux приложение собирается и запускается ТОЛЬКО для разработки:
// GUI и HTTP-сервер работают, но печать и функции принтера заменены заглушками
// (см. lib.rs). Пользовательская поддержка macOS/Linux не заявлена.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use printnum::{config, printer, server};

slint::include_modules!();

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Общее состояние, доступное GUI и фоновым задачам.
struct Shared {
    printer_online: AtomicBool,
    last_poll_ms: AtomicU64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn main() {
    // Разбор аргументов командной строки.
    // --dry-run включает режим эмуляции печати (или PRINTNUM_DRY_RUN=1).
    if std::env::args().any(|a| a == "--dry-run" || a == "-n") {
        std::env::set_var("PRINTNUM_DRY_RUN", "1");
    }
    if printnum::print::is_dry_run() {
        println!("*** РЕЖИМ ЭМУЛЯЦИИ ПЕЧАТИ (dry-run) ***");
        println!("Печать на принтер выполняться НЕ будет.");
        println!(
            "Превью сохраняются в: {}",
            config::app_dir().join("previews").display()
        );
    }

    // 1. Запуск HTTP-сервера в отдельном потоке.
    // Порт берётся из PRINTNUM_PORT (env) или .env, иначе 5000.
    if let Err(e) = server::spawn() {
        eprintln!("Не удалось запустить HTTP сервер: {e}");
        eprintln!(
            "Возможно, порт {} уже занят. Задайте другой порт через \
             PRINTNUM_PORT или .env",
            printnum::settings::port()
        );
        return;
    }

    // 2. GUI.
    let app = AppWindow::new().expect("Не удалось создать окно");

    let cfg = config::get();
    app.set_running(cfg.running);
    app.set_printer(cfg.printer.clone().into());
    app.set_paper(cfg.paper.clone().into());
    app.set_id_num(cfg.id_num);
    app.set_end_line(cfg.end_line);
    app.set_hybrid(cfg.hybrid);
    app.set_expand(cfg.expand as i32);
    app.set_version(env!("CARGO_PKG_VERSION").into());
    app.set_server_online(true);
    app.set_dry_run(printnum::print::is_dry_run());
    let printers = printer::list_printers();
    app.set_printer_index(index_of_strings(&printers, &cfg.printer));
    app.set_paper_index(index_of(&PAPERS, &cfg.paper));
    app.set_list_printers(string_model(printers));

    // ---- Колбэки GUI → конфиг ----
    let weak = app.as_weak();

    app.on_set_running(move |v| {
        let _ = config::update(|c| c.running = v);
        if let Some(a) = weak.upgrade() {
            a.set_running(v);
        }
    });

    let weak = app.as_weak();
    app.on_set_printer(move |v| {
        let name = v.to_string();
        let _ = config::update(|c| c.printer = name.clone());
        if let Some(a) = weak.upgrade() {
            a.set_printer(v.clone());
            use slint::Model;
            let list: Vec<String> = a.get_list_printers().iter().map(|s| s.to_string()).collect();
            a.set_printer_index(index_of_strings(&list, &name));
        }
    });

    let weak = app.as_weak();
    app.on_set_paper(move |v| {
        let _ = config::update(|c| c.paper = v.to_string());
        if let Some(a) = weak.upgrade() {
            a.set_paper(v.clone());
            a.set_paper_index(index_of(&PAPERS, &v.to_string()));
        }
    });

    let weak = app.as_weak();
    app.on_set_id_num(move |v| {
        let _ = config::update(|c| c.id_num = v);
        if let Some(a) = weak.upgrade() {
            a.set_id_num(v);
        }
    });

    let weak = app.as_weak();
    app.on_set_end_line(move |v| {
        let _ = config::update(|c| c.end_line = v);
        if let Some(a) = weak.upgrade() {
            a.set_end_line(v);
        }
    });

    let weak = app.as_weak();
    app.on_set_hybrid(move |v| {
        let _ = config::update(|c| c.hybrid = v);
        if let Some(a) = weak.upgrade() {
            a.set_hybrid(v);
        }
    });

    let weak = app.as_weak();
    app.on_set_expand(move |v| {
        let value = v.max(1);
        let _ = config::update(|c| c.expand = value as i64);
        if let Some(a) = weak.upgrade() {
            a.set_expand(value);
        }
    });

    let weak = app.as_weak();
    app.on_minimize_window(move || {
        if let Some(a) = weak.upgrade() {
            let _ = a.window().set_minimized(true);
        }
    });

    let weak = app.as_weak();
    app.on_close_window(move || {
        if let Some(a) = weak.upgrade() {
            let _ = a.hide();
        }
        std::process::exit(0);
    });

    app.on_open_help(|| {
        let _ = open_url("https://github.com/kirill18734/PrintNum");
    });

    // ---- Фоновый опрос статуса принтера (1 сек) и списка принтеров (5 сек) ----
    let shared = Arc::new(Shared {
        printer_online: AtomicBool::new(false),
        last_poll_ms: AtomicU64::new(0),
    });

    let weak = app.as_weak();
    let shared_bg = shared.clone();
    std::thread::spawn(move || {
        loop {
            // Статус принтера — раз в секунду.
            let online = {
                let cfg = config::get();
                !cfg.printer.trim().is_empty() && printer::status_printer(&cfg.printer)
            };
            shared_bg.printer_online.store(online, Ordering::Relaxed);

            // Список принтеров — раз в 5 секунд.
            let last = shared_bg.last_poll_ms.load(Ordering::Relaxed);
            if now_ms().saturating_sub(last) >= 5000 {
                let list = printer::list_printers();
                let list_handle = weak.clone();
                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(a) = list_handle.upgrade() {
                        a.set_list_printers(string_model(list));
                    }
                });
                shared_bg.last_poll_ms.store(now_ms(), Ordering::Relaxed);
            }

            // Публикуем статус в GUI.
            let handle = weak.clone();
            let _ = slint::invoke_from_event_loop(move || {
                if let Some(a) = handle.upgrade() {
                    a.set_printer_online(online);
                }
            });

            std::thread::sleep(Duration::from_millis(1000));
        }
    });

    let _ = shared; // устранение предупреждения

    app.run().expect("Ошибка запуска GUI");
}

fn string_model(items: Vec<String>) -> slint::ModelRc<slint::SharedString> {
    let v: Vec<slint::SharedString> = items.into_iter().map(|s| s.into()).collect();
    slint::ModelRc::new(slint::VecModel::from(v))
}

/// Фиксированный список размеров этикеток (совместим с прежним фронтендом).
const PAPERS: [&str; 8] = [
    "30*20", "40*30", "43*25", "50*70", "58*40", "60*40", "75*120", "100*150",
];

/// Индекс значения в списке (0, если не найдено).
fn index_of(items: &[&str], value: &str) -> i32 {
    items.iter().position(|s| *s == value).unwrap_or(0) as i32
}

/// Индекс значения в Vec<String>.
fn index_of_strings(items: &[String], value: &str) -> i32 {
    items.iter().position(|s| s == value).unwrap_or(0) as i32
}

/// Открывает URL в браузере по умолчанию.
#[cfg(windows)]
fn open_url(url: &str) -> std::io::Result<()> {
    // Используем cmd.exe, доступный на Windows 7+.
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
}

/// Не-Windows (только для разработки): открываем через системный opener.
#[cfg(not(windows))]
fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("open").arg(url).spawn().map(|_| ());
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ())
    }
}