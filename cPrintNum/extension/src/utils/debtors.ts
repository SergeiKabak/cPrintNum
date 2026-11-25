/**
 * Локальная база должников (клиентов, которые не оплатили).
 *
 * Хранится в `chrome.storage.local` под ключом `debtors` — массив записей.
 * Сопоставление с Ozon идёт по `clientId` (см. `debtorWatch.content.ts`).
 *
 * Модуль чистый: не зависит от DOM, используется в popup и content script.
 */

declare const chrome: any;

export const DEBTORS_KEY = "debtors";

export type Debtor = {
  /** Уникальный id записи (для редактирования/удаления). */
  id: string;
  /** `clientId` клиента в Ozon (основной ключ сопоставления). */
  clientId: string;
  /** Имя/пометка для человека — необязательно. */
  name?: string;
  /** Комментарий (сумма долга, дата и т.п.). */
  note?: string;
  /** Когда добавили (ms). */
  at: number;
};

/** `clientId` из ответа Ozon может быть числом — приводим к строке. */
export function normalizeClientId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value.trim();
  return "";
}

/** Грубая проверка «похоже на clientId», чтобы не тащить в базу мусор. */
function isValidClientId(id: string): boolean {
  return id.length >= 3 && id.length <= 64 && /^[\w.-]+$/.test(id);
}

/** Приводит значение из storage к списку должников. */
export function normalizeDebtors(value: unknown): Debtor[] {
  if (!Array.isArray(value)) return [];

  const out: Debtor[] = [];
  const seen = new Set<string>();

  for (const item of value.slice(0, 5000)) {
    if (!item || typeof item !== "object") continue;

    const raw = item as Partial<Debtor>;
    const clientId = normalizeClientId(raw.clientId);
    if (!isValidClientId(clientId)) continue;
    if (seen.has(clientId)) continue;
    seen.add(clientId);

    out.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : makeId(),
      clientId,
      name: typeof raw.name === "string" ? raw.name.slice(0, 120) : undefined,
      note: typeof raw.note === "string" ? raw.note.slice(0, 300) : undefined,
      at: typeof raw.at === "number" ? raw.at : Date.now(),
    });
  }

  return out;
}

export function makeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function readDebtors(): Promise<Debtor[]> {
  try {
    const stored = await chrome.storage.local.get(DEBTORS_KEY);
    return normalizeDebtors(stored?.[DEBTORS_KEY]);
  } catch {
    return [];
  }
}

export async function writeDebtors(list: Debtor[]): Promise<void> {
  await chrome.storage.local.set({ [DEBTORS_KEY]: normalizeDebtors(list) });
}

/** Добавляет запись; если такой `clientId` уже есть — обновляет её. */
export async function upsertDebtor(
  input: Pick<Debtor, "clientId"> & Partial<Pick<Debtor, "id" | "name" | "note">>,
): Promise<Debtor[]> {
  const clientId = normalizeClientId(input.clientId);
  if (!isValidClientId(clientId)) return readDebtors();

  const list = await readDebtors();
  const byId = input.id ? list.find((d) => d.id === input.id) : undefined;
  const byClient = list.find((d) => d.clientId === clientId);
  const target = byId || byClient;

  if (target) {
    target.clientId = clientId;
    if (input.name !== undefined) target.name = input.name;
    if (input.note !== undefined) target.note = input.note;
    await writeDebtors(list);
    return list;
  }

  const next = [
    ...list,
    {
      id: makeId(),
      clientId,
      name: input.name,
      note: input.note,
      at: Date.now(),
    },
  ];
  await writeDebtors(next);
  return next;
}

export async function removeDebtor(id: string): Promise<Debtor[]> {
  const list = await readDebtors();
  const next = list.filter((d) => d.id !== id);
  await writeDebtors(next);
  return next;
}

/** Быстрый поиск должника по `clientId`. */
export function findDebtor(list: Debtor[], clientId: string): Debtor | undefined {
  const id = normalizeClientId(clientId);
  if (!id) return undefined;
  return list.find((d) => d.clientId === id);
}

/** Импорт из JSON: массив записей или массив строк-`clientId`. */
export function parseDebtorsJson(text: string): Debtor[] {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("ожидается JSON-массив");

  return normalizeDebtors(
    data.map((item) =>
      typeof item === "string" ? { clientId: item } : item,
    ),
  );
}

export function stringifyDebtors(list: Debtor[]): string {
  return JSON.stringify(
    list.map(({ clientId, name, note, at }) => ({ clientId, name, note, at })),
    null,
    2,
  );
}
