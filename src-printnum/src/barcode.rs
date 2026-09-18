//! Генератор штрихкодов Code128 (Auto: A/B/C).
//!
//! Платформонезависимая часть (таблицы, кодирование) + отрисовка через GDI
//! (cfg(windows)). Возвращает массив модулей для построения изображения.

/// Таблицы паттернов Code128 (значения 0..106).
/// Каждый паттерн — 6 чисел: ширины чередующихся штрихов/пробелов в модулях.
const PATTERNS: [[u8; 6]; 106] = [
    [2, 1, 2, 2, 2, 2], [2, 2, 2, 1, 2, 2], [2, 2, 2, 2, 2, 1], [1, 2, 1, 2, 2, 3],
    [1, 2, 1, 3, 2, 2], [1, 3, 1, 2, 2, 2], [1, 2, 2, 2, 1, 3], [1, 2, 2, 3, 1, 2],
    [1, 3, 2, 2, 1, 2], [2, 2, 1, 2, 1, 3], [2, 2, 1, 3, 1, 2], [2, 3, 1, 2, 1, 2],
    [1, 1, 2, 2, 3, 2], [1, 2, 2, 1, 3, 2], [1, 2, 2, 2, 3, 1], [1, 1, 3, 2, 2, 2],
    [1, 2, 3, 1, 2, 2], [1, 2, 3, 2, 2, 1], [2, 2, 3, 2, 1, 1], [2, 2, 1, 1, 3, 2],
    [2, 2, 1, 2, 3, 1], [2, 1, 3, 2, 1, 2], [2, 2, 3, 1, 1, 2], [3, 1, 2, 1, 3, 1],
    [3, 1, 1, 2, 2, 2], [3, 2, 1, 1, 2, 2], [3, 2, 1, 2, 2, 1], [3, 1, 2, 2, 1, 2],
    [3, 2, 2, 1, 1, 2], [3, 2, 2, 2, 1, 1], [2, 1, 2, 1, 2, 3], [2, 1, 2, 3, 2, 1],
    [2, 3, 2, 1, 2, 1], [1, 1, 1, 3, 2, 3], [1, 3, 1, 1, 2, 3], [1, 3, 1, 3, 2, 1],
    [1, 1, 2, 3, 1, 3], [1, 3, 2, 1, 1, 3], [1, 3, 2, 3, 1, 1], [2, 1, 1, 3, 1, 3],
    [2, 3, 1, 1, 1, 3], [2, 3, 1, 3, 1, 1], [1, 1, 2, 1, 3, 3], [1, 1, 2, 3, 3, 1],
    [1, 3, 2, 1, 3, 1], [1, 1, 3, 1, 2, 3], [1, 1, 3, 3, 2, 1], [1, 3, 3, 1, 2, 1],
    [3, 1, 3, 1, 2, 1], [2, 1, 1, 3, 3, 1], [2, 3, 1, 1, 3, 1], [2, 1, 3, 1, 1, 3],
    [2, 1, 3, 3, 1, 1], [2, 1, 3, 1, 3, 1], [3, 1, 1, 1, 2, 3], [3, 1, 1, 3, 2, 1],
    [3, 3, 1, 1, 2, 1], [3, 1, 2, 1, 1, 3], [3, 1, 2, 3, 1, 1], [3, 3, 2, 1, 1, 1],
    [3, 1, 4, 1, 1, 1], [2, 2, 1, 4, 1, 1], [4, 3, 1, 1, 1, 1], [1, 1, 1, 2, 2, 4],
    [1, 1, 1, 4, 2, 2], [1, 2, 1, 1, 2, 4], [1, 2, 1, 4, 2, 1], [1, 4, 1, 1, 2, 2],
    [1, 4, 1, 2, 2, 1], [1, 1, 2, 2, 1, 4], [1, 1, 2, 4, 1, 2], [1, 2, 2, 1, 1, 4],
    [1, 2, 2, 4, 1, 1], [1, 4, 2, 1, 1, 2], [1, 4, 2, 2, 1, 1], [2, 4, 1, 2, 1, 1],
    [2, 2, 1, 1, 1, 4], [4, 1, 3, 1, 1, 1], [2, 4, 1, 1, 1, 2], [1, 3, 4, 1, 1, 1],
    [1, 1, 1, 2, 4, 2], [1, 2, 1, 1, 4, 2], [1, 2, 1, 2, 4, 1], [1, 1, 4, 2, 1, 2],
    [1, 2, 4, 1, 1, 2], [1, 2, 4, 2, 1, 1], [4, 1, 1, 2, 1, 2], [4, 2, 1, 1, 1, 2],
    [4, 2, 1, 2, 1, 1], [2, 1, 2, 1, 4, 1], [2, 1, 4, 1, 2, 1], [4, 1, 2, 1, 2, 1],
    [1, 1, 1, 1, 4, 3], [1, 1, 1, 3, 4, 1], [1, 3, 1, 1, 4, 1], [1, 1, 4, 1, 1, 3],
    [1, 1, 4, 3, 1, 1], [4, 1, 1, 1, 1, 3], [4, 1, 1, 3, 1, 1], [1, 1, 3, 1, 4, 1],
    [1, 1, 4, 1, 3, 1], [3, 1, 1, 1, 4, 1], [4, 1, 1, 1, 3, 1], [2, 1, 1, 4, 1, 2],
    [2, 1, 1, 2, 1, 4], [2, 1, 1, 2, 3, 2],
];

