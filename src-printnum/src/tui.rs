//! Режим TUI (`printnum.exe --tui`): полноценная замена окна настроек.
//!
//! # Зачем это нужно
//!
//! Десктопное окно построено на Slint и рисует через GDI — это работает
//! только на Windows. На отдельной машине без графического интерфейса
//! (или под удалённым доступом) нужен текстовый интерфейс, который умеет
//! всё то же самое: выбрать принтер и бумагу, включить печать, настроить
//! оформление этикетки.
//!
//! TUI переиспользует библиотечную часть (`config`, `server`, `service`,
//! `printer`) и не дублирует бизнес-логику: изменения идут через ту же
//! `config::update`, что и в окне.
//!
//! # Совместимость с Windows 7
//!
//! Модуль написан без сторонних крейтов: только std. Причина та же, что и
//! по всему проекту — свежие крейты для терминала тянут `windows-sys`
//! с импортами, отсутствующими в Windows 7 (см. комментарий в `Cargo.toml`).
//!
//! # Управление
//!
//! - стрелки `↑`/`↓` — перемещение по строкам;
//! - `←`/`→` — предыдущее/следующее значение (для списков и чисел);
//! - `пробел` — переключить флажок;
//! - `Enter` — вступить в раздел;
//! - `Esc` — вернуться назад;
//! - `q` — выход.
//!
//! Ввод буферизуется в режиме «по строкам» (canonical mode) — библиотек
//! для raw-режима нет, поэтому управление работает клавишами с Enter.
//! Это осознанное ограничение ради Win7: описано ниже.

use crate::{config, printer, print, server, service, settings};

/// Запрошен ли режим TUI.
pub fn is_tui_requested() -> bool {
    std::env::args().any(|a| a == "--tui")
}

/// Поднимает HTTP-сервер и запускает меню.
///
/// Порт берётся из `PRINTNUM_PORT`/`.env` — как и в GUI-режиме.
pub fn run_server_and_menu() -> std::io::Result<()> {
    server::spawn()?;
    println!("[tui] сервер запущен на {}", settings::base_url());

    let mut tui = Tui::new();
    while tui.run()? {}
    Ok(())
}

/// Разделы меню.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    /// Главный экран: статус и запуск печати.
    Main,
    /// Печать номера вручную.
    Manual,
}

/// Одна строка настроек: подпись, значение и способ его менять.
#[derive(Debug, Clone)]
struct Row {
    label: String,
    /// Текущее значение для отображения.
    value: String,
    /// Можно ли менять стрелками `←`/`→`.
    adjustable: bool,
    /// Переключается ли пробелом.
    toggleable: bool,
}

/// Состояние интерфейса: раздел, позиция курсора и лог событий.
pub struct Tui {
    section: Section,
    cursor: usize,
    /// Последние сообщения для вывода (ограниченный буфер).
    log: Vec<String>,
}

impl Tui {
    pub fn new() -> Self {
        let mut tui = Self {
            section: Section::Main,
            cursor: 0,
            log: Vec::new(),
        };
        tui.log("TUI запущен. q — выход, Esc — назад.");
        tui
    }

    fn log(&mut self, msg: &str) {
        self.log.push(msg.to_string());
        // Храним только последние строки — иначе память растёт вечно.
        if self.log.len() > 12 {
            let excess = self.log.len() - 12;
            self.log.drain(0..excess);
        }
    }

    /// Текущие строки настроек для активного раздела.
    fn rows(&self) -> Vec<Row> {
        let cfg = config::get();

        match self.section {
            Section::Main => vec![
                Row {
                    label: "Печать".into(),
                    value: if cfg.running { "включена" } else { "выключена" }.into(),
                    adjustable: false,
                    toggleable: true,
                },
                Row {
                    label: "Принтер".into(),
                    value: if cfg.printer.trim().is_empty() {
                        "— не выбран —".into()
                    } else {
                        cfg.printer.clone()
                    },
                    adjustable: true,
                    toggleable: false,
                },
                Row {
                    label: "Этикетка (мм)".into(),
                    value: cfg.paper.clone(),
                    adjustable: true,
                    toggleable: false,
                },
                Row {
                    label: "Показывать ID".into(),
                    value: yes_no(cfg.id_num),
                    adjustable: false,
                    toggleable: true,
                },
                Row {
                    label: "Подчёркивание".into(),
                    value: yes_no(cfg.end_line),
                    adjustable: false,
                    toggleable: true,
                },
                Row {
                    label: "Гибридный формат".into(),
                    value: yes_no(cfg.hybrid),
                    adjustable: false,
                    toggleable: true,
                },
                Row {
                    label: "Начиная с номера".into(),
                    value: cfg.expand.to_string(),
                    adjustable: cfg.hybrid,
                    toggleable: false,
                },
                Row {
                    label: "Ручная печать".into(),
                    value: "ввести номер".into(),
                    adjustable: false,
                    toggleable: false,
                },
                Row {
                    label: "Состояние службы".into(),
                    value: service_status_text(),
                    adjustable: false,
                    toggleable: false,
                },
                Row {
                    label: "Адрес сервера".into(),
                    value: settings::base_url(),
                    adjustable: false,
                    toggleable: false,
                },
                Row {
                    label: "Версия".into(),
                    value: env!("CARGO_PKG_VERSION").into(),
                    adjustable: false,
                    toggleable: false,
                },
            ],
            Section::Manual => vec![Row {
                label: "Номер ячейки".into(),
                value: "(ввод текста)".into(),
                adjustable: false,
                toggleable: false,
            }],
        }
    }

