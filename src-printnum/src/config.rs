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

    // Список размеров этикеток, доступных для выбора.
    //
    // Хранится в конфиге, а не в коде: пользователь может добавить
    // свой размер, и он сразу появится и в приложении, и в расширении
    // (расширение читает список через `GET /papers`).
    #[serde(default = "default_papers")]
    pub papers: Vec<String>,

    // Поля, которые мог писать старый фронтенд, — сохраняем, чтобы не терять данные.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_style: Option<String>,
}

fn default_paper() -> String {
    "30*20".to_string()
}

/// Размеры этикеток по умолчанию (совместимы с прежним фронтендом).
///
/// Возвращаются, если в `config.json` поля `papers` нет или оно пустое —
/// иначе пользователь остался бы без единого варианта выбора.
pub fn default_papers() -> Vec<String> {
    [
        "30*20", "40*30", "43*25", "50*70", "58*40", "60*40", "75*120", "100*150",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
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
            papers: default_papers(),
            theme: None,
            theme_style: None,
        }
    }
}

// serde нужен snake_case в Rust и camelCase в JSON (совместимость с backend).
impl Config {
    /// Публичное представление конфига в формате JSON-совместимого объекта.
    ///
    /// Используется HTTP-сервером для `GET /config`,
    /// чтобы не дублировать список полей.
    pub fn to_json(&self) -> serde_json::Value {
        self.to_value()
    }

    /// Список размеров этикеток для выбора.
    ///
    /// Пустой список заменяется на значения по умолчанию — иначе в UI
    /// не будет ни одного варианта.
    pub fn papers(&self) -> Vec<String> {
        if self.papers.is_empty() {
            default_papers()
        } else {
            self.papers.clone()
        }
    }

    /// Применяет к конфигу пришедшие по HTTP значения.
    ///
    /// Меняются только ПРИСУТСТВУЮЩИЕ ключи: то, что не передано,
    /// остаётся без изменений. Неизвестные ключи игнорируются — так
    /// старая версия приложения не сломается на новом расширении.
    ///
    /// Ключи — camelCase (совместимость с `config.json`).
    pub fn apply_json(&mut self, v: &serde_json::Value) {
        if let Some(x) = v.get("printer").and_then(|x| x.as_str()) {
            self.printer = x.to_string();
        }
        if let Some(x) = v.get("paper").and_then(|x| x.as_str()) {
            self.paper = x.to_string();
        }
        if let Some(x) = v.get("idNum").and_then(|x| x.as_bool()) {
            self.id_num = x;
        }
        if let Some(x) = v.get("endLine").and_then(|x| x.as_bool()) {
            self.end_line = x;
        }
        if let Some(x) = v.get("hybrid").and_then(|x| x.as_bool()) {
            self.hybrid = x;
        }
        if let Some(x) = v.get("expand").and_then(|x| x.as_i64()) {
            // Защита от нуля/отрицательных значений: печать делает
            // сравнение `номер >= expand`, нулевой порог бессмыслен.
            self.expand = x.max(1);
        }
        if let Some(x) = v.get("running").and_then(|x| x.as_bool()) {
            self.running = x;
        }

        // Список размеров: принимаем только массив непустых строк.
        //
        // Пустой массив игнорируется намеренно: иначе пользователь мог бы
        // остаться без вариантов выбора в интерфейсе. Удалить все размеры —
        // это всегда ошибка, а не осознанное действие.
        if let Some(arr) = v.get("papers").and_then(|x| x.as_array()) {
            let cleaned: Vec<String> = arr
                .iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();

            if !cleaned.is_empty() {
                self.papers = cleaned;
            }
        }
    }

    fn to_value(&self) -> serde_json::Value {
        serde_json::json!({
            "printer": self.printer,
            "paper": self.paper,
            "idNum": self.id_num,
            "endLine": self.end_line,
            "hybrid": self.hybrid,
            "expand": self.expand,
            "running": self.running,
            "papers": self.papers,
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
            papers: v
                .get("papers")
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str())
                        .map(|s| s.to_string())
                        .collect::<Vec<_>>()
                })
                .filter(|v: &Vec<String>| !v.is_empty())
                .unwrap_or_else(default_papers),
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
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn apply_json_updates_only_present_keys() {
        let mut cfg = Config {
            printer: "HP".into(),
            paper: "40*30".into(),
            id_num: true,
            expand: 250,
            ..Config::default()
        };

        // Меняем только принтер — остальное должно остаться как было.
        cfg.apply_json(&json!({ "printer": "Zebra" }));

        assert_eq!(cfg.printer, "Zebra");
        assert_eq!(cfg.paper, "40*30", "бумага не должна меняться");
        assert!(cfg.id_num, "idNum не должен меняться");
        assert_eq!(cfg.expand, 250, "expand не должен меняться");
    }

