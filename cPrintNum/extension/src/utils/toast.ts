/**
 * Плашка-уведомление в правом верхнем углу страницы Ozon.
 *
 * Свой `div`, а не `alert()`: не блокирует страницу и не мешает сканеру.
 * Используется горячей клавишей Ctrl+O и проверкой должников.
 *
 * `ms <= 0` — плашка висит, пока её не закроют крестиком (нужно для
 * предупреждения о неоплаченном заказе: оператор должен её увидеть).
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

/** Показывает плашку в правом верхнем углу. `ms <= 0` — до закрытия крестиком. */
export function showToast(text: string, kind: ToastKind = "ok", ms = 2500): void {
  removeToast();

  const host = document.body || document.documentElement;
  if (!host) return;

  const sticky = ms <= 0;

  const el = document.createElement("div");
  el.id = TOAST_ID;
  el.style.cssText = [
    "position:fixed",
    "top:16px",
    "right:16px",
    "z-index:2147483647",
    "max-width:380px",
    "padding:10px 34px 10px 14px",
    "border-radius:10px",
    "font:600 13px/1.35 Arial, Helvetica, sans-serif",
    "color:#fff",
    "white-space:pre-line",
    "box-shadow:0 6px 24px rgba(0,0,0,.28)",
    `background:${COLORS[kind]}`,
    "opacity:1",
    "transition:opacity .25s ease",
    // пока висит — клики по самой плашке не должны проваливаться в страницу
    sticky ? "pointer-events:auto" : "pointer-events:none",
  ].join(";");

  const label = document.createElement("span");
  label.textContent = text;
  label.style.cssText = "display:block";

  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Закрыть");
  close.textContent = "×";
  close.style.cssText = [
    "position:absolute",
    "top:6px",
    "right:8px",
    "width:20px",
    "height:20px",
    "padding:0",
    "border:0",
    "border-radius:50%",
    "background:rgba(255,255,255,.22)",
    "color:#fff",
    "font:700 15px/18px Arial, Helvetica, sans-serif",
    "cursor:pointer",
    "pointer-events:auto",
  ].join(";");
  close.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    removeToast();
  });

  el.append(label, close);
  host.appendChild(el);

  if (sticky) return;

  window.setTimeout(() => {
    el.style.opacity = "0";
    window.setTimeout(removeToast, 300);
  }, ms);
}
