//! Валидация номеров ячеек.
//!
//! Правило одно: на печать уходят только ячейки, состоящие из цифр и
//! дефисов. Текстовые ячейки ('Возврат-1', 'Прямой поток-5') пропускаются,
//! потому что штрихкод Code128 кодирует только ASCII (см. `barcode.rs`).
//!
//! Функции используются в двух местах:
//! - HTTP-обработчиком (`/print-number`) — проверка перед печатью;
//! - TUI (`--tui`) — ручной ввод номера.
//!
//! В расширении браузера та же проверка продублирована в TS
//! (`CELL_PRINTABLE_RE` в `extension/src/utils/constants.ts`) — там нет
//! доступа к Rust-коду, поэтому при изменении правил обновляйте оба места.

/// Оставляет только ASCII-цифры и дефисы, убирает пробелы по краям.
///
/// Используется для ручного ввода: пользователь мог ввести лишние символы
/// (« 163 - 1 »), и они будут отброшены перед печатью.
pub fn sanitize_cell_number(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '-')
        .collect()
}

/// Можно ли печатать этот номер.
///
/// `true` только для строк, состоящих из цифр, дефисов и пробелов
/// (пробелы внутри нормализуются санитайзером: «163 - 1» → «163-1»).
/// Текстовые ячейки — `false`: любая буква (в т.ч. кириллица) означает,
/// что это не номер.
///
/// Примеры:
/// - `"163-1"` → `true`
/// - `"163 - 1"` → `true` (пробелы нормализуются)
/// - `"Возврат-1"` → `false`
/// - `"Прямой поток-5"` → `false`
/// - `"163A-1"` → `false`
/// - `""` → `false`
pub fn is_printable(value: &str) -> bool {
    value.chars().all(|c| c.is_ascii_digit() || c == '-' || c.is_whitespace())
        && value.chars().any(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printable_numeric_cells() {
        assert!(is_printable("1-1"));
        assert!(is_printable("163-1"));
        assert!(is_printable("5-3"));
        assert!(is_printable("123-47"));
    }

    #[test]
    fn text_cells_are_not_printable() {
        assert!(!is_printable("Возврат-1"));
        assert!(!is_printable("Прямой поток-5"));
        assert!(!is_printable("163A-1"));
        assert!(!is_printable(""));
        assert!(!is_printable("-"));
        assert!(!is_printable("  "));
    }

    #[test]
    fn spaces_inside_are_printable() {
        assert!(is_printable("163 - 1"));
        assert!(is_printable(" 163-1 "));
    }

    #[test]
    fn sanitize_strips_spaces_and_letters() {
        assert_eq!(sanitize_cell_number(" 163 - 1 "), "163-1");
        assert_eq!(sanitize_cell_number("Прямой поток-5"), "-5");
        assert_eq!(sanitize_cell_number("123-47"), "123-47");
        assert_eq!(sanitize_cell_number("abc"), "");
    }
}
