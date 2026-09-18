//! Настройки окружения (порт HTTP-сервера и прочее).
//!
//! Значения читаются в таком порядке приоритета:
//!
//! 1. Переменная окружения (`PRINTNUM_PORT`)
//! 2. Файл `.env` (в текущей рабочей директории или рядом с бинарником)
//! 3. Встроенное значение по умолчанию
//!
//! `.env` парсится вручную (без сторонних крейтов) и поддерживает простые
//! строки `KEY=VALUE`. Строки, начинающиеся с `#`, игнорируются. Значения
//! можно брать в кавычки (`"..."` или `'...'`).
//!
//! Пример `.env`:
//!
//! ```text
//! PRINTNUM_PORT=6000
//! ```
//!
//! # Важно про браузерное расширение
//!
//! Расширение обращается к приложению по фиксированному адресу, который
//! задаётся при его сборке (`extension/.env` → `VITE_PRINTNUM_PORT`).
//! Поэтому при смене порта в приложении нужно указать тот же порт и
//! в `extension/.env`, затем пересобрать расширение.

use std::path::PathBuf;

/// Порт HTTP-сервера по умолчанию.
pub const DEFAULT_PORT: u16 = 5000;

/// Имя переменной окружения / ключа `.env`.
pub const PORT_KEY: &str = "PRINTNUM_PORT";

/// Возвращает порт HTTP-сервера.
///
/// Приоритет: переменная окружения → `.env` → [`DEFAULT_PORT`].
pub fn port() -> u16 {
    std::env::var(PORT_KEY)
        .ok()
        .and_then(|v| parse_port(&v))
        .or_else(|| read_port_from_dotenv())
        .unwrap_or(DEFAULT_PORT)
}

/// Адрес, который слушает сервер (например, `127.0.0.1:5000`).
pub fn bind_addr() -> String {
    format!("127.0.0.1:{}", port())
}

/// Базовый URL приложения.
pub fn base_url() -> String {
    format!("http://127.0.0.1:{}", port())
}

/// Парсит значение порта. Возвращает `None`, если строка некорректна
/// или порт равен нулю.
fn parse_port(raw: &str) -> Option<u16> {
    let value = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    match value.parse::<u16>() {
        Ok(p) if p > 0 => Some(p),
        _ => {
            eprintln!("[settings] {PORT_KEY}: некорректное значение '{raw}', игнорируется");
            None
        }
    }
}

/// Ищет `PRINTNUM_PORT` в файле `.env`.
///
/// Проверяет два места:
/// 1. `.env` в текущей рабочей директории;
/// 2. `.env` рядом с исполняемым файлом.
fn read_port_from_dotenv() -> Option<u16> {
    for path in dotenv_candidates() {
        if let Some(port) = read_port_from_file(&path) {
            return Some(port);
        }
    }
    None
}

fn dotenv_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        paths.push(cwd.join(".env"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(".env");
            if !paths.contains(&p) {
                paths.push(p);
            }
        }
    }
    paths
}

fn read_port_from_file(path: &std::path::Path) -> Option<u16> {
    let content = std::fs::read_to_string(path).ok()?;

    for line in content.lines() {
        let line = line.trim();

        // Пропускаем пустые строки и комментарии.
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // Поддержка формата `export KEY=VALUE`.
        let line = line.strip_prefix("export ").unwrap_or(line);

        let Some((key, value)) = line.split_once('=') else {
            continue;
        };

        if key.trim() == PORT_KEY {
            return parse_port(value);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_port_accepts_valid_values() {
        assert_eq!(parse_port("6000"), Some(6000));
        assert_eq!(parse_port("  6000  "), Some(6000));
        assert_eq!(parse_port("\"6000\""), Some(6000));
        assert_eq!(parse_port("'6000'"), Some(6000));
    }

    #[test]
    fn parse_port_rejects_invalid_values() {
        assert_eq!(parse_port("0"), None);
        assert_eq!(parse_port("abc"), None);
        assert_eq!(parse_port(""), None);
        assert_eq!(parse_port("70000"), None); // больше u16
    }
}