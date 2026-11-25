/**
 * Разбор ответов Ozon, из которых берётся номер для автопечати.
 *
 * Модуль чистый (без chrome/DOM): его использует и MAIN-world hook, и
 * isolated content script, и background.
 *
 * # Форматы
 *
 * - `Movement/put/v2` → `articlePositions[0].address` — обычная ячейка
 *   (`163-1`). Повтор подряд подавляется.
 * - `TransferByBarcodeArticle` / `TransferPackingArticle` →
 *   `"Ozon Полка-88"` → `-88`. Ведущий дефис маркирует полку и при этом
 *   проходит валидацию `/print-number` (только цифры/дефис/пробел).
 */

import { CELL_CODE_RE, LABEL_BARCODE_RE } from "@/utils/constants";

/** Подстроки URL, по которым узнаём нужные ответы Ozon. */
export const OZON_ENDPOINTS = {
  movement: "/api2/address-storage/Movement/put/v2",
  transferByBarcode: "/MicroFFTransferApi/TransferByBarcodeArticle",
  transferPacking: "/MicroFFTransferApi/TransferPackingArticle",
  // Резолвер приёмки: отдаёт И адрес ячейки, И штрихкод товара.
  resolve: "/p-api/inbound/Resolver/GetResolveEntity",
} as const;

export type PlacementEndpoint = keyof typeof OZON_ENDPOINTS;
export type PlacementKind = "cell" | "shelf";
export type PlacementOrigin = "xhr" | "dom" | "scanner";
export type PlacementDedupe = "consecutive" | "none";

export type Placement = {
  /** Что отправляем в `/print-number`: `163-1` или `-88`. */
  text: string;
  kind: PlacementKind;
  endpoint: PlacementEndpoint;
  origin: PlacementOrigin;
  dedupe: PlacementDedupe;
  /** Исходное значение из ответа — только для логов. */
  raw: string;
  /**
   * Штрихкод товара (`ii…`), если он есть в том же ответе Ozon.
   * Печатается как QR рядом с номером (config → `qrWithNumber`).
   */
  qr?: string;
};

/** Полка: ведущий дефис + 1–4 цифры. */
export const SHELF_CODE_RE = /^-\d{1,4}$/;

/**
 * `"Ozon Полка-88"` → `-88`.
 *
 * Дефис поддерживает разные варианты написания: «Полка-88», «Полка 88»,
 * «Полка—88» (типографские тире).
 */
export function shelfToCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const m = /Полка\s*[-\u2010-\u2015\u2212]?\s*(\d{1,4})/i.exec(raw);
  const digits = m?.[1];
  return digits ? `-${digits}` : null;
}

/**
 * Ищет первый штрихкод товара (`ii` + 9–14 цифр) в JSON-ответе Ozon.
 *
 * Поля у Ozon отличаются от сборки к сборке, поэтому не привязываемся к
 * путям: обходим объект в глубину с жёстким бюджетом (глубина ≤ 6,
 * ≤ 20 элементов массива, ≤ 40 ключей объекта, ≤ 400 узлов всего).
 *
 * @returns ШК либо `null`, если в ответе его нет.
 */
export function findBarcode(value: unknown): string | null {
  // Счётчик узлов вместо замыкания-объекта: без аллокации на каждый вызов.
  // Бюджет увеличен: ответы Ozon с перечнями товаров бывают крупными.
  let budget = 2000;

  const walk = (node: unknown, depth: number): string | null => {
    if (budget-- <= 0 || depth > 8 || node == null) return null;

    if (typeof node === "string") {
      const trimmed = node.trim();
      return LABEL_BARCODE_RE.test(trimmed) ? trimmed : null;
    }

    if (typeof node !== "object") return null;

    // Обходим без Object.values()/slice(): на больших ответах Ozon они
    // создавали временные массивы на каждом уровне вложенности.
    if (Array.isArray(node)) {
      const n = node.length < 50 ? node.length : 50;
      for (let i = 0; i < n; i++) {
        const found = walk(node[i], depth + 1);
        if (found) return found;
      }
      return null;
    }

    let seen = 0;
    for (const key in node as Record<string, unknown>) {
      if (seen++ >= 80) break;
      const found = walk((node as Record<string, unknown>)[key], depth + 1);
      if (found) return found;
    }
    return null;
  };

  return walk(value, 0);
}

/** Быстрый префильтр URL до `JSON.parse`. */
export function isInterestingUrl(url: string): boolean {
  return (
    url.includes(OZON_ENDPOINTS.movement) ||
    url.includes(OZON_ENDPOINTS.transferByBarcode) ||
    url.includes(OZON_ENDPOINTS.transferPacking) ||
    url.includes(OZON_ENDPOINTS.resolve)
  );
}

