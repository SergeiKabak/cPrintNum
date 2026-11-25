/**
 * MAIN-world hook: перехват запросов и ответов Ozon.
 *
 * Запускается не как обычный content script, а через
 * `chrome.scripting.executeScript({ world: "MAIN" })` из background.
 * Это нужно для Chrome 109 (Windows 7): manifest-ключ
 * `content_scripts[].world` поддерживается только с Chrome 111.
 *
 * # Откуда что берём
 *
 * - **номер ячейки/полки** — из ОТВЕТА (`article.address` в
 *   `Resolver/GetResolveEntity`, `transferSuccess.cell`, `success.cell`);
 * - **штрихкод товара** — из того же ответа резолвера (`article.barcode`),
 *   а если его там нет (полки) — из ТЕЛА ЗАПРОСА (`ii…` уходит в запросе
 *   вместе с размещением).
 *
 * Найденное размещение отправляется в isolated content script через
 * `window.postMessage`, а тот — в background.
 */

import {
  findBarcode,
  isInterestingUrl,
  parsePlacement,
  type Placement,
} from "@/utils/ozonPlacements";

/** Guard от повторной инъекции (SPA-переходы, повторный executeScript). */
const HOOK_KEY = "__printNumHookV1";

function readJson(xhr: XMLHttpRequest): unknown {
  if (xhr.responseType === "json") return xhr.response;

  if (xhr.responseType === "" || xhr.responseType === "text") {
    return xhr.responseText ? JSON.parse(xhr.responseText) : null;
  }

  // blob/arraybuffer не парсим.
  return null;
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof (input as any).url === "string") return (input as any).url;
  return "";
}

/** Тело запроса → строка (для поиска ШК). Нестроковые тела игнорируем. */
function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return "";
}

/**
 * ШК из тела запроса.
 *
 * Тело — обычно JSON (`{"barcode":"ii…"}`), но может быть и form-urlencoded,
 * поэтому сначала пробуем разобрать JSON, затем — регулярку по строке.
 */
function barcodeFromBody(body: string): string | null {
  if (!body) return null;

  try {
    const found = findBarcode(JSON.parse(body));
    if (found) return found;
  } catch {
    // не JSON — ниже проверка регуляркой
  }

  const m = /ii\d{9,14}/.exec(body);
  return m ? m[0] : null;
}

export default defineUnlistedScript({
  main() {
    const w = window as any;
    if (w[HOOK_KEY]) return;
    w[HOOK_KEY] = true;

    const post = (placement: Placement) => {
      window.postMessage(
        { source: "PrintNum", type: "PLACEMENT", payload: placement },
        location.origin,
      );
    };

    /**
     * Собирает размещение: номер из ответа + ШК из тела запроса.
     * ШК из ответа (если он там вдруг есть) приоритетнее.
     */
    const handle = (url: string, data: unknown, body?: string) => {
      if (!isInterestingUrl(url)) return;

      const placement = parsePlacement(url, data, "xhr");
      if (!placement) return;

      if (!placement.qr && body) {
        const fromRequest = barcodeFromBody(body);
        if (fromRequest) placement.qr = fromRequest;
      }

      post(placement);
    };

    // ---- XHR ----
    const xhrUrls = new WeakMap<XMLHttpRequest, string>();
    const xhrBodies = new WeakMap<XMLHttpRequest, string>();

    const originalOpen = XMLHttpRequest.prototype.open;
    (XMLHttpRequest.prototype as any).open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: any[]
    ) {
      try {
        xhrUrls.set(this, String(url));
      } catch {
        // ignore
      }
      return (originalOpen as any).apply(this, [method, url, ...rest]);
    };

    const originalSend = XMLHttpRequest.prototype.send;
    (XMLHttpRequest.prototype as any).send = function (
      this: XMLHttpRequest,
      ...args: any[]
    ) {
      try {
        const body = bodyText(args[0]);
        if (body) xhrBodies.set(this, body);
      } catch {
        // ignore
      }

      this.addEventListener("load", () => {
        try {
          if (this.status < 200 || this.status >= 300) return;

          const url = this.responseURL || xhrUrls.get(this) || "";
          if (!isInterestingUrl(url)) return;

          handle(url, readJson(this), xhrBodies.get(this));
        } catch {
          // Ошибка разбора не должна ломать страницу Ozon.
        }
      });

      return (originalSend as any).apply(this, args);
    };

    // ---- fetch (на случай, если Ozon перейдёт на него) ----
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function (this: any, ...args: any[]) {
        const url = requestUrl(args[0]);
        const body = bodyText(args[1]?.body);

        return (originalFetch as any).apply(this, args).then(async (response: Response) => {
          try {
            if (response.ok && isInterestingUrl(url)) {
              handle(url, await response.clone().json(), body);
            }
          } catch {
            // ignore
          }
          return response;
        });
      } as typeof window.fetch;
    }

    if (import.meta.env.DEV) {
      w.PrintNumHook = {
        emit: post,
        parsePlacement,
        isInterestingUrl,
        findBarcode,
      };
      console.info("[PrintNum:hook] перехват установлен");
    }
  },
});
