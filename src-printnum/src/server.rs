//! HTTP-сервер на `tiny_http` — замена Flask backend.
//!
//! Контракт API сохранён 1:1 (расширение браузера не меняется):
//! - `GET  /`               → `{"status": true}`
//! - `GET  /status-printer` → `{"printerOnline": bool}`
//! - `GET  /listPrinters`   → `{"listPrinters": [..]}`
//! - `POST /print-number`   → `"OK"` (тело: `{"text": "<номер>"}`)

use crate::{config, printer};
use crate::print;

use serde_json::json;
use tiny_http::{Header, Method, Response, Server};

/// Запускает HTTP-сервер в отдельном потоке.
pub fn spawn() -> std::io::Result<()> {
    let server = Server::http("127.0.0.1:5000")
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::AddrInUse, e.to_string()))?;

    std::thread::Builder::new()
        .name("printnum-http".into())
        .spawn(move || {
            println!("HTTP сервер запущен на http://127.0.0.1:5000");
            for request in server.incoming_requests() {
                handle(request);
            }
        })?;
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

        (Method::Post, "/print-number") => {
            let mut body = String::new();
            let _ = request_tiny.as_reader().read_to_string(&mut body);

            let text = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()))
                .unwrap_or_default();

            let text = text.trim().to_string();
            let cfg = config::get();

            if !text.is_empty()
                && cfg.running
                && !cfg.printer.trim().is_empty()
                && printer::status_printer(&cfg.printer)
            {
                if let Err(e) = print::print_text(&text, &cfg) {
                    eprintln!("[print] ошибка: {e}");
                }
            }

            let _ = request_tiny.respond(text_response(200, "OK"));
        }

        _ => {
            let _ = request_tiny.respond(text_response(404, "Not Found"));
        }
    }
}