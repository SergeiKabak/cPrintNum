/**
 * MAIN-world hook: перехват ответов Ozon.
 *
 * Запускается не как обычный content script, а через
 * `chrome.scripting.executeScript({ world: "MAIN" })` из background.
 * Это нужно для Chrome 109 (Windows 7): manifest-ключ
 * `content_scripts[].world` поддерживается только с Chrome 111.
 *
 * Найденное размещение отправляется в isolated content script через
 * `window.postMessage`, а тот — в background.
 */

import {
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

    const handle = (url: string, data: unknown) => {
      if (!isInterestingUrl(url)) return;

      const placement = parsePlacement(url, data, "xhr");
      if (placement) post(placement);
    };

    // ---- XHR ----
    const xhrUrls = new WeakMap<XMLHttpRequest, string>();

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
      this.addEventListener("load", () => {
        try {
          if (this.status < 200 || this.status >= 300) return;

          const url = this.responseURL || xhrUrls.get(this) || "";
          if (!isInterestingUrl(url)) return;

          handle(url, readJson(this));
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
        return (originalFetch as any).apply(this, args).then(async (response: Response) => {
          try {
            const url = requestUrl(args[0]);
            if (response.ok && isInterestingUrl(url)) {
              handle(url, await response.clone().json());
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
      };
      console.info("[PrintNum:hook] перехват установлен");
    }
  },
});
