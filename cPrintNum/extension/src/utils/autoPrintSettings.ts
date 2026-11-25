/**
 * Настройки автопечати и ключи `chrome.storage.local`.
 *
 * Модуль чистый: используется в popup, content script и background.
 */

export const AUTO_PRINT_KEY = "autoPrint";
export const LAST_AUTO_PRINT_KEY = "lastAutoPrint";
export const LAST_COPIED_LABEL_KEY = "lastCopiedLabel";
export const LAST_COPIED_LABEL_AT_KEY = "lastCopiedLabelAt";
export const LAST_AUTO_PRINT_EVENT_KEY = "lastAutoPrintEvent";

/** Возможность backend'а, которую проверяем перед печатью полок. */
export const SHELF_FEATURE = "shelf-dash";

export type AutoPrintMode = "off" | "dom" | "xhr" | "both";

export type AutoPrintSettings = {
  /** off — выключено, dom — как раньше, xhr — перехват, both — отладка. */
  mode: AutoPrintMode;
  /** Печатать полки (`-88`). */
  shelf: boolean;
  /** Печатать `TransferPackingArticle` (переупаковка). */
  packing: boolean;
  /** Брать QR из кнопки «копировать», если в ответе Ozon ШК не нашёлся. */
  qrFromCopied: boolean;
  /** Окно подавления повтора для Movement/put/v2, мс. */
  dedupeMs: number;
  /** Защита DOM+XHR от двойной печати в режиме `both`, мс. */
  overlapGuardMs: number;
};

/**
 * Безопасный дефолт: `dom`, чтобы обновление расширения не меняло
 * поведение существующих пользователей. Новым установкам background
 * выставляет `xhr` через `chrome.runtime.onInstalled`.
 */
export const DEFAULT_AUTO_PRINT: AutoPrintSettings = {
  mode: "dom",
  shelf: true,
  packing: true,
  qrFromCopied: true,
  dedupeMs: 5000,
  overlapGuardMs: 1000,
};

export type AutoPrintEvent = {
  text: string;
  kind: "cell" | "shelf";
  ok: boolean;
  status: number | null;
  error?: string;
  /** ШК, который ушёл в QR (если был). */
  qr?: string;
  /** Откуда взялся ШК: ответ Ozon или кнопка «копировать». */
  qrSource?: "ozon" | "copied";
  at: number;
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Приводит значение из storage к полному объекту настроек. */
export function normalizeAutoPrint(value: unknown): AutoPrintSettings {
  const v = (value && typeof value === "object" ? value : {}) as Partial<AutoPrintSettings>;

  const mode: AutoPrintMode =
    v.mode === "off" || v.mode === "dom" || v.mode === "xhr" || v.mode === "both"
      ? v.mode
      : DEFAULT_AUTO_PRINT.mode;

  return {
    mode,
    shelf: typeof v.shelf === "boolean" ? v.shelf : DEFAULT_AUTO_PRINT.shelf,
    packing: typeof v.packing === "boolean" ? v.packing : DEFAULT_AUTO_PRINT.packing,
    qrFromCopied:
      typeof v.qrFromCopied === "boolean"
        ? v.qrFromCopied
        : DEFAULT_AUTO_PRINT.qrFromCopied,
    dedupeMs: clampInt(v.dedupeMs, 0, 60000, DEFAULT_AUTO_PRINT.dedupeMs),
    overlapGuardMs: clampInt(
      v.overlapGuardMs,
      0,
      10000,
      DEFAULT_AUTO_PRINT.overlapGuardMs,
    ),
  };
}
