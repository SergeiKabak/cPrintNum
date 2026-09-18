/**
 * Эмулятор сканера штрихкодов (только для разработки).
 *
 * Физический сканер ШК работает как HID-клавиатура: очень быстро «набирает»
 * символы штрихкода и завершает ввод клавишей Enter. Этот модуль программно
 * генерирует такие же события `keydown` на `window`, чтобы можно было проверить
 * логику `utils/listener.ts` и content scripts без реального сканера.
 *
 * Использование из консоли страницы Ozon (F12):
 *
 * ```js
 * // одиночное сканирование
 * PrintNumScanner.simulate("123-47");
 *
 * // серия с задержкой между сканированиями
 * PrintNumScanner.simulateSequence(["123-47", "500-47", "КГТ-1"], 1500);
 * ```
 *
 * В продакшене модуль не активируется: функции вешают глобальный объект только
 * в dev-сборке (`import.meta.env.DEV`).
 */

/** Тип функции-обработчика результата сканирования. */
type ScanHandler = (value: string) => void;

/** Отдельные обработчики для каждого симулируемого сканирования. */
const scanHandlers: ScanHandler[] = [];

/**
 * Подписка на результат симулированного сканирования.
 * Дополняет `utils/listener.ts`: там слушается реальный `keydown`,
 * здесь можно узнать, что именно «отсканировано» в тесте.
 */
export function onSimulatedScan(fn: ScanHandler): void {
  scanHandlers.push(fn);
}

/**
 * Отправляет одно `keydown`-событие с указанной клавишей.
 * `char` должен быть односимвольной строкой (например "1", "-", "A").
 */
function dispatchKey(char: string): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: char,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * Симулирует сканирование одного штрихкода.
 *
 * @param value     текст штрихкода (например "123-47")
 * @param charDelay задержка между символами в мс (сканер обычно ~5–20 мс)
 */
export async function simulate(
  value: string,
  charDelay = 15,
): Promise<void> {
  if (!value) return;

  for (const char of value) {
    dispatchKey(char);
    await sleep(charDelay);
  }

  // Сканер завершает ввод нажатием Enter.
  dispatchKey("Enter");

  scanHandlers.forEach((fn) => fn(value));
  console.info(`[PrintNum:scanner] отсканировано: "${value}"`);
}

/**
 * Симулирует серию сканирований с паузой между ними.
 *
 * @param values    массив штрихкодов
 * @param delayMs   пауза между сканированиями в мс
 * @param charDelay задержка между символами внутри одного сканирования
 */
export async function simulateSequence(
  values: string[],
  delayMs = 1500,
  charDelay = 15,
): Promise<void> {
  for (const value of values) {
    await simulate(value, charDelay);
    await sleep(delayMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Публичный API эмулятора. */
export const PrintNumScanner = {
  simulate,
  simulateSequence,
  onSimulatedScan,
};

/**
 * Регистрирует эмулятор в глобальной области (только dev-сборка).
 * В обычной сборке функция ничего не делает.
 */
export function registerScannerSimulator(): void {
  if (!import.meta.env.DEV) return;

  (window as any).PrintNumScanner = PrintNumScanner;
  console.info(
    "[PrintNum:scanner] Эмулятор сканера доступен: PrintNumScanner.simulate(\"123-47\")",
  );
}
