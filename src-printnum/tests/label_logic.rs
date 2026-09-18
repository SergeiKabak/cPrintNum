//! Юнит-тесты бизнес-логики разбора текста этикетки.
//! Проверяют паритет с прежней реализацией `prepare_label_data` (Python).

use printnum::config::Config;
use printnum::print::prepare_label_data;

fn config(hybrid: bool, id_num: bool, end_line: bool, expand: i64) -> Config {
    let mut c = Config::default();
    c.hybrid = hybrid;
    c.id_num = id_num;
    c.end_line = end_line;
    c.expand = expand;
    c
}

#[test]
fn plain_number_without_id() {
    // "123" → главный текст "123.", header отсутствует.
    let data = prepare_label_data("123", &config(false, false, false, 500));
    assert_eq!(data.main_text, "123.");
    assert_eq!(data.header_text, "");
    assert!(!data.show_header);
    assert!(!data.is_bold);
    assert!(!data.is_underlined);
}

#[test]
fn number_with_header_and_id() {
    // "123-47" → main "123.", header "-47", показывать ID.
    let data = prepare_label_data("123-47", &config(false, true, false, 500));
    assert_eq!(data.main_text, "123.");
    assert_eq!(data.header_text, "-47");
    assert!(data.show_header);
    assert!(!data.force_left_header);
}

#[test]
fn header_hidden_when_id_disabled() {
    let data = prepare_label_data("123-47", &config(false, false, false, 500));
    assert_eq!(data.header_text, "");
    assert!(!data.show_header);
}

#[test]
fn end_line_uses_underline_instead_of_dot() {
    let data = prepare_label_data("123", &config(false, false, true, 500));
    assert_eq!(data.main_text, "123");
    assert!(data.is_underlined);
}

#[test]
fn hybrid_below_threshold_is_not_bold() {
    // 400 < 500 → не жирный, без swap.
    let data = prepare_label_data("400-47", &config(true, true, false, 500));
    assert!(!data.is_bold);
    assert_eq!(data.main_text, "400.");
    assert_eq!(data.header_text, "-47");
}

#[test]
fn hybrid_at_or_above_threshold_swaps() {
    // 500 >= 500 → жирный, swap: header="500", main="47".
    let data = prepare_label_data("500-47", &config(true, true, false, 500));
    assert!(data.is_bold);
    assert_eq!(data.main_text, "47.");
    assert_eq!(data.header_text, "500-");
    assert!(data.force_left_header);
    assert!(data.show_header);
}

#[test]
fn kgt_always_bold_and_swapped() {
    // "КГТ-1" → всегда срабатывает hybrid+expand.
    let data = prepare_label_data("КГТ-1", &config(false, false, false, 500));
    assert!(data.is_bold);
    assert_eq!(data.main_text, "1.");
    assert_eq!(data.header_text, "КГТ-");
    assert!(data.force_left_header);
}

#[test]
fn kgt_without_numeric_header_is_not_bold() {
    let data = prepare_label_data("КГТ-АБ", &config(false, false, false, 500));
    assert!(!data.is_bold);
}