    /// Рисует экран и ждёт команду.
    ///
    /// Возвращает `false`, если пользователь вышел (`q`/`Esc` на главном).
    pub fn run(&mut self) -> std::io::Result<bool> {
        let rows = self.rows();
        self.draw(&rows);

        // В режиме ручного ввода Enter — это отправка номера, а не меню.
        if self.section == Section::Manual {
            let mut line = String::new();
            if std::io::stdin().read_line(&mut line)? == 0 {
                self.section = Section::Main;
                return Ok(true);
            }
            let line = line.trim();

            if line == "esc" || line == "Esc" {
                self.section = Section::Main;
                return Ok(true);
            }

            self.print_manual(line);
            self.section = Section::Main;
            return Ok(true);
        }

        let cmd = read_command()?;
        Ok(self.apply(cmd, &rows))
    }

    /// Обрабатывает команду. Возвращает `false`, если нужно завершить TUI.
    fn apply(&mut self, cmd: Command, rows: &[Row]) -> bool {
        match cmd {
            Command::Quit => return false,
            Command::Up => {
                if self.cursor > 0 {
                    self.cursor -= 1;
                }
            }
            Command::Down => {
                if self.cursor + 1 < rows.len() {
                    self.cursor += 1;
                }
            }
            Command::Enter => self.enter(),
            Command::Left => self.adjust(rows, -1),
            Command::Right => self.adjust(rows, 1),
            Command::Toggle => self.toggle(rows),
            Command::Unknown => self.log("Неизвестная команда."),
        }
        true
    }

    /// Отправляет номер из ручного ввода на печать.
    fn print_manual(&mut self, value: &str) {
        // Сначала проверяем исходный ввод: санитайзер вырезает кириллицу,
        // и 'Возврат-1' стал бы '-1' (числом). Фильтруем до очистки.
        let trimmed = value.trim();
        if trimmed.is_empty() {
            self.log("Пропуск: пустой номер.");
            return;
        }

        // Текстовые ячейки ('Возврат-1', 'Прямой поток-5') не печатаем:
        // Code128 кодирует только ASCII, кириллица не пройдёт.
        if !crate::cell::is_printable(trimmed) {
            self.log(&format!("Пропуск: ячейка с текстом («{trimmed}») не печатается."));
            return;
        }

        let text = crate::cell::sanitize_cell_number(trimmed);

        let cfg = config::get();
        if !print::is_dry_run()
            && (cfg.printer.trim().is_empty() || !printer::status_printer(&cfg.printer))
        {
            self.log("Пропуск: принтер не выбран или недоступен.");
            return;
        }

        match print::print_text(&text, &cfg) {
            Ok(()) => self.log(&format!("Напечатано: {text}")),
            Err(e) => self.log(&format!("Ошибка печати: {e}")),
        }
    }

    /// `Enter`: раздел «Ручная печать» уходит в режим ввода.
    fn enter(&mut self) {
        if self.section == Section::Main && self.cursor == 7 {
            self.section = Section::Manual;
            self.cursor = 0;
            return;
        }
        self.log("Эта строка не редактируется.");
    }

    /// `←`/`→`: смена значения для списков и чисел.
    fn adjust(&mut self, rows: &[Row], delta: i32) {
        let Some(row) = rows.get(self.cursor) else { return };
        if !row.adjustable {
            self.log("Строка не меняется стрелками.");
            return;
        }

        let label = row.label.clone();
        match label.as_str() {
            "Принтер" => {
                let list = printer::list_printers();
                if list.is_empty() {
                    self.log("Принтеры недоступны (на этой платформе список пуст).");
                    return;
                }
                let cur = config::get().printer;
                let pos = list.iter().position(|p| *p == cur).unwrap_or(0);
                let next = wrap(pos, list.len(), delta);
                let name = list[next].clone();
                let _ = config::update(|c| c.printer = name.clone());
                self.log(&format!("Принтер: {name}"));
            }
            "Этикетка (мм)" => {
                let cfg = config::get();
                let list = cfg.papers();
                let cur = cfg.paper;
                let pos = list.iter().position(|p| *p == cur).unwrap_or(0);
                let next = wrap(pos, list.len(), delta);
                let value = list[next].clone();
                let _ = config::update(|c| c.paper = value.clone());
                self.log(&format!("Этикетка: {value}"));
            }
            "Начиная с номера" => {
                let cur = config::get().expand;
                let next = (cur + delta as i64).max(1);
                let _ = config::update(|c| c.expand = next);
                self.log(&format!("Порог гибрида: {next}"));
            }
            _ => {}
        }
    }

