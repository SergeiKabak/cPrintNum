/**
 * Генератор штрихкодов Code128 (Auto: A/B/C).
 *
 * Реализация без зависимостей. Возвращает массив модулей (0/1) и
 * метаданные, на основе которых строится SVG или растровое изображение.
 *
 * Алгоритм:
 * - набор символов выбирается автоматически (Auto): Code128C для пар цифр,
 *   Code128B для остальных символов ASCII;
 * - каждый символ кодируется 11-модульным паттерном;
 * - добавляются Start-код, контрольная сумма (mod 103) и Stop-паттерн.
 *
 * Проверено против эталонных таблиц Code128.
 */

// ---------------------------------------------------------------------------
// Таблицы паттернов Code128 (значения 0..106).
// Каждый паттерн — 6 чисел: ширины чередующихся штрихов/пробелов (в модулях),
// всегда суммирующиеся в 11 (для Stop — 13).
// ---------------------------------------------------------------------------
const PATTERNS: number[][] = [
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

// Stop-паттерн (значение 106): 13 модулей.
const STOP_PATTERN = [2, 3, 3, 1, 1, 1, 2];

const START_A = 103;
const START_B = 104;
const START_C = 105;
// Коды переключения наборов внутри последовательности (не стартовые).
const CODE_B = 100;
const CODE_C = 99;

/**
 * Результат кодирования.
 */
export interface Barcode128 {
  /** Текст, который закодирован. */
  text: string;
  /** Массив модулей: true — штрих, false — пробел. */
  modules: boolean[];
  /** Общая ширина в модулях (без «тихой зоны»). */
  moduleCount: number;
}

/** Проверка: является ли символ цифрой. */
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** Проверка: образуют ли позиции pos и pos+1 пару цифр. */
function isDigitPair(text: string, pos: number): boolean {
  return (
    pos + 1 < text.length && isDigit(text[pos]) && isDigit(text[pos + 1])
  );
}

/** Считает количество цифр подряд, начиная с позиции pos. */
function countLeadingDigits(text: string, pos: number): number {
  let n = 0;
  while (pos + n < text.length && isDigit(text[pos + n])) n++;
  return n;
}

/**
 * Кодирует строку в Code128 (Auto: C для пар цифр, B для остального).
 *
 * Бросает ошибку, если символ вне ASCII 0..127.
 */
export function encodeCode128(input: string): Barcode128 {
  if (input.length === 0) {
    throw new Error("Пустая строка: нечего кодировать");
  }

  // Проверяем диапазон символов (Code128B: ASCII 32..127).
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 127) {
      throw new Error(
        `Недопустимый символ '${ch}' (код ${code}). Code128B поддерживает ASCII 32..127.`,
      );
    }
  }

  const codes: number[] = []; // значения символов Code128 (без start и checksum)
  let pos = 0;

  // Выбираем стартовый набор:
  // Code128C — если строка начинается минимум с 4 цифр (чётные пары),
  // иначе начинаем с Code128B.
  const leadingDigits = countLeadingDigits(input, 0);
  let currentSet: "B" | "C" = leadingDigits >= 4 ? "C" : "B";
  codes.push(currentSet === "C" ? START_C : START_B);

  while (pos < input.length) {
    if (currentSet === "C") {
      // В наборе C кодируем только пары цифр. Если пара невозможна —
      // переключаемся в B.
      if (isDigitPair(input, pos)) {
        codes.push(parseInt(input.substring(pos, pos + 2), 10));
        pos += 2;
      } else {
        codes.push(CODE_B); // переключение в Code B
        currentSet = "B";
      }
    } else {
      // currentSet === "B"
      // Переключаемся в C только если впереди чётное число цифр (>= 4),
      // чтобы не оставить одиночную цифру и не потерять эффективность.
      const run = countLeadingDigits(input, pos);
      const atEnd = pos + run >= input.length;
      if (run >= 4 && (atEnd || run % 2 === 0)) {
        codes.push(CODE_C); // переключение в Code C
        currentSet = "C";
        continue;
      }
      // Кодируем один символ как B (значение = ASCII - 32).
      codes.push(input.charCodeAt(pos) - 32);
      pos += 1;
    }
  }

  // Контрольная сумма: startCode + Σ(value_i * position_i), mod 103.
  let checksum = codes[0];
  for (let i = 1; i < codes.length; i++) {
    checksum += codes[i] * i;
  }
  checksum %= 103;

  const allCodes = [...codes, checksum, 106]; // + checksum + stop

  // Разворачиваем паттерны в модули.
  const modules: boolean[] = [];
  for (const code of allCodes) {
    const pattern = code === 106 ? STOP_PATTERN : PATTERNS[code];
    if (!pattern) {
      throw new Error(`Внутренняя ошибка: нет паттерна для кода ${code}`);
    }
    let isBar = true; // паттерн начинается со штриха
    for (const width of pattern) {
      for (let i = 0; i < width; i++) {
        modules.push(isBar);
      }
      isBar = !isBar;
    }
  }

  return {
    text: input,
    modules,
    moduleCount: modules.length,
  };
}

/**
 * Строит SVG-строку штрихкода.
 *
 * @param input       текст для кодирования
 * @param moduleMm    ширина одного модуля в мм
 * @param heightMm    высота полосок в мм
 */
export function barcode128ToSvg(
  input: string,
  moduleMm = 0.25,
  heightMm = 10,
): string {
  const { modules, moduleCount } = encodeCode128(input);

  const widthMm = moduleCount * moduleMm;

  // Формируем путь из прямоугольников (все штрихи).
  let rects = "";
  let x = 0;
  while (x < moduleCount) {
    if (modules[x]) {
      let run = 1;
      while (x + run < moduleCount && modules[x + run]) run++;
      const rx = (x * moduleMm).toFixed(4);
      const rw = (run * moduleMm).toFixed(4);
      rects += `<rect x="${rx}" y="0" width="${rw}" height="${heightMm}"/>`;
      x += run;
    } else {
      x++;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${widthMm}mm" height="${heightMm}mm" ` +
    `viewBox="0 0 ${widthMm} ${heightMm}" preserveAspectRatio="none">` +
    `<rect width="${widthMm}" height="${heightMm}" fill="#ffffff"/>` +
    `<g fill="#000000">${rects}</g>` +
    `</svg>`
  );
}