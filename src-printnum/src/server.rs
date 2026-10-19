//! HTTP-сервер на `tiny_http` — замена Flask backend.
//!
//! Контракт API сохранён 1:1 (расширение браузера не меняется):
//! - `GET  /`               → `{"status": true}`
//! - `GET  /status-printer` → `{"printerOnline": bool}`
//! - `GET  /listPrinters`   → `{"listPrinters": [..]}`
//! - `POST /print-number`   → `"OK"` (тело: `{"text": "<номер>"}`)
//! - `POST /print-barcode`  → `"OK"` (тело: `{"text", "moduleMm", "heightMm"}`)

use crate::{config, printer, service, settings};
use crate::print;

use serde_json::json;
use tiny_http::{Header, Method, Response, Server};

/// Запускает HTTP-сервер в отдельном потоке.
pub fn spawn() -> std::io::Result<()> {
    let addr = settings::bind_addr();
    let server = Server::http(addr.as_str())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::AddrInUse, e.to_string()))?;

    std::thread::Builder::new()
        .name("printnum-http".into())
        .spawn(move || {
            println!("HTTP сервер запущен на {}", settings::base_url());
            for request in server.incoming_requests() {
                handle(request);
            }
        })?;
    Ok(())
}

/// Запускает службу `--service` в отдельном процессе (без окна консоли).
///
/// Используется при установке автозагрузки из расширения: служба
/// поднимается сразу, чтобы печать работала без перезагрузки.
fn spawn_detached_service() -> std::io::Result<()> {
    let exe = std::env::current_exe()?;

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — чтобы не мигало окно консоли у службы.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new(exe)
            .arg("--service")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
    }

    #[cfg(not(windows))]
    {
        std::process::Command::new(exe).arg("--service").spawn()?;
    }

    Ok(())
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS"[..])
            .unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..]).unwrap(),
    ]
}

fn json_response(status: u16, value: serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_string(&value).unwrap_or_else(|_| "{}".into());
    let mut response = Response::from_string(body).with_status_code(status);
    for h in cors_headers() {
        response.add_header(h);
    }
    response.add_header(
        Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap(),
    );
    response
}

fn text_response(status: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut response = Response::from_string(body.to_string()).with_status_code(status);
    for h in cors_headers() {
        response.add_header(h);
    }
    response
}

