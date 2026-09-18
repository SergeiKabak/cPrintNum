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