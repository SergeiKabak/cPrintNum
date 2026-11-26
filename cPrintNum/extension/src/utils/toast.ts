/**
 * Плашка-уведомление в правом верхнем углу страницы Ozon.
 *
 * Свой `div`, а не `alert()`: не блокирует страницу и не мешает сканеру.
 * Используется горячей клавишей Ctrl+O и проверкой должников.
 */

const TOAST_ID = "__printnum_toast";

export type ToastKind = "ok" | "err" | "warn";

const COLORS: Record<ToastKind, string> = {
  ok: "#16a34a",
  err: "#dc2626",
  warn: "#d97706",
};

export function removeToast(): void {
  document.getElementById(TOAST_ID)?.remove();
}

/** Показывает плашку в правом верхнем углу. */
export function showToast(text: string, kind: ToastKind = "ok", ms = 2500): void {
  removeToast();

  const host = document.body || document.documentElement;
  if (!host) return;

  const el = document.createElement("div");
  el.id = TOAST_ID;
  el.textContent = text;
  el.style.cssText = [
    "position:fixed",
    "top:16px",
    "right:16px",
    "z-index:2147483647",
    "max-width:380px",
    "padding:10px 14px",
    "border-radius:10px",
    "font:600 13px/1.35 Arial, Helvetica, sans-serif",
    "color:#fff",
    "white-space:pre-line",
    "pointer-events:none",
    "box-shadow:0 6px 24px rgba(0,0,0,.28)",
    `background:${COLORS[kind]}`,
    "opacity:1",
    "transition:opacity .25s ease",
  ].join(";");

  host.appendChild(el);

  window.setTimeout(() => {
    el.style.opacity = "0";
    window.setTimeout(removeToast, 300);
  }, ms);
}
