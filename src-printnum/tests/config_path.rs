//! Тесты расположения файла конфигурации по платформам.
//!
//! Проверяют, что `app_dir()` выбирает корректную базовую директорию
//! и НЕ создаёт непредсказуемую папку рядом с бинарником.
//!
//! Тесты манипулируют переменными окружения, поэтому выполняются
//! последовательно (общий `Mutex`) во избежание гонок.

use std::sync::Mutex;

use printnum::config::{app_dir, config_path};

/// Глобальный замок: переменные окружения — общий ресурс процесса.
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn with_env<F: FnOnce()>(vars: &[(&str, Option<&str>)], f: F) {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // Сохраняем прежние значения, чтобы восстановить после теста.
    let saved: Vec<(String, Option<String>)> = vars
        .iter()
        .map(|(k, _)| (k.to_string(), std::env::var(k).ok()))
        .collect();

    for (k, v) in vars {
        match v {
            Some(val) => std::env::set_var(k, val),
            None => std::env::remove_var(k),
        }
    }

    f();

    for (k, v) in saved {
        match v {
            Some(val) => std::env::set_var(&k, val),
            None => std::env::remove_var(&k),
        }
    }
}

#[test]
#[cfg(windows)]
fn windows_uses_appdata() {
    with_env(&[("APPDATA", Some(r"C:\Users\Test\AppData\Roaming"))], || {
        let dir = app_dir();
        assert_eq!(
            dir,
            std::path::PathBuf::from(r"C:\Users\Test\AppData\Roaming").join("PrintNum")
        );
    });
}

#[test]
#[cfg(target_os = "macos")]
fn macos_uses_application_support() {
    with_env(&[("HOME", Some("/Users/tester"))], || {
        // app_dir() создаёт каталог — используем временный HOME, чтобы не мусорить.
        let dir = app_dir();
        assert_eq!(
            dir,
            std::path::PathBuf::from("/Users/tester")
                .join("Library/Application Support")
                .join("PrintNum")
        );
    });
}

#[test]
#[cfg(all(not(windows), not(target_os = "macos")))]
fn linux_uses_xdg_config_home() {
    with_env(
        &[
            ("XDG_CONFIG_HOME", Some("/tmp/xdg-config")),
            ("HOME", Some("/home/tester")),
        ],
        || {
            let dir = app_dir();
            assert_eq!(dir, std::path::PathBuf::from("/tmp/xdg-config").join("PrintNum"));
        },
    );
}

#[test]
#[cfg(all(not(windows), not(target_os = "macos")))]
fn linux_falls_back_to_home_dot_config() {
    with_env(
        &[
            ("XDG_CONFIG_HOME", None),
            ("HOME", Some("/home/tester")),
        ],
        || {
            let dir = app_dir();
            assert_eq!(
                dir,
                std::path::PathBuf::from("/home/tester").join(".config").join("PrintNum")
            );
        },
    );
}

/// `config_path()` всегда лежит внутри `app_dir()` и называется `config.json`.
#[test]
fn config_path_is_inside_app_dir() {
    // Берём тот же замок, что и env-тесты, иначе `app_dir()` может прочитать
    // переменные, изменённые другим тестом, выполняющимся параллельно.
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let dir = app_dir();
    let path = config_path();
    assert_eq!(path.file_name().and_then(|s| s.to_str()), Some("config.json"));
    assert_eq!(path.parent(), Some(dir.as_path()));
}