/// Stop-паттерн (значение 106): 13 модулей.
const STOP_PATTERN: [u8; 7] = [2, 3, 3, 1, 1, 1, 2];

const START_B: u8 = 104;
const START_C: u8 = 105;
const CODE_B: u8 = 100;
const CODE_C: u8 = 99;

/// Результат кодирования.
pub struct Barcode128 {
    pub text: String,
    /// Массив модулей: `true` — штрих, `false` — пробел.
    pub modules: Vec<bool>,
}

impl Barcode128 {
    /// Общая ширина в модулях.
    pub fn module_count(&self) -> usize {
        self.modules.len()
    }
}

fn is_digit(b: u8) -> bool {
    b.is_ascii_digit()
}

/// Количество цифр подряд, начиная с позиции `pos`.
fn count_leading_digits(bytes: &[u8], pos: usize) -> usize {
    let mut n = 0;
    while pos + n < bytes.len() && is_digit(bytes[pos + n]) {
        n += 1;
    }
    n
}

/// Кодирует строку в Code128 (Auto: C для цифровых пар, B для остального).
pub fn encode_code128(input: &str) -> Result<Barcode128, String> {
    if input.is_empty() {
        return Err("Пустая строка: нечего кодировать".into());
    }

    let bytes = input.as_bytes();
    for &b in bytes {
        if !(32..=127).contains(&b) {
            return Err(format!(
                "Недопустимый символ с кодом {b}: Code128B поддерживает ASCII 32..127"
            ));
        }
    }

    let mut codes: Vec<u8> = Vec::new();
    let mut pos = 0usize;

    // Стартовый набор: C — если строка начинается с 4+ цифр, иначе B.
    let leading = count_leading_digits(bytes, 0);
    let mut current_c = leading >= 4;
    codes.push(if current_c { START_C } else { START_B });

    while pos < bytes.len() {
        if current_c {
            let pair = pos + 1 < bytes.len() && is_digit(bytes[pos]) && is_digit(bytes[pos + 1]);
            if pair {
                let value = (bytes[pos] - b'0') * 10 + (bytes[pos + 1] - b'0');
                codes.push(value);
                pos += 2;
            } else {
                codes.push(CODE_B);
                current_c = false;
            }
        } else {
            let run = count_leading_digits(bytes, pos);
            let at_end = pos + run >= bytes.len();
            if run >= 4 && (at_end || run % 2 == 0) {
                codes.push(CODE_C);
                current_c = true;
                continue;
            }
            codes.push(bytes[pos] - 32);
            pos += 1;
        }
    }

    // Контрольная сумма: start + Σ(value_i * i), mod 103.
    let mut checksum = codes[0] as u32;
    for (i, &c) in codes.iter().enumerate().skip(1) {
        checksum += (c as u32) * (i as u32);
    }
    checksum %= 103;

    let mut all = codes.clone();
    all.push(checksum as u8);
    all.push(106); // stop

    // Разворачиваем паттерны в модули.
    let mut modules: Vec<bool> = Vec::new();
    for &code in &all {
        let mut bar = true;
        if code == 106 {
            for &w in STOP_PATTERN.iter() {
                for _ in 0..w {
                    modules.push(bar);
                }
                bar = !bar;
            }
        } else {
            let pattern = PATTERNS[code as usize];
            for &w in pattern.iter() {
                for _ in 0..w {
                    modules.push(bar);
                }
                bar = !bar;
            }
        }
    }

    Ok(Barcode128 {
        text: input.to_string(),
        modules,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structure_is_valid() {
        // start + data + checksum — по 11 модулей, stop — 13.
        for text in ["A", "AB", "1234", "1234567890", "ii18725308927", "ABC-123"] {
            let bc = encode_code128(text).unwrap();
            let n = bc.module_count();
            assert_eq!((n - 13) % 11, 0, "текст {text}: {n} модулей");
        }
    }

    #[test]
    fn known_code128c_example() {
        // "1234" в Code128C: startC + 12 + 34 + checksum + stop = 57 модулей.
        let bc = encode_code128("1234").unwrap();
        assert_eq!(bc.module_count(), 57);
    }

    #[test]
    fn single_char_length() {
        let bc = encode_code128("A").unwrap();
        assert_eq!(bc.module_count(), 46);
    }

    #[test]
    fn rejects_empty() {
        assert!(encode_code128("").is_err());
    }

    #[test]
    fn rejects_non_ascii() {
        assert!(encode_code128("привет").is_err());
    }

    #[test]
    fn modules_start_with_bar() {
        let bc = encode_code128("ii18725308927").unwrap();
        assert!(bc.modules[0], "первый модуль должен быть штрихом");
    }
}