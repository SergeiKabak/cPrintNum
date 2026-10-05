/**
 * HTTP-клиент приложения PrintNum.
 *
 * Порт приложения можно задать при сборке расширения через `.env`
 * (`VITE_PRINTNUM_PORT`). Значение подставляется Vite на этапе сборки —
 * во время выполнения расширение переменные окружения не читает.
 *
 * Порт по умолчанию — 5000. Он должен совпадать с портом приложения
 * (`PRINTNUM_PORT` в приложении или его `.env`).
 */

const DEFAULT_PORT = "5000";

const PORT = import.meta.env.VITE_PRINTNUM_PORT || DEFAULT_PORT;

const API_BASE = `http://127.0.0.1:${PORT}`;

export const sendServer = {
  get: async (domain = API_BASE, endpoint = "") =>
    fetch(`${domain}/${endpoint}`),
  post: async (endpoint: string, body: Object) =>
    fetch(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
};

/**
 * Настройки печати — те же поля, что и в `config.json` приложения.
 *
 * Имена в camelCase: так их отдаёт `GET /config` и принимает `POST /config`.
 */
export type PrintSettings = {
  printer: string;
  paper: string;
  idNum: boolean;
  endLine: boolean;
  hybrid: boolean;
  expand: number;
  running: boolean;
  papers: string[];
};

/** Читает текущие настройки из приложения. Возвращает null, если оно недоступно. */
export async function getSettings(): Promise<PrintSettings | null> {
  try {
    const res = await sendServer.get(API_BASE, "config");
    if (!res.ok) return null;
    return (await res.json()) as PrintSettings;
  } catch {
    return null;
  }
}

/**
 * Отправляет изменения настроек.
 *
 * Тело — частичный объект: приложение меняет только переданные поля.
 * Возвращает обновлённые настройки либо текст ошибки.
 */
export async function saveSettings(
  patch: Partial<PrintSettings>,
): Promise<{ ok: true; settings: PrintSettings } | { ok: false; error: string }> {
  try {
    const res = await sendServer.post("config", patch);
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      return {
        ok: false,
        error: data?.error || `Ошибка ${res.status}`,
      };
    }

    return { ok: true, settings: data as PrintSettings };
  } catch (e) {
    return { ok: false, error: "Приложение PrintNum не запущено" };
  }
}

/** Читает список размеров этикеток из приложения. */
export async function getPapers(): Promise<string[]> {
  try {
    const res = await sendServer.get(API_BASE, "papers");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.papers) ? data.papers : [];
  } catch {
    return [];
  }
}

/** Список принтеров, установленных в системе. */
export async function getPrinters(): Promise<string[]> {
  try {
    const res = await sendServer.get(API_BASE, "listPrinters");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.listPrinters) ? data.listPrinters : [];
  } catch {
    return [];
  }
}