    /// `Пробел`: переключение флажков.
    fn toggle(&mut self, rows: &[Row]) {
        let Some(row) = rows.get(self.cursor) else { return };
        if !row.toggleable {
            self.log("Строка не переключается пробелом.");
            return;
        }

        match row.label.as_str() {
            "Печать" => {
                let next = !config::get().running;
                let _ = config::update(|c| c.running = next);
                self.log(if next { "Печать включена." } else { "Печать выключена." });
            }
            "Показывать ID" => {
                let next = !config::get().id_num;
                let _ = config::update(|c| c.id_num = next);
                self.log(if next { "ID включён." } else { "ID выключен." });
            }
            "Подчёркивание" => {
                let next = !config::get().end_line;
                let _ = config::update(|c| c.end_line = next);
                self.log(if next { "Подчёркивание включено." } else { "Подчёркивание выключено." });
            }
            "Гибридный формат" => {
                let next = !config::get().hybrid;
                let _ = config::update(|c| c.hybrid = next);
                self.log(if next { "Гибрид включён." } else { "Гибрид выключен." });
            }
            _ => {}
        }
    }

    /// Рисует раздел и строки меню.
    fn draw(&self, rows: &[Row]) {
        // Полная очистка экрана: escape-последовательность, понятная
        // большинству терминалов Windows (включая командную строку).
        print!("\x1B[2J\x1B[H");
        println!("{}", "-".repeat(56));
        println!("  PrintNum — настройки печати        ({})", env!("CARGO_PKG_VERSION"));
        println!("{}", "-".repeat(56));
        println!();

        // Режим ручного ввода номера: показываем подсказку вместо меню.
        if self.section == Section::Manual {
            println!("  Введите номер ячейки (например, 163-1 или 500-47).");
            println!();
            println!("  Ячейки с текстом (Возврат-1, Прямой поток-5) печатать нельзя:");
            println!("  штрихкод Code128 кодирует только ASCII.");
            println!();
            println!("  Отправьте номер на печать из расширения браузера");
            println!("  или из приложения — TUI только показывает состояние.");
            println!();
            println!("{}", "-".repeat(56));
            println!("  Esc — назад");
            return;
        }

        for (i, row) in rows.iter().enumerate() {
            let marker = if i == self.cursor { "»" } else { " " };
            let hint = match (row.adjustable, row.toggleable) {
                (true, _) => "  (←/→)",
                (_, true) => "  (пробел)",
                _ => "",
            };
            println!(
                "  {} {:<22} {:<18}{}",
                marker, row.label, row.value, hint
            );
        }

        println!();
        println!("{}", "-".repeat(56));

        // Лог последних событий.
        println!("  События:");
        for line in &self.log {
            println!("    {}", line);
        }

        println!("{}", "-".repeat(56));
        println!("  ↑/↓ — выбор   ←/→ — значение   пробел — вкл/выкл");
        println!("  Enter — открыть   Esc — назад   q — выход");
    }
}

/// Читает одну команду из stdin (режим по строкам).
///
/// Управление работает клавишами с Enter: это осознанное ограничение.
/// Для raw-режима нужен крейт вроде `crossterm`, а он тянет `windows-sys`
/// с импортами, которых нет в Windows 7. Ради совместимости управление
/// стало «командой на строку».
fn read_command() -> std::io::Result<Command> {
    let mut line = String::new();

    // `read_line` возвращает `Ok(0)` на конец потока — это не Enter,
    // а закрытие ввода (например, при запуске без консоли или `--tui`
    // из скрипта без stdin). Без этого различия цикл зациклился бы.
    if std::io::stdin().read_line(&mut line)? == 0 {
        return Ok(Command::Enter);
    }

    // Пробел — переключение; пустая строка (Enter) — открыть/подтвердить.
    // Раньше пробельная строка после `trim()` становилась пустой и матчилась
    // как `Enter`, из-за чего переключение флажков не работало.
    let raw = line.trim_end_matches(['\n', '\r']);
    if raw == " " {
        return Ok(Command::Toggle);
    }

    let line = raw.trim();
    Ok(match line {
        "q" | "Q" | "exit" => Command::Quit,
        "w" | "W" | "up" => Command::Up,
        "s" | "S" | "down" => Command::Down,
        "a" | "A" | "left" => Command::Left,
        "d" | "D" | "right" => Command::Right,
        "" | "enter" => Command::Enter,
        "space" | "toggle" => Command::Toggle,
        _ => Command::Unknown,
    })
}

/// Команда пользователя.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    Up,
    Down,
    Left,
    Right,
    Enter,
    Toggle,
    Quit,
    Unknown,
}

/// Индекс с переносом: `pos + delta`, зацикленный на `len`.
fn wrap(pos: usize, len: usize, delta: i32) -> usize {
    let len = len.max(1) as i64;
    let pos = pos as i64;
    let next = (pos + delta as i64).rem_euclid(len);
    next as usize
}

fn yes_no(v: bool) -> String {
    if v { "да".into() } else { "нет".into() }
}

/// Короткое состояние службы для отображения в меню.
fn service_status_text() -> String {
    if service::is_autostart_installed() {
        "в автозагрузке".into()
    } else {
        "не установлена".into()
    }
}