    #[test]
    fn apply_json_ignores_unknown_keys() {
        let mut cfg = Config::default();
        let was = cfg.to_json();

        cfg.apply_json(&json!({
            "unknownField": 123,
            "another": "x",
            "printer": "OKI",
        }));

        assert_eq!(cfg.printer, "OKI");
        // Всё остальное не тронуто.
        let now = cfg.to_json();
        for key in ["paper", "idNum", "endLine", "hybrid", "expand", "running"] {
            assert_eq!(now[key], was[key], "ключ {key} не должен меняться");
        }
    }

    #[test]
    fn apply_json_rejects_wrong_types() {
        let mut cfg = Config {
            hybrid: false,
            expand: 500,
            ..Config::default()
        };

        // Строка вместо bool и строка вместо числа — игнорируются.
        cfg.apply_json(&json!({ "hybrid": "yes", "expand": "много" }));

        assert!(!cfg.hybrid);
        assert_eq!(cfg.expand, 500);
    }

    #[test]
    fn apply_json_clamps_expand_to_at_least_one() {
        let mut cfg = Config::default();

        cfg.apply_json(&json!({ "expand": 0 }));
        assert_eq!(cfg.expand, 1, "нулевой порог бессмыслен");

        cfg.apply_json(&json!({ "expand": -10 }));
        assert_eq!(cfg.expand, 1, "отрицательный порог тоже");
    }

    #[test]
    fn json_roundtrip_keeps_camel_case_keys() {
        let cfg = Config {
            printer: "P".into(),
            paper: "30*20".into(),
            id_num: true,
            end_line: true,
            hybrid: true,
            expand: 42,
            running: false,
            papers: default_papers(),
            theme: None,
            theme_style: None,
        };

        let v = cfg.to_json();
        // Ключи должны быть в camelCase — как в config.json.
        assert_eq!(v["idNum"], json!(true));
        assert_eq!(v["endLine"], json!(true));
        assert_eq!(v["expand"], json!(42));
        assert_eq!(v["running"], json!(false));

        let mut back = Config::default();
        back.apply_json(&v);
        assert_eq!(back.printer, "P");
        assert!(back.id_num && back.end_line && back.hybrid);
        assert_eq!(back.expand, 42);
        assert!(!back.running);
    }

    #[test]
    fn papers_default_when_missing_or_empty() {
        let mut cfg = Config::default();
        assert_eq!(cfg.papers().len(), 8);

        // Пустой список заменяется значениями по умолчанию.
        cfg.papers = vec![];
        assert_eq!(cfg.papers().len(), 8);

        // Пустой массив в JSON игнорируется — нельзя остаться без вариантов.
        cfg.papers = vec!["30*20".into()];
        cfg.apply_json(&json!({ "papers": [] }));
        assert_eq!(cfg.papers, vec!["30*20".to_string()]);
    }

    #[test]
    fn apply_json_accepts_custom_papers() {
        let mut cfg = Config::default();
        cfg.apply_json(&json!({ "papers": ["30*20", "100*150", " 55*33 "] }));

        assert_eq!(
            cfg.papers,
            vec!["30*20".to_string(), "100*150".to_string(), "55*33".to_string()],
            "пробелы обрезаются"
        );
    }

    #[test]
    fn apply_json_drops_non_string_papers() {
        let mut cfg = Config::default();
        cfg.apply_json(&json!({ "papers": ["30*20", 42, null, ""] }));
        assert_eq!(cfg.papers, vec!["30*20".to_string()]);
    }

    #[test]
    fn papers_survive_json_roundtrip() {
        let mut cfg = Config::default();
        cfg.apply_json(&json!({ "papers": ["A", "B"] }));

        let v = cfg.to_json();
        let mut back = Config::default();
        back.apply_json(&v);
        assert_eq!(back.papers, vec!["A".to_string(), "B".to_string()]);
    }
}