fn handle(mut request_tiny: tiny_http::Request) {
    let url = request_tiny.url().to_string();
    let path = url.split('?').next().unwrap_or(&url);
    let method = request_tiny.method().clone();

    // CORS preflight.
    if method == Method::Options {
        let _ = request_tiny.respond(text_response(204, ""));
        return;
    }

    match (method, path) {
        (Method::Get, "/") => {
            let _ = request_tiny.respond(json_response(200, json!({"status": true})));
        }

        (Method::Get, "/status-printer") => {
            let cfg = config::get();
            let online = !cfg.printer.trim().is_empty() && printer::status_printer(&cfg.printer);
            let _ = request_tiny.respond(json_response(200, json!({"printerOnline": online})));
        }

        (Method::Get, "/listPrinters") => {
            let list = printer::list_printers();
            let _ = request_tiny.respond(json_response(200, json!({"listPrinters": list})));
        }

        // Состояние службы: установлена ли в автозагрузку.
        //
        // Нужно расширению, чтобы показать кнопку «Установить службу»
        // только когда она ещё не установлена.
        (Method::Get, "/service") => {
            let installed = service::is_autostart_installed();
            let _ = request_tiny.respond(json_response(200, json!({"installed": installed})));
        }

        // Установка службы в автозагрузку (вызывается из расширения).
        //
        // Создаёт `PrintNum.cmd` в Startup и сразу запускает `--service`.
        // Права администратора не требуются.
        (Method::Post, "/service/install") => {
            match service::install_autostart() {
                Ok(path) => {
                    // Запускаем службу сразу, чтобы печать работала
                    // без перезагрузки. Ошибка не фатальна.
                    let _ = spawn_detached_service();

                    let _ = request_tiny.respond(json_response(200, json!({
                        "ok": true,
                        "path": path.display().to_string(),
                    })));
                }
                Err(e) => {
                    let _ = request_tiny.respond(json_response(500, json!({
                        "error": format!("ошибка установки: {e}"),
                    })));
                }
            }
        }

        // Удаление службы из автозагрузки.
        (Method::Post, "/service/uninstall") => {
            match service::uninstall_autostart() {
                Ok(_) => {
                    let _ = request_tiny.respond(json_response(200, json!({"ok": true})));
                }
                Err(e) => {
                    let _ = request_tiny.respond(json_response(500, json!({
                        "error": format!("ошибка удаления: {e}"),
                    })));
                }
            }
        }

        // Размеры этикеток, доступные для выбора.
        //
        // Список живёт в config.json, поэтому расширение подхватывает
        // пользовательские размеры без пересборки.
        (Method::Get, "/papers") => {
            let cfg = config::get();
            let _ = request_tiny.respond(json_response(200, json!({"papers": cfg.papers()})));
        }

        // Текущие настройки печати (принтер, бумага, флаги оформления).
        //
        // Нужно расширению, чтобы показать в окне то же состояние,
        // что и в приложении.
        (Method::Get, "/config") => {
            let cfg = config::get();
            let _ = request_tiny.respond(json_response(200, cfg.to_json()));
        }

        // Изменение настроек печати из расширения.
        //
        // Принимает частичный JSON: меняются только переданные ключи.
        // Неизвестные ключи игнорируются — клиент может быть новее.
        // При успехе возвращает полный актуальный конфиг.
        //
        // ВАЖНО: проверяем, что тело — JSON-объект. Иначе клиент может
        // случайно затереть настройки мусором (например, послав массив).
        (Method::Post, "/config") => {
            let mut body = String::new();
            let _ = request_tiny.as_reader().read_to_string(&mut body);

            let parsed = match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) if v.is_object() => v,
                Ok(_) => {
                    let _ = request_tiny.respond(json_response(
                        400,
                        json!({"error": "ожидается JSON-объект"}),
                    ));
                    return;
                }
                Err(e) => {
                    let _ = request_tiny.respond(json_response(
                        400,
                        json!({"error": format!("некорректный JSON: {e}")}),
                    ));
                    return;
                }
            };

            let updated = config::update(|c| c.apply_json(&parsed));

            match updated {
                Ok(cfg) => {
                    // Сообщаем в лог, что именно поменялось — удобно отлаживать.
                    println!(
                        "[config] изменён из расширения: running={}, printer='{}', paper='{}', \
                         idNum={}, endLine={}, hybrid={}, expand={}",
                        cfg.running,
                        cfg.printer,
                        cfg.paper,
                        cfg.id_num,
                        cfg.end_line,
                        cfg.hybrid,
                        cfg.expand
                    );

                    let _ = request_tiny.respond(json_response(200, cfg.to_json()));
                }
                Err(e) => {
                    eprintln!("[config] ошибка сохранения: {e}");
                    let _ = request_tiny.respond(json_response(
                        500,
                        json!({"error": format!("не удалось сохранить настройки: {e}")}),
                    ));
                }
            }
        }

        (Method::Post, "/print-number") => {
            let mut body = String::new();
            let _ = request_tiny.as_reader().read_to_string(&mut body);

            let text = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()))
                .unwrap_or_default();

            let text = text.trim().to_string();
            let cfg = config::get();

            // В режиме эмуляции (dry-run) принтер не нужен — проверяем только
            // активность приложения и непустой номер. В боевом режиме — как раньше,
            // требуется выбранный и доступный принтер.
            let should_print = if print::is_dry_run() {
                !text.is_empty() && cfg.running
            } else {
                !text.is_empty()
                    && cfg.running
                    && !cfg.printer.trim().is_empty()
                    && printer::status_printer(&cfg.printer)
            };

            if should_print {
                match print::print_text(&text, &cfg) {
                    Ok(()) => {
                        let _ = request_tiny.respond(text_response(200, "OK"));
                    }
                    Err(e) => {
                        eprintln!("[print] ошибка: {e}");
                        let _ = request_tiny.respond(text_response(500, &e));
                    }
                }
            } else {
                // Не печатаем — сообщаем причину клиенту.
                //
                // Статус 200 здесь был бы ошибкой: расширение считает
                // успехом любой `response.ok` и не покажет пользователю,
                // что номер не напечатан.
                //
                // 503 — служба/приложение не готовы печатать (остановлено,
                // принтер не выбран или недоступен); 400 — пустой номер.
                let reason = if text.is_empty() {
                    "пустой номер".to_string()
                } else if !cfg.running {
                    "приложение остановлено".to_string()
                } else if !print::is_dry_run() && cfg.printer.trim().is_empty() {
                    "принтер не выбран".to_string()
                } else {
                    "принтер недоступен".to_string()
                };

                eprintln!("[print] пропуск: {reason}");
                let code = if text.is_empty() { 400 } else { 503 };
                let _ = request_tiny.respond(text_response(code, &reason));
            }
        }

        (Method::Post, "/print-barcode") => {
            let mut body = String::new();
            let _ = request_tiny.as_reader().read_to_string(&mut body);

            let parsed = serde_json::from_str::<serde_json::Value>(&body).ok();
            let text = parsed
                .as_ref()
                .and_then(|v| v.get("text").and_then(|t| t.as_str()))
                .unwrap_or("")
                .trim()
                .to_string();
            // Параметры ШК (мм) с значениями по умолчанию.
            let module_mm = parsed
                .as_ref()
                .and_then(|v| v.get("moduleMm").and_then(|m| m.as_f64()))
                .unwrap_or(0.25);
            let height_mm = parsed
                .as_ref()
                .and_then(|v| v.get("heightMm").and_then(|m| m.as_f64()))
                .unwrap_or(10.0);

            let cfg = config::get();

            let should_print = if print::is_dry_run() {
                !text.is_empty() && cfg.running
            } else {
                !text.is_empty()
                    && cfg.running
                    && !cfg.printer.trim().is_empty()
                    && printer::status_printer(&cfg.printer)
            };

            if should_print {
                match print::print_barcode(&text, module_mm, height_mm, &cfg) {
                    Ok(()) => {
                        let _ = request_tiny.respond(text_response(200, "OK"));
                    }
                    Err(e) => {
                        eprintln!("[barcode] ошибка: {e}");
                        let _ = request_tiny.respond(text_response(500, &e));
                    }
                }
            } else {
                // См. комментарий в /print-number: 200 при пропуске вводит
                // расширение в заблуждение.
                let reason = if text.is_empty() {
                    "пустой текст".to_string()
                } else if !cfg.running {
                    "приложение остановлено".to_string()
                } else if !print::is_dry_run() && cfg.printer.trim().is_empty() {
                    "принтер не выбран".to_string()
                } else {
                    "принтер недоступен".to_string()
                };

                eprintln!("[barcode] пропуск: {reason}");
                let code = if text.is_empty() { 400 } else { 503 };
                let _ = request_tiny.respond(text_response(code, &reason));
            }
        }

        _ => {
            let _ = request_tiny.respond(text_response(404, "Not Found"));
        }
    }
}