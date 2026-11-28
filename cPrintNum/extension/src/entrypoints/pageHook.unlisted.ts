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
import {
  POSTINGS_ENDPOINT,
  SEARCH_ENDPOINT,
  SESSIONS_ENDPOINT,
  clientIdFromSearchBody,
  codesInText,
  extractGiveoutCodes,
  extractOrderCodes,
  extractSearchHit,
  extractSessionClients,
  extractSessionOrders,
  extractSessionOrdersFromText,
  extractSessions,
  isOrderCode,
  losesPrecision,
} from "@/utils/ozonSessions";

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

/**
 * Эмуляция сканера: «печатает» символы в сфокусированное поле и жмёт Enter.
 *
 * Живёт в MAIN world (этот файл инжектится туда), поэтому вызывается из
 * консоли страницы без переключения контекста:
 *
 * ```js
 * PrintNumScan.pick("78060603-0180-1");
 * PrintNumScan.pickList(["ii20391124108", "ii20391124404"], 1500);
 * ```
 *
 * Дальше всё идёт обычным путём Ozon: страница отправляет свой запрос,
 * `pageHook` ловит ответ резолвера и печатает этикетку. То есть это проверка
 * настоящей цепочки, а не подмена HTTP.
 *
 * Если ничего не сфокусировано, события уходят в `document.body` — Ozon такой
 * ввод проигнорирует, поэтому сначала кликните в поле сканирования.
 */
function dispatchKey(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
}

/**
 * Синтетические keydown/keyup НЕ вставляют текст в поле (это делает браузер
 * только для доверенных событий). Поэтому для input/textarea дополнительно
 * пишем значение через нативный сеттер и шлём `input` — так это видит React
 * и любой onInput-обработчик Ozon.
 */
