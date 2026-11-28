/**
 * Разбор ответа `/api2/giveout/Sessions` — связка «клиент → его отправления».
 *
 * Нужен для проверки должников: в ответе сессий выдачи есть `clientId`
 * клиента и отправления этой сессии. Точную схему Ozon может менять, поэтому
 * разбор терпимый: ищем объекты с `clientId`, а внутри них — строки, похожие
 * на номер отправления (`78060603-0180-1`) или `ii…`-штрихкод.
 *
 * Модуль чистый (без DOM/chrome) — используется в MAIN-world hook.
 */

/** Эндпоинт списка сессий выдачи (clientId ↔ sessionId). */
export const SESSIONS_ENDPOINT = "/api2/giveout/Sessions";

/** Эндпоинт отправлений сессии (`?sessionId=…` → список заказов). */
export const POSTINGS_ENDPOINT = "/api2/giveout/Postings";

/**
 * Поиск клиента/сессии по коду выдачи (`clientId*NNNN`).
 *
 * Ответ содержит `clientInfo.id` и `giveoutInfo.sessionId` — самый ранний
 * момент, когда известен клиент, ещё до открытия кнопки «Выдать».
 */
export const SEARCH_ENDPOINT = "/api2/order-condition/Session/search-v2";

/** Что удалось вытащить из ответа `search-v2`. */
export type SearchHit = {
  clientId?: string;
  clientName?: string;
  sessionId?: string;
};

/** Разбирает ответ `search-v2` (`clientInfo` / `giveoutInfo`). */
export function extractSearchHit(data: unknown): SearchHit | null {
  if (!data || typeof data !== "object") return null;

  const root = data as Record<string, any>;
  const info = root.clientInfo as Record<string, unknown> | undefined;
  const giveout = root.giveoutInfo as Record<string, unknown> | undefined;

  const clientId = info ? clientIdOf(info.id) : "";
  const sessionId = giveout ? clientIdOf(giveout.sessionId) : "";
  if (!clientId && !sessionId) return null;

  const rawName = info && (typeof info.shortName === "string" ? info.shortName : "");
  const clientName = rawName ? rawName.trim().slice(0, 80) : "";

  return {
    ...(clientId ? { clientId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(clientName ? { clientName } : {}),
  };
}

/**
 * `clientId` из кода выдачи в теле запроса `search-v2`
 * (`{"query":"89367626*0328"}` → `89367626`).
 */
export function clientIdFromSearchBody(body: string | undefined): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { query?: unknown };
    if (typeof parsed?.query === "string") {
      const id = clientIdOf(parsed.query.split("*")[0]);
      if (id) return id;
    }
  } catch {
    // не JSON — пробуем регуляркой ниже
  }
  const m = body.match(/"query"\s*:\s*"(\d{3,})\s*\*/);
  return m?.[1] ?? "";
}

/** Номер отправления Ozon: `78060603-0180-1`. */
export const ORDER_NUMBER_RE = /^\d{6,12}-\d{3,5}-\d$/;

/** Штрихкод отправления: `ii` + 9–14 цифр. */
const BARCODE_RE = /^ii\d{9,14}$/;

const MAX_DEPTH = 6;
const MAX_ARRAY = 60;
const MAX_KEYS = 60;
const MAX_NODES = 4000;
const MAX_CODES_PER_CLIENT = 50;

export type SessionOrder = {
  /** `clientId` клиента Ozon. */
  clientId: string;
  /** Номер отправления / штрихкод, как он пришёл в ответе. */
  code: string;
  /** `clientShortName` / `clientName`, если Ozon его отдал рядом. */
  clientName?: string;
};

/**
 * Имя клиента из объекта сессии.
 *
 * В `/giveout/Sessions` есть `clientShortName` («Алексей М.»), в других
 * ответах встречается `clientName`/`fio`. Нужно только для текста плашки.
 */
function clientNameOf(obj: Record<string, unknown>): string | undefined {
  for (const key of ["clientShortName", "clientName", "fio"] as const) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
  }
  return undefined;
}

/** Похоже ли значение на номер отправления или `ii…`-штрихкод. */
export function isOrderCode(value: string): boolean {
  const v = value.trim();
  return ORDER_NUMBER_RE.test(v) || BARCODE_RE.test(v);
}

