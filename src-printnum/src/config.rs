//! Чтение/запись `config.json` в пользовательском каталоге приложения.
//!
//! Расположение файла зависит от платформы:
//!
//! - **Windows** — `%APPDATA%\PrintNum\config.json`
//! - **macOS** — `~/Library/Application Support/PrintNum/config.json`
//! - **Linux** — `$XDG_CONFIG_HOME/PrintNum/config.json` (или `~/.config/PrintNum/...`)
//!
//! Формат ключей полностью совместим с прежним Python/Flask backend,
//! поэтому уже установленные конфигурации продолжают работать.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Конфигурация приложения (ключи 1:1 с прежним backend).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub printer: String,
    #[serde(default = "default_paper")]
    pub paper: String,
    #[serde(default)]
    pub id_num: bool,
    #[serde(default)]
    pub end_line: bool,
    #[serde(default)]
    pub hybrid: bool,
    #[serde(default = "default_expand")]
    pub expand: i64,
    #[serde(default = "default_true")]
    pub running: bool,

    // Поля, которые мог писать старый фронтенд, — сохраняем, чтобы не терять данные.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_style: Option<String>,
}

fn default_paper() -> String {
    "30*20".to_string()
}
fn default_expand() -> i64 {
    500
}
fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            printer: String::new(),
            paper: default_paper(),
            id_num: false,
            end_line: false,
            hybrid: false,
            expand: default_expand(),
            running: true,
            theme: None,
            theme_style: None,
        }
    }
}

// serde нужен snake_case в Rust и camelCase в JSON (совместимость с backend).
impl Config {
    fn to_value(&self) -> serde_json::Value {
        serde_json::json!({
            "printer": self.printer,
            "paper": self.paper,
            "idNum": self.id_num,
            "endLine": self.end_line,
            "hybrid": self.hybrid,
            "expand": self.expand,
            "running": self.running,
            "theme": self.theme,
            "themeStyle": self.theme_style,
        })
    }

    fn from_value(v: &serde_json::Value) -> Self {
        let get_bool = |k: &str, d: bool| v.get(k).and_then(|x| x.as_bool()).unwrap_or(d);
        let get_str = |k: &str, d: &str| {
            v.get(k)
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| d.to_string())
        };
        Self {
            printer: get_str("printer", ""),
            paper: get_str("paper", "30*20"),
            id_num: get_bool("idNum", false),
            end_line: get_bool("endLine", false),
            hybrid: get_bool("hybrid", false),
            expand: v.get("expand").and_then(|x| x.as_i64()).unwrap_or(500),
            running: get_bool("running", true),
            theme: v.get("theme").and_then(|x| x.as_str()).map(String::from),
            theme_style: v.get("themeStyle").and_then(|x| x.as_str()).map(String::from),
        }
    }
}

/// Путь к каталогу данных приложения (платформозависимый).
///
/// - Windows: `%APPDATA%\PrintNum`
/// - macOS:   `~/Library/Application Support/PrintNum`
/// - Linux:   `$XDG_CONFIG_HOME/PrintNum` или `~/.config/PrintNum`
///
/// Если ни одну из стандартных переменных окружения получить не удалось,
/// используется текущая рабочая директория — но это крайний случай
/// (например, среда без `HOME`/`APPDATA`).
pub fn app_dir() -> PathBuf {
    let base = platform_config_base();
    let dir = base.join("PrintNum");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Базовая директория конфигурации для текущей платформы.
#[cfg(windows)]
fn platform_config_base() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| fallback_base())
}

#[cfg(target_os = "macos")]
fn platform_config_base() -> PathBuf {
    // ~/Library/Application Support — стандартное место для данных приложений.
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => PathBuf::from(home).join("Library/Application Support"),
        _ => fallback_base(),
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn platform_config_base() -> PathBuf {
    // Linux и прочие Unix: следуем XDG Base Directory Specification.
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg);
        }
    }
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => PathBuf::from(home).join(".config"),
        _ => fallback_base(),
    }
}

/// Крайний случай: если стандартные переменные недоступны.
fn fallback_base() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Путь к `config.json`.
pub fn config_path() -> PathBuf {
    app_dir().join("config.json")
}

static CONFIG: OnceLock<Mutex<Config>> = OnceLock::new();

fn store() -> &'static Mutex<Config> {
    CONFIG.get_or_init(|| Mutex::new(read_from_disk()))
}

/// Загрузка конфига из файла (без кеша, читает диск).
fn read_from_disk() -> Config {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => {
            match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(v) => Config::from_value(&v),
                Err(e) => {
                    eprintln!("[config] ошибка парсинга: {e}");
                    Config::default()
                }
            }
        }
        _ => Config::default(),
    }
}

/// Возвращает текущую конфигурацию (из памяти).
pub fn get() -> Config {
    store().lock().map(|c| c.clone()).unwrap_or_default()
}

/// Перечитывает конфиг с диска (например, если файл изменил другой процесс).
#[allow(dead_code)]
pub fn reload() -> Config {
    let fresh = read_from_disk();
    if let Ok(mut c) = store().lock() {
        *c = fresh.clone();
    }
    fresh
}

/// Сохраняет конфиг в память и на диск.
pub fn save(cfg: Config) -> std::io::Result<()> {
    if let Ok(mut c) = store().lock() {
        *c = cfg.clone();
    }
    write_to_disk(&cfg)
}

/// Обновляет отдельные поля и сохраняет.
pub fn update<F: FnOnce(&mut Config)>(f: F) -> std::io::Result<Config> {
    let mut cfg = get();
    f(&mut cfg);
    save(cfg.clone())?;
    Ok(cfg)
}

fn write_to_disk(cfg: &Config) -> std::io::Result<()> {
    let path = config_path();
    let json = serde_json::to_string_pretty(&cfg.to_value())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

    // Атомарная запись через временный файл.
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.flush()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}