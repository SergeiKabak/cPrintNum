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

/** Эндпоинт списка сессий выдачи. */
export const SESSIONS_ENDPOINT = "/api2/giveout/Sessions";

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
};

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

  const push = (clientId: string, code: string) => {
    const key = `${clientId}\u0000${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ clientId, code });
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
      for (const code of collectCodes(obj, depth + 1)) push(clientId, code);
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

    let codes = 0;
    codeRe.lastIndex = 0;
    let c: RegExpExecArray | null;
    while ((c = codeRe.exec(chunk))) {
      const code = c[1];
      if (!code) continue;

      const key = `${current.id}\u0000${code}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ clientId: current.id, code });
      }
      if (++codes >= MAX_CODES_PER_CLIENT) break;
    }
  }

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