/**
 * Приводит входящий объект (из XHR или `window.postMessage`) к `Placement`.
 *
 * Возвращает `null` для мусора. Тип (`cell`/`shelf`) определяется по тексту,
 * поэтому страница не может подсунуть `-88` как обычную ячейку.
 */
export function normalizePlacement(value: unknown): Placement | null {
  if (!value || typeof value !== "object") return null;

  const p = value as Partial<Placement>;
  if (typeof p.text !== "string") return null;

  const text = p.text.trim();
  if (!text || text.length > 64) return null;

  const kind: PlacementKind = SHELF_CODE_RE.test(text) ? "shelf" : "cell";

  if (kind === "cell") {
    // Максимум 4 цифры в номере ячейки (9999), опционально «-» и 1–4 цифры.
    // Ячейки не начинаются с дефиса: это зарезервировано под полку.
    if (!CELL_CODE_RE.test(text)) return null;
  }

  const endpoint: PlacementEndpoint =
    typeof p.endpoint === "string" &&
    Object.prototype.hasOwnProperty.call(OZON_ENDPOINTS, p.endpoint)
      ? (p.endpoint as PlacementEndpoint)
      : kind === "shelf"
        ? "transferByBarcode"
        : "movement";

  const origin: PlacementOrigin =
    p.origin === "dom" || p.origin === "scanner" ? p.origin : "xhr";

  const dedupe: PlacementDedupe =
    p.dedupe === "none" || p.dedupe === "consecutive"
      ? p.dedupe
      : kind === "cell"
        ? "consecutive"
        : "none";

  // Штрихкод товара приходит из того же ответа (findBarcode);
  // из postMessage его тоже принимаем, но только в формате `ii…`.
  const qr =
    typeof p.qr === "string" && LABEL_BARCODE_RE.test(p.qr.trim())
      ? p.qr.trim()
      : undefined;

  return {
    text,
    kind,
    endpoint,
    origin,
    dedupe,
    raw: typeof p.raw === "string" ? p.raw.slice(0, 256) : text,
    ...(qr ? { qr } : {}),
  };
}

/**
 * Разбирает ответ Ozon.
 *
 * @param url    `xhr.responseURL` / `response.url`
 * @param data   распарсенный JSON
 * @param origin откуда пришло событие
 */
export function parsePlacement(
  url: string,
  data: unknown,
  origin: PlacementOrigin = "xhr",
): Placement | null {
  // Сначала дешёвая проверка размещения: findBarcode обходит весь JSON,
  // поэтому запускаем его только для ответов с валидной ячейкой/полкой.
  let qr: string | undefined;

  if (url.includes(OZON_ENDPOINTS.movement)) {
    const raw = (data as any)?.articlePositions?.[0]?.address;
    if (typeof raw !== "string") return null;
    qr = findBarcode(data) ?? undefined;

    return normalizePlacement({
      text: raw,
      kind: "cell",
      endpoint: "movement",
      origin,
      dedupe: "consecutive",
      raw,
      qr,
    });
  }

  if (url.includes(OZON_ENDPOINTS.transferByBarcode)) {
    const raw = (data as any)?.transferSuccess?.cell;
    const text = shelfToCode(raw);
    if (!text) return null;
    qr = findBarcode(data) ?? undefined;

    return normalizePlacement({
      text,
      kind: "shelf",
      endpoint: "transferByBarcode",
      origin,
      dedupe: "none",
      raw: String(raw ?? ""),
      qr,
    });
  }

  if (url.includes(OZON_ENDPOINTS.resolve)) {
    // {"article":{"address":"1","barcode":"ii…","label":"ii…"}}
    const article = (data as any)?.article;
    const raw = article?.address;
    if (typeof raw !== "string" || !raw.trim()) return null;

    // ШК берём из того же ответа: barcode, иначе label.
    const code =
      typeof article?.barcode === "string" && article.barcode
        ? article.barcode
        : typeof article?.label === "string"
          ? article.label
          : "";

    return normalizePlacement({
      text: raw.trim(),
      kind: "cell",
      endpoint: "resolve",
      origin,
      dedupe: "consecutive",
      raw,
      qr: code || undefined,
    });
  }

  if (url.includes(OZON_ENDPOINTS.transferPacking)) {
    const raw = (data as any)?.success?.cell;
    const text = shelfToCode(raw);
    if (!text) return null;
    qr = findBarcode(data) ?? undefined;

    return normalizePlacement({
      text,
      kind: "shelf",
      endpoint: "transferPacking",
      origin,
      dedupe: "none",
      raw: String(raw ?? ""),
      qr,
    });
  }

  return null;
}