/** Порог безопасного целого: `clientId` Ozon длиннее 18 цифр. */
const MAX_SAFE = 9007199254740991;

/** Теряет ли `clientId` точность при `JSON.parse` (число > 2^53)? */
export function losesPrecision(clientId: string): boolean {
  if (!/^\d{16,}$/.test(clientId)) return false;
  return !Number.isSafeInteger(Number(clientId));
}

/** Приводит `clientId` к строке (число/строка). */
function clientIdOf(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value.trim();
  return "";
}

/**
 * Достаёт из ответа сессий пары «клиент → отправление».
 *
 * Обход: до 6 уровней, ≤60 элементов массива, ≤60 ключей объекта,
 * ≤4000 узлов всего, ≤50 кодов на клиента. Этого достаточно для списка
 * сессий выдачи и не даёт разбора «всего JSON любой ценой».
 */
export function extractSessionOrders(data: unknown): SessionOrder[] {
  const out: SessionOrder[] = [];
  const seen = new Set<string>();
  let budget = MAX_NODES;

  const push = (clientId: string, code: string, clientName?: string) => {
    const key = `${clientId}\u0000${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ clientId, code, ...(clientName ? { clientName } : {}) });
  };

  const collectCodes = (node: unknown, depth: number): string[] => {
    if (depth > MAX_DEPTH || budget-- <= 0 || node == null) return [];

    if (typeof node === "string") return isOrderCode(node) ? [node.trim()] : [];
    if (typeof node !== "object") return [];

    const codes: string[] = [];
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < MAX_ARRAY; i++) {
        codes.push(...collectCodes(node[i], depth + 1));
        if (codes.length >= MAX_CODES_PER_CLIENT) break;
      }
      return codes;
    }

    let seenKeys = 0;
    for (const key in node as Record<string, unknown>) {
      if (seenKeys++ >= MAX_KEYS) break;
      // Сам `clientId` кодом не считаем.
      if (key === "clientId") continue;
      codes.push(...collectCodes((node as Record<string, unknown>)[key], depth + 1));
      if (codes.length >= MAX_CODES_PER_CLIENT) break;
    }
    return codes;
  };

  const walk = (node: unknown, depth: number) => {
    if (depth > MAX_DEPTH || budget-- <= 0 || node == null) return;
    if (typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < MAX_ARRAY; i++) walk(node[i], depth + 1);
      return;
    }

    const obj = node as Record<string, unknown>;
    const clientId = clientIdOf(obj.clientId);

    if (clientId) {
      const clientName = clientNameOf(obj);
      for (const code of collectCodes(obj, depth + 1)) {
        push(clientId, code, clientName);
      }
    }

    let seenKeys = 0;
    for (const key in obj) {
      if (seenKeys++ >= MAX_KEYS) break;
      if (key === "clientId") continue;
      walk(obj[key], depth + 1);
    }
  };

  walk(data, 0);
  return out;
}

/**
 * Разбор сессий по СЫРОМУ тексту ответа.
 *
 * Нужен потому, что `clientId` у Ozon — длинное число (18+ цифр): при
 * `JSON.parse` оно округляется (2^53), и сопоставление с базой ломается.
 * Здесь берём цифры прямо из текста, а коды ищем только до следующего
 * `clientId` — чтобы не приписать отправление соседней сессии.
 */
export function extractSessionOrdersFromText(raw: string): SessionOrder[] {
  if (!raw || raw.length > 8 * 1024 * 1024) return [];

  const out: SessionOrder[] = [];
  const seen = new Set<string>();

  const idRe = /"clientId"\s*:\s*(?:"([^"]{3,64})"|(\d{3,32}))/g;
  const codeRe = /"(\d{6,12}-\d{3,5}-\d|ii\d{9,14})"/g;

  let m: RegExpExecArray | null;
  const ids: { id: string; at: number }[] = [];
  while ((m = idRe.exec(raw))) {
    const id = (m[1] ?? m[2] ?? "").trim();
    if (id) ids.push({ id, at: m.index });
  }

  for (let i = 0; i < ids.length; i++) {
    const current = ids[i];
    const next = ids[i + 1];
    if (!current) continue;

    const start = current.at;
    const end = next ? next.at : Math.min(raw.length, start + 8000);
    const chunk = raw.slice(start, end);

    const nameMatch = /"client(?:Short)?Name"\s*:\s*"([^"]{1,80})"/.exec(chunk);
    const clientName = nameMatch?.[1]?.trim() || undefined;

    let codes = 0;
    codeRe.lastIndex = 0;
    let c: RegExpExecArray | null;
    while ((c = codeRe.exec(chunk))) {
      const code = c[1];
      if (!code) continue;

      const key = `${current.id}\u0000${code}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ clientId: current.id, code, ...(clientName ? { clientName } : {}) });
      }
      if (++codes >= MAX_CODES_PER_CLIENT) break;
    }
  }

  return out;
}

/** Сессия выдачи: `sessionId → clientId` (+ имя для плашки). */
export type SessionInfo = {
  sessionId: string;
  clientId: string;
  clientName?: string;
};

/**
 * Сессии из ответа `/giveout/Sessions` (`sessionId`, `clientId`,
 * `clientShortName`). Отправлений в этом ответе нет — они приходят из
 * `/giveout/Postings?sessionId=…`.
 */
export function extractSessions(data: unknown): SessionInfo[] {
  const out: SessionInfo[] = [];
  const seen = new Set<string>();
  let budget = 4000;

  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || budget-- <= 0 || node == null) return;
    if (typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < 60; i++) walk(node[i], depth + 1);
      return;
    }

    const obj = node as Record<string, unknown>;
    const clientId = clientIdOf(obj.clientId);
    const sessionId = clientIdOf(obj.sessionId);

    if (clientId && sessionId && !seen.has(sessionId)) {
      seen.add(sessionId);
      const clientName = clientNameOf(obj);
      out.push({ sessionId, clientId, ...(clientName ? { clientName } : {}) });
    }

    let keys = 0;
    for (const key in obj) {
      if (keys++ >= 60) break;
      if (key === "clientId" || key === "sessionId") continue;
      walk(obj[key], depth + 1);
    }
  };

  walk(data, 0);
  return out;
}

/**
 * Все номера отправлений/штрихкоды из ответа (`/giveout/Postings`).
 * Схему полей не знаем, поэтому берём любые строки нужного формата.
 */
export function extractOrderCodes(data: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let budget = 4000;

  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || budget-- <= 0 || node == null) return;

    if (typeof node === "string") {
      const v = node.trim();
      if (isOrderCode(v) && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
      return;
    }

    if (typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < 60; i++) walk(node[i], depth + 1);
      return;
    }

    let keys = 0;
    for (const key in node as Record<string, unknown>) {
      if (keys++ >= 60) break;
      walk((node as Record<string, unknown>)[key], depth + 1);
    }
  };

  walk(data, 0);
  return out;
}

/**
 * Клиенты из ответа без отправлений (`/giveout/Sessions` отдаёт только
 * сессии: `clientId` + `clientShortName`). Используется, чтобы показать имя
 * в предупреждении о долге.
 */
export function extractSessionClients(data: unknown): { clientId: string; clientName?: string }[] {
  const out: { clientId: string; clientName?: string }[] = [];
  const seen = new Set<string>();
  let budget = 4000;

  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || budget-- <= 0 || node == null) return;
    if (typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < 60; i++) walk(node[i], depth + 1);
      return;
    }

    const obj = node as Record<string, unknown>;
    const clientId = clientIdOf(obj.clientId);
    if (clientId && !seen.has(clientId)) {
      seen.add(clientId);
      const clientName = clientNameOf(obj);
      out.push({ clientId, ...(clientName ? { clientName } : {}) });
    }

    let keys = 0;
    for (const key in obj) {
      if (keys++ >= 60) break;
      if (key === "clientId") continue;
      walk(obj[key], depth + 1);
    }
  };

  walk(data, 0);
  return out;
}

/**
 * Совпадает ли отсканированный код с известным номером отправления.
 *
 * Учитываем варианты Ozon: полный номер (`78060603-0180-1`), номер без
 * последнего сегмента (`78060603-0180`) и `ii…`-штрихкод.
 */
export function codeMatches(scanned: string, known: string): boolean {
  const a = scanned.trim();
  const b = known.trim();
  if (!a || !b) return false;
  if (a === b) return true;

  const shortA = a.replace(/-\d+$/, "");
  const shortB = b.replace(/-\d+$/, "");
  return shortA === b || shortB === a || (shortA.length > 6 && shortA === shortB);
}