function typeIntoField(el: Element | null, text: string): void {
  if (!el) return;

  const isInput = el instanceof HTMLInputElement;
  const isArea = el instanceof HTMLTextAreaElement;
  if (!isInput && !isArea) return;

  const proto = isArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) return;

  setter.call(el, (el as HTMLInputElement).value + text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function scanTarget(): EventTarget {
  const active = document.activeElement;
  return active && active !== document.body ? active : document.body;
}

/** Один «скан»: посимвольно + Enter. */
function pick(barcode: string): void {
  if (!barcode) return;

  const target = scanTarget();
  console.info(`[PrintNum:scan] сканирую: ${barcode}`);

  for (const char of barcode) {
    dispatchKey(target, char);
    typeIntoField(document.activeElement, char);
  }

  // Enter — так же, как сканер завершает ввод.
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
}

/** Серия «сканов» с паузой между ними. */
async function pickList(barcodes: string[], delayMs = 1500): Promise<void> {
  for (const code of barcodes) {
    pick(code);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  console.info(`[PrintNum:scan] отправлено: ${barcodes.length}`);
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
     * Отправляет в content script пары «clientId ↔ отправление» и список
     * клиентов (для имени в предупреждении).
     *
     * `/giveout/Sessions` отдаёт только сессии (clientId + clientShortName),
     * без отправлений — поэтому пары ищем в любых ответах giveout/inbound.
     */
    const postSessions = (data: unknown, rawText?: string) => {
      let orders = extractSessionOrders(data);
      const clients = extractSessionClients(data);

      // `clientId` — длинное число: JSON.parse округляет его (2^53).
      // Если точность потеряна, разбираем сырой текст ответа.
      if (rawText && orders.some((o) => losesPrecision(o.clientId))) {
        const precise = extractSessionOrdersFromText(rawText);
        if (precise.length) orders = precise;
      }

      // sessionId → clientId: связка для Postings
      for (const info of extractSessions(data)) {
        sessionClients.set(info.sessionId, {
          clientId: info.clientId,
          ...(info.clientName ? { clientName: info.clientName } : {}),
        });

        const pending = pendingBySession.get(info.sessionId);
        if (pending) {
          pendingBySession.delete(info.sessionId);
          postSessionPairs(info.sessionId, pending);
        }
      }

      if (!orders.length && !clients.length) return;

      window.postMessage(
        { source: "PrintNum", type: "SESSIONS", payload: { orders, clients } },
        location.origin,
      );
    };

    /**
     * `sessionId → clientId` из `/giveout/Sessions`.
     *
     * Самые важные данные для должников: `Sessions` знает клиента сессии,
     * `Postings?sessionId=…` — отправления этой сессии.
     */
    const sessionClients = new Map<string, { clientId: string; clientName?: string }>();
    /** Отправления, пришедшие раньше, чем клиент сессии. */
    const pendingBySession = new Map<string, string[]>();

    /**
     * `sessionId → коды, доступные к выдаче` (Postings с pvzState=ReadyToGiveout).
     * По этому списку блокируются запросы со ШК, которого нет на выдаче.
     */
    const giveoutCodes = new Map<string, Set<string>>();

    /**
     * Эндпоинты, несущие отсканированный ШК. Проверяем их до отправки:
     * если кода нет среди товаров «на выдаче» — запрос не уходит в Ozon.
     */
    const SCAN_URL_RE = /\/Resolver\/|\/barcode|\/scan|order-condition\/Session\/search/i;

    /** ШК из запроса, которого нет в списке «на выдаче» (или null — можно). */
    const blockedScanCode = (url: string, body?: string): string | null => {
      if (!SCAN_URL_RE.test(url)) return null;
      if (url.includes(POSTINGS_ENDPOINT) || url.includes(SESSIONS_ENDPOINT)) return null;

      const sessionId = currentSessionId();
      const allowed = giveoutCodes.get(sessionId);
      // Список ещё не загружен — не мешаем работать.
      if (!allowed || !allowed.size) return null;

      const codes = codesInText(`${url} ${body ?? ""}`);
      for (const code of codes) {
        if (!allowed.has(code)) return code;
      }
      return null;
    };

    /** Сообщает content script, что запрос со ШК заблокирован. */
    const postBlockedScan = (code: string) => {
      window.postMessage(
        { source: "PrintNum", type: "SCAN_BLOCKED", payload: { code } },
        location.origin,
      );
    };

    /** Текущая сессия выдачи: из query или из пути `/session(-new)/<id>`. */
    const currentSessionId = (): string => {
      const fromQuery = urlSessionId(location.href);
      if (fromQuery) return fromQuery;
      const m = location.pathname.match(/\/session(?:-new)?\/(\d{3,})/);
      return m?.[1] ?? "";
    };

    /** `?sessionId=…` из URL ответа Postings. */
    const urlSessionId = (url: string): string => {
      try {
        return new URL(url, location.href).searchParams.get("sessionId") ?? "";
      } catch {
        return "";
      }
    };

    /** Отправляет пары «clientId ↔ отправление» для указанной сессии. */
    const postSessionPairs = (sessionId: string, codes: string[]) => {
      const client = sessionClients.get(sessionId);
      if (!client || !codes.length) return;

      const orders = codes.map((code) => ({
        clientId: client.clientId,
        code,
        ...(client.clientName ? { clientName: client.clientName } : {}),
      }));

      window.postMessage(
        { source: "PrintNum", type: "SESSIONS", payload: { orders, clients: [] } },
        location.origin,
      );

      // Сессия выдачи целиком: по ней content script решает, блокировать ли
      // кнопку «Выдать» (должник определяется по clientId сессии).
      window.postMessage(
        {
          source: "PrintNum",
          type: "GIVEOUT",
          payload: {
            sessionId,
            clientId: client.clientId,
            ...(client.clientName ? { clientName: client.clientName } : {}),
            codes: codes.slice(0, 200),
          },
        },
        location.origin,
      );
    };

    /** Скан отправления (для проверки должников) — код из `article.*`. */
    const postOrder = (code: unknown) => {
      if (typeof code !== "string" || !isOrderCode(code)) return;
      window.postMessage(
        { source: "PrintNum", type: "ORDER", payload: { code: code.trim() } },
        location.origin,
      );
    };

    /**
     * Собирает размещение: номер из ответа + ШК из тела запроса.
     * ШК из ответа (если он там вдруг есть) приоритетнее.
     */
    // Ответы выдачи/резолвера тоже могут содержать clientId рядом с
    // отправлением — из них и получается связка «кто этот заказ».
    const isGiveoutUrl = (url: string) =>
      url.includes("/giveout/") || url.includes("/inbound/") || url.includes("/Resolver/");

    /**
     * Что вообще передаём в `handle`.
     *
     * `isInterestingUrl` знает только про размещения, а для должников нужны
     * ещё `Sessions` и `Postings` — иначе fetch/XHR-обёртки их отбрасывали.
     */
    const shouldHandle = (url: string) =>
      isInterestingUrl(url) ||
      url.includes(SESSIONS_ENDPOINT) ||
      url.includes(POSTINGS_ENDPOINT) ||
      url.includes(SEARCH_ENDPOINT) ||
      isGiveoutUrl(url);

    const handle = (url: string, data: unknown, body?: string, rawText?: string) => {
      // Код выдачи (clientId*NNNN): клиент известен сразу — до кнопки «Выдать».
      if (url.includes(SEARCH_ENDPOINT)) {
        const hit = extractSearchHit(data) ?? {};
        const clientId = hit.clientId || clientIdFromSearchBody(body);
        if (!clientId) return;

        if (hit.sessionId && hit.clientName) {
          sessionClients.set(hit.sessionId, {
            clientId: hit.clientId || clientId,
            clientName: hit.clientName,
          });
        }

        window.postMessage(
          {
            source: "PrintNum",
            type: "GIVEOUT",
            payload: {
              ...(hit.sessionId ? { sessionId: hit.sessionId } : {}),
              clientId,
              ...(hit.clientName ? { clientName: hit.clientName } : {}),
              codes: [],
            },
          },
          location.origin,
        );
        return;
      }

      if (url.includes(POSTINGS_ENDPOINT)) {
        const sessionId = urlSessionId(url) || currentSessionId();
        const allowed = extractGiveoutCodes(data);
        if (sessionId && allowed.length) giveoutCodes.set(sessionId, new Set(allowed));
        const codes = extractOrderCodes(data);
        if (!sessionId || !codes.length) return;

        if (sessionClients.has(sessionId)) {
          postSessionPairs(sessionId, codes);
        } else {
          // Клиент сессии ещё не пришёл — запомним и дошлём после Sessions.
          pendingBySession.set(sessionId, codes.slice(0, 200));
        }
        return;
      }

      if (url.includes(SESSIONS_ENDPOINT) || isGiveoutUrl(url)) {
        postSessions(data, rawText);
        if (!isInterestingUrl(url)) return;
      }

      if (!isInterestingUrl(url)) return;

      const placement = parsePlacement(url, data, "xhr");
      if (!placement) return;

      if (!placement.qr && body) {
        const fromRequest = barcodeFromBody(body);
        if (fromRequest) placement.qr = fromRequest;
      }

      post(placement);

      // Тот же код отправления — для проверки по базе должников.
      if (placement.endpoint === "resolve") postOrder(placement.qr);
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
    (XMLHttpRequest.prototype as any).send = function (this: XMLHttpRequest, ...args: any[]) {
      let body = "";
      try {
        body = bodyText(args[0]);
        if (body) xhrBodies.set(this, body);
      } catch {
        // ignore
      }

      // Не отправляем запрос, если ШК нет среди товаров «на выдаче».
      try {
        const blocked = blockedScanCode(xhrUrls.get(this) || "", body);
        if (blocked) {
          postBlockedScan(blocked);
          this.dispatchEvent(new ProgressEvent("loadend"));
          return;
        }
      } catch {
        // проверка не должна ломать сканирование
      }

      this.addEventListener("load", () => {
        try {
          if (this.status < 200 || this.status >= 300) return;

          const url = this.responseURL || xhrUrls.get(this) || "";
          if (!shouldHandle(url)) return;

          const isText = this.responseType === "" || this.responseType === "text";
          handle(url, readJson(this), xhrBodies.get(this), isText ? this.responseText : undefined);
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

        // Запрос со ШК, которого нет на выдаче, не уходит в Ozon.
        try {
          const blocked = blockedScanCode(url, body);
          if (blocked) {
            postBlockedScan(blocked);
            return Promise.resolve(
              new Response(
                JSON.stringify({ result: "NotFound", message: "ШК не найден на выдаче" }),
                {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                },
              ),
            );
          }
        } catch {
          // проверка не должна ломать сканирование
        }

        return (originalFetch as any).apply(this, args).then(async (response: Response) => {
          try {
            if (response.ok && shouldHandle(url)) {
              handle(url, await response.clone().json(), body);
            }
          } catch {
            // ignore
          }
          return response;
        });
      } as typeof window.fetch;
    }

    // Публичный хелпер: доступен из консоли страницы (MAIN world).
    w.PrintNumScan = { pick, pickList };

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
