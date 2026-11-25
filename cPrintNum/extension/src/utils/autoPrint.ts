/**
 * Обработка события автопечати в background (service worker).
 *
 * Здесь сосредоточены:
 * - проверка настроек и режима (`dom` / `xhr` / `both`);
 * - дедупликация повторов резолвера (та же ячейка подряд);
 * - проверка поддержки полок backend'ом (`features:["shelf-dash"]`);
 * - отправка в C-службу через `POST /print-number`.
 *
 * Печать не ретраится: повторная отправка может напечатать лишнюю этикетку.
 */

declare const chrome: any;

import { getSettings, sendServer } from "@/utils/api";
import {
  AUTO_PRINT_KEY,
  LAST_AUTO_PRINT_EVENT_KEY,
  LAST_AUTO_PRINT_KEY,
  SHELF_FEATURE,
  normalizeAutoPrint,
  type AutoPrintEvent,
  type AutoPrintSettings,
} from "@/utils/autoPrintSettings";
import {
  normalizePlacement,
  type Placement,
} from "@/utils/ozonPlacements";

type LastAutoPrint = {
  text: string;
  kind: "cell" | "shelf";
  at: number;
};

/** Кэш `features` из `/config`, чтобы не дёргать backend на каждую печать. */
const FEATURES_TTL_MS = 30_000;
let featuresCache: { features: string[]; at: number } | null = null;

export async function getAutoPrintSettings(): Promise<AutoPrintSettings> {
  const result = await chrome.storage.local.get(AUTO_PRINT_KEY);
  return normalizeAutoPrint(result?.[AUTO_PRINT_KEY]);
}

async function getBackendFeatures(): Promise<string[] | null> {
  const now = Date.now();
  if (featuresCache && now - featuresCache.at < FEATURES_TTL_MS) {
    return featuresCache.features;
  }

  const settings = await getSettings();
  if (!settings) return null; // backend недоступен — не кэшируем

  const features = Array.isArray(settings.features) ? settings.features : [];
  featuresCache = { features, at: now };
  return features;
}

function isAllowed(placement: Placement, settings: AutoPrintSettings): boolean {
  if (settings.mode === "off") return false;
  if (placement.kind === "shelf" && !settings.shelf) return false;
  if (placement.endpoint === "transferPacking" && !settings.packing) return false;
  if (placement.endpoint === "resolve" && !settings.resolve) return false;

  // В режимах dom/xhr второй источник молчит.
  if (placement.origin === "dom" && settings.mode === "xhr") return false;
  if (placement.origin === "xhr" && settings.mode === "dom") return false;

  return true;
}

async function isDuplicate(
  placement: Placement,
  settings: AutoPrintSettings,
): Promise<boolean> {
  const result = await chrome.storage.local.get(LAST_AUTO_PRINT_KEY);
  const last = result?.[LAST_AUTO_PRINT_KEY] as LastAutoPrint | undefined;

  if (!last || last.text !== placement.text || last.kind !== placement.kind) {
    return false;
  }

  const age = Date.now() - last.at;

  // Ячейка из резолвера: не печатаем ту же самую подряд в пределах окна.
  if (placement.dedupe === "consecutive" && age < settings.dedupeMs) {
    return true;
  }

  // Режим both: DOM и XHR могут сообщить об одном и том же размещении.
  if (settings.mode === "both" && age < settings.overlapGuardMs) {
    return true;
  }

  return false;
}

async function writeEvent(event: AutoPrintEvent): Promise<void> {
  await chrome.storage.local.set({ [LAST_AUTO_PRINT_EVENT_KEY]: event });
}

function makeEvent(
  placement: Placement,
  ok: boolean,
  status: number | null,
  error?: string,
  qr?: string,
): AutoPrintEvent {
  return {
    text: placement.text,
    kind: placement.kind,
    ok,
    status,
    ...(error ? { error } : {}),
    ...(qr ? { qr } : {}),
    at: Date.now(),
  };
}

/**
 * Полный цикл обработки одного размещения.
 *
 * `null` — событие отфильтровано (режим, настройки, дубль): в popup
 * ничего не пишем, чтобы не засорять статус.
 */
export async function handleAutoPrint(value: unknown): Promise<AutoPrintEvent | null> {
  const placement = normalizePlacement(value);
  if (!placement) return null;

  const settings = await getAutoPrintSettings();
  if (!isAllowed(placement, settings)) return null;

  if (placement.kind === "shelf") {
    const features = await getBackendFeatures();

    // null — backend недоступен: пробуем печать, ошибка будет понятнее.
    if (features && !features.includes(SHELF_FEATURE)) {
      const event = makeEvent(
        placement,
        false,
        null,
        "Обновите PrintNum: поддержка полок (-88) не найдена",
      );
      await writeEvent(event);
      console.warn(`[PrintNum:auto] ${event.error}`);
      return event;
    }
  }

  if (await isDuplicate(placement, settings)) {
    return null;
  }

  try {
    // QR — штрихкод товара из ответа Ozon: сервер напечатает его рядом
    // с номером, если включён `qrWithNumber` (см. §print-number).
    const res = await sendServer.post("print-number", {
      text: placement.text,
      ...(placement.qr ? { qr: placement.qr } : {}),
    });
    const event = makeEvent(
      placement,
      res.ok,
      res.status,
      res.ok ? undefined : `PrintNum вернул ${res.status}`,
      placement.qr,
    );

    if (res.ok) {
      // Один storage.set вместо двух: раньше событие и lastAutoPrint
      // писались отдельными IPC-вызовами.
      await chrome.storage.local.set({
        [LAST_AUTO_PRINT_EVENT_KEY]: event,
        [LAST_AUTO_PRINT_KEY]: {
          text: placement.text,
          kind: placement.kind,
          at: event.at,
        } satisfies LastAutoPrint,
      });
      console.info(
        `[PrintNum:auto] напечатано: ${placement.text}` +
          (placement.qr ? ` + QR ${placement.qr}` : " (без QR: ШК не найден)"),
      );
    } else {
      await writeEvent(event);
      console.error(`[PrintNum:auto] ошибка печати ${placement.text}: ${res.status}`);
    }

    return event;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "PrintNum недоступен";
    const event = makeEvent(placement, false, null, message);
    await writeEvent(event);
    console.error(`[PrintNum:auto] сеть: ${message}`);
    return event;
  }
}
