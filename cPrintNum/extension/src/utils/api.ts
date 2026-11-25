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
  /** Печатать QR товара рядом с номером (без точки). */
  qrWithNumber: boolean;
  /** Шахматная заливка цифры (экономия термоголовки). */
  checker: boolean;
  /** Размер клетки шахматки в 0.1 мм (10 = 1.0 мм). */
  checkerMm: number;
  /** Сплошная обводка по контуру глифа. */
  outline: boolean;
  /** Толщина обводки в 0.01 мм (5 = 0.05 мм); 0 — без контура. */
  outlineMm: number;
  /** Как печатать: "gdi" — через драйвер Windows, "escpos" — raw ESC/POS. */
  printerMode: string;
  /** Зазор между этикетками (die-cut) в 0.1 мм (30 = 3 мм), только ESC/POS. */
  labelGapMm: number;
  /** Сдвиг картинки вправо в 0.1 мм, только ESC/POS. */
  rawXOffsetMm: number;
  /** Транспорт raw-печати: "spooler" (USB/LAN/BT через драйвер) или "tcp". */
  rawTransport: string;
  /** IP принтера для rawTransport = "tcp". */
  rawHost: string;
  /** TCP-порт raw-печати (обычно 9100). */
  rawPort: number;
  /** Папка превью: вместо печати сохранять этикетки в BMP (пусто — выкл). */
  previewDir: string;
  papers: string[];
  /**
   * Возможности backend'а. Например, `shelf-dash` — поддержка полок `-88`.
   * У старых версий PrintNum поля нет.
   */
  features?: string[];
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

/** Состояние службы: установлена ли в автозагрузку. */
export async function getServiceStatus(): Promise<boolean> {
  try {
    const res = await sendServer.get(API_BASE, "service");
    if (!res.ok) return false;
    const data = await res.json();
    return data?.installed === true;
  } catch {
    return false;
  }
}

/** Устанавливает службу в автозагрузку и запускает её. */
export async function installService(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await sendServer.post("service/install", {});
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, error: data?.error || `Ошибка ${res.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Приложение PrintNum не запущено" };
  }
}

/** Удаляет службу из автозагрузки. */
export async function uninstallService(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await sendServer.post("service/uninstall", {});
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, error: data?.error || `Ошибка ${res.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Приложение PrintNum не запущено" };
  }
}
