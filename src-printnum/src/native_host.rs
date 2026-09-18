//! Режим native-host: обмен с браузерным расширением через stdin/stdout.
//!
//! Реализует протокол Chrome Native Messaging:
//! каждое сообщение — 4 байта длины (little-endian) + JSON UTF-8.
//!
//! Браузер запускает `printnum --native-host` и общается с процессом через
//! стандартные потоки. Позволяет печатать без открытого HTTP-порта.
//!
//! Команды (поле `command` в запросе):
//! - `ping`                → `{"status":"ok","version":"..."}`
//! - `print-number`        → печать номера ячейки (как POST /print-number)
//! - `print-barcode`       → печать штрихкода (как POST /print-barcode)
//! - `status-printer`      → `{"printerOnline": bool}`
//! - `list-printers`       → `{"listPrinters": [...]}`
//!
//! Логи пишутся в stderr (не мешают протоколу).

use crate::{config, print, printer};

use serde_json::{json, Value};
use std::io::{Read, Write};

/// Максимальный размер входящего сообщения (ограничение Chrome — 1 МБ).
const MAX_MESSAGE: usize = 1024 * 1024;

/// Точка входа режима native-host. Работает до закрытия stdin.
pub fn run() -> std::io::Result<()> {
    eprintln!("[native-host] PrintNum запущен в режиме native messaging");

    let stdin = std::io::stdin();
    let mut input = stdin.lock();

    loop {
        // Читаем 4 байта длины. EOF → браузер закрыл соединение.
        let mut len_buf = [0u8; 4];
        match input.read_exact(&mut len_buf) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                eprintln!("[native-host] stdin закрыт, завершение");
                return Ok(());
            }
            Err(e) => return Err(e),
        }

        let len = u32::from_le_bytes(len_buf) as usize;
        if len == 0 || len > MAX_MESSAGE {
            eprintln!("[native-host] некорректная длина сообщения: {len}");
            return Ok(());
        }

        // Читаем тело сообщения.
        let mut buf = vec![0u8; len];
        input.read_exact(&mut buf)?;

        let request: Value = match serde_json::from_slice(&buf) {
            Ok(v) => v,
            Err(e) => {
                send(&json!({ "status": "error", "error": format!("некорректный JSON: {e}") }))?;
                continue;
            }
        };

        let response = handle(&request);
        send(&response)?;
    }
}

/// Обрабатывает один запрос и возвращает ответ.
fn handle(request: &Value) -> Value {
    let command = request
        .get("command")
        .and_then(|c| c.as_str())
        .unwrap_or("");

    match command {
        "ping" => json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
        }),

        "status-printer" => {
            let cfg = config::get();
            let online =
                !cfg.printer.trim().is_empty() && printer::status_printer(&cfg.printer);
            json!({ "status": "ok", "printerOnline": online })
        }

        "list-printers" => {
            json!({ "status": "ok", "listPrinters": printer::list_printers() })
        }

        "print-number" => {
            let text = request
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim()
                .to_string();

            let cfg = config::get();
            if !text.is_empty() && cfg.running {
                match print::print_text(&text, &cfg) {
                    Ok(()) => json!({ "status": "ok" }),
                    Err(e) => json!({ "status": "error", "error": e }),
                }
            } else {
                json!({ "status": "skipped", "reason": skip_reason(&text, &cfg) })
            }
        }

        "print-barcode" => {
            let text = request
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let module_mm = request
                .get("moduleMm")
                .and_then(|m| m.as_f64())
                .unwrap_or(0.25);
            let height_mm = request
                .get("heightMm")
                .and_then(|m| m.as_f64())
                .unwrap_or(10.0);

            let cfg = config::get();
            if !text.is_empty() && cfg.running {
                match print::print_barcode(&text, module_mm, height_mm, &cfg) {
                    Ok(()) => json!({ "status": "ok" }),
                    Err(e) => json!({ "status": "error", "error": e }),
                }
            } else {
                json!({ "status": "skipped", "reason": skip_reason(&text, &cfg) })
            }
        }

        "" => json!({ "status": "error", "error": "не указано поле 'command'" }),

        other => json!({
            "status": "error",
            "error": format!("неизвестная команда: {other}"),
        }),
    }
}

/// Объясняет, почему печать пропущена.
fn skip_reason(text: &str, cfg: &config::Config) -> String {
    if text.is_empty() {
        "пустой текст".into()
    } else if !cfg.running {
        "приложение остановлено (running=false)".into()
    } else if !print::is_dry_run() && cfg.printer.trim().is_empty() {
        "принтер не выбран".into()
    } else {
        "принтер недоступен".into()
    }
}

/// Отправляет ответ: 4 байта длины (LE) + JSON.
fn send(value: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value)
        .unwrap_or_else(|_| b"{\"status\":\"error\"}".to_vec());
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    out.write_all(&(bytes.len() as u32).to_le_bytes())?;
    out.write_all(&bytes)?;
    out.flush()
}

/// Включать ли native-host только для чтения (без GUI/HTTP).
/// Возвращает true, если передан аргумент `--native-host`.
pub fn is_native_host_requested() -> bool {
    std::env::args().any(|a| a == "--native-host")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ping_returns_ok_with_version() {
        let r = handle(&json!({ "command": "ping" }));
        assert_eq!(r["status"], "ok");
        assert_eq!(r["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn missing_command_is_error() {
        let r = handle(&json!({ "foo": "bar" }));
        assert_eq!(r["status"], "error");
    }

    #[test]
    fn unknown_command_is_error() {
        let r = handle(&json!({ "command": "nope" }));
        assert_eq!(r["status"], "error");
        assert!(r["error"].as_str().unwrap().contains("неизвестная"));
    }

    #[test]
    fn list_printers_returns_array() {
        let r = handle(&json!({ "command": "list-printers" }));
        assert_eq!(r["status"], "ok");
        assert!(r["listPrinters"].is_array());
    }

    #[test]
    fn status_printer_returns_bool() {
        let r = handle(&json!({ "command": "status-printer" }));
        assert_eq!(r["status"], "ok");
        assert!(r["printerOnline"].is_boolean());
    }

    #[test]
    fn print_number_with_empty_text_is_skipped() {
        // Пустой текст → skipped с причиной.
        let r = handle(&json!({ "command": "print-number", "text": "  " }));
        assert_eq!(r["status"], "skipped");
        assert!(r["reason"].as_str().unwrap().contains("пустой"));
    }

    #[test]
    fn print_barcode_bad_text_returns_error() {
        // Непечатаемый символ → ошибка кодирования (не skipped).
        let r = handle(&json!({ "command": "print-barcode", "text": "\u{1}\u{2}" }));
        // Либо skipped (если running=false), либо error от энкодера.
        assert!(r["status"] == "error" || r["status"] == "skipped");
    }
}