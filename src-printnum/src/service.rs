//! Режим службы (`--service`): HTTP-сервер без GUI.
//!
//! # Зачем это нужно
//!
//! Обычный запуск `printnum.exe` поднимает и GUI, и HTTP-сервер в одном
//! процессе. Если пользователь закрывает окно, HTTP-сервер умирает вместе
//! с ним, и браузерное расширение перестаёт печатать.
//!
//! Режим службы решает эту проблему: `printnum.exe --service` держит только
//! HTTP-сервер, а окно настроек можно закрывать. Настройки, сохранённые в
//! окне, подхватываются на лету (см. [`watch_config`]) — перезапускать
//! службу не нужно.
//!
//! # Почему не настоящая Windows-служба (SCM)
//!
//! Служба через Service Control Manager потребовала бы крейт `windows-service`
//! и свежие `windows-sys`, которые статически импортируют функции, отсутствующие
//! в Windows 7 (`WaitOnAddress`, `api-ms-win-core-synch-l1-2-0.dll`). Это ровно
//! та проблема, ради которой весь проект собирается с таргетом
//! `x86_64-win7-windows-msvc`. Кроме того, установка SCM-службы требует прав
//! администратора.
//!
//! Поэтому используется обычный фоновый процесс, который ставится в
//! автозагрузку пользователя (см. [`install_autostart`]).
//!
//! # Управление
//!
//! ```text
//! printnum.exe --service              запустить службу (блокирующе)
//! printnum.exe --install-autostart    добавить в автозагрузку и запустить
//! printnum.exe --uninstall-autostart  убрать из автозагрузки
//! printnum.exe --service-status       показать состояние
//! ```
//!
//! Остановка службы — обычным завершением процесса (Диспетчер задач,
//! `taskkill /IM printnum.exe /F`). Отдельного IPC-канала для управления
//! не делаем: он не нужен, а на Win7 добавляет риск.

use crate::config;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Как часто проверяется mtime файла конфигурации.
///
/// Секунда — компромисс: правка настроек в UI подхватывается практически
/// мгновенно, а нагрузка на диск (один `metadata()`) пренебрежимо мала.
const WATCH_INTERVAL: Duration = Duration::from_secs(1);

/// Запрошен ли режим службы.
pub fn is_service_requested() -> bool {
    std::env::args().any(|a| a == "--service")
}

/// Запрошена ли установка в автозагрузку.
pub fn is_install_requested() -> bool {
    std::env::args().any(|a| a == "--install-autostart")
}

/// Запрошено ли удаление из автозагрузки.
pub fn is_uninstall_requested() -> bool {
    std::env::args().any(|a| a == "--uninstall-autostart")
}

/// Запрошен ли вывод состояния.
pub fn is_status_requested() -> bool {
    std::env::args().any(|a| a == "--service-status")
}

/// Время последней модификации файла, либо `None`, если файла нет.
fn modified_time(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// Следит за файлом конфигурации и перечитывает его при изменениях.
///
/// Сравнивается время модификации: если `config.json` изменил другой процесс
/// (GUI, сохранение настроек), файл перечитывается через [`config::reload`].
///
/// Функция работает вечно и вызывается из отдельного потока.
pub fn watch_config() {
    let path = config::config_path();

    // Отпечаток на старте: если файл уже есть, дальше реагируем только
    // на реальные изменения, а не на первый же тик.
    let mut last_seen: Option<SystemTime> = modified_time(&path);

    println!("[service] слежение за конфигом: {}", path.display());

    loop {
        std::thread::sleep(WATCH_INTERVAL);

        let current = modified_time(&path);

        // Файл появился, изменился или был удалён.
        if current != last_seen {
            last_seen = current;

            match current {
                Some(_) => {
                    let cfg = config::reload();
                    println!(
                        "[service] конфиг перечитан: running={}, printer='{}', paper='{}'",
                        cfg.running, cfg.printer, cfg.paper
                    );
                }
                None => {
                    // Файл удалён (сброс настроек) — возвращаемся к значениям
                    // по умолчанию, чтобы служба не работала со старым кэшем.
                    let cfg = config::reload();
                    println!("[service] конфиг удалён, применены значения по умолчанию");
                    let _ = cfg;
                }
            }
        }
    }
}

// ============================================================================
// Автозагрузка пользователя
// ============================================================================

/// Путь к ярлыку/скрипту автозагрузки.
///
/// Используется папка «Автозагрузка» текущего пользователя — она не требует
/// прав администратора, в отличие от ветки `HKLM\...\Run` или SCM.
///
/// `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PrintNum.cmd`
pub fn autostart_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(
        PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup")
            .join("PrintNum.cmd"),
    )
}

/// Добавляет службу в автозагрузку текущего пользователя.
///
/// Создаётся `.cmd`, запускающий `printnum.exe --service` в скрытом режиме.
/// Права администратора не требуются.
pub fn install_autostart() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let target = autostart_path().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "переменная окружения APPDATA недоступна",
        )
    })?;

    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }

    // `start "" /min` — запуск свёрнутым, чтобы не мигало окно консоли.
    // Кавычки вокруг пути нужны: в путях Windows часто есть пробелы.
    let content = format!(
        "@echo off\r\n\
         REM PrintNum — автозапуск службы печати (создано приложением).\r\n\
         start \"\" /min \"{}\" --service\r\n",
        exe.display()
    );

    std::fs::write(&target, content)?;
    Ok(target)
}

/// Убирает службу из автозагрузки.
///
/// Отсутствие файла не считается ошибкой — результат тот же.
pub fn uninstall_autostart() -> std::io::Result<Option<PathBuf>> {
    let Some(target) = autostart_path() else {
        return Ok(None);
    };

    match std::fs::remove_file(&target) {
        Ok(()) => Ok(Some(target)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Установлена ли служба в автозагрузку.
pub fn is_autostart_installed() -> bool {
    autostart_path().map(|p| p.exists()).unwrap_or(false)
}

/// Печатает состояние службы и автозагрузки.
pub fn print_status() {
    println!("PrintNum — состояние службы");
    println!("  Каталог данных: {}", config::app_dir().display());
    println!("  Конфиг:         {}", config::config_path().display());

    match autostart_path() {
        Some(p) => {
            let installed = p.exists();
            println!("  Автозагрузка:   {}", if installed { "включена" } else { "выключена" });
            println!("  Файл:           {}", p.display());
        }
        None => println!("  Автозагрузка:   недоступна (нет APPDATA)"),
    }

    let cfg = config::get();
    println!("  Печать:         {}", if cfg.running { "включена" } else { "выключена" });
    println!("  Принтер:        {}", if cfg.printer.trim().is_empty() { "—" } else { &cfg.printer });
    println!("  Адрес сервера:  {}", crate::settings::base_url());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_path_points_to_startup_folder() {
        // Тест зависит от APPDATA, поэтому проверяем только при её наличии.
        if std::env::var_os("APPDATA").is_none() {
            return;
        }
        let path = autostart_path().expect("путь должен вычисляться при наличии APPDATA");
        assert!(path.ends_with("PrintNum.cmd"));
        assert!(path.to_string_lossy().contains("Startup"));
    }

    #[test]
    fn modified_time_is_none_for_missing_file() {
        let missing = std::env::temp_dir().join("printnum-нет-такого-файла.json");
        assert!(modified_time(&missing).is_none());
    }
}