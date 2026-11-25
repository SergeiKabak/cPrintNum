/**
 * Ctrl+O — включить/выключить печать (config.running) прямо со страницы Ozon.
 *
 * Зачем: оператору нужно быстро «поставить на паузу» печать (например, при
 * замене рулона), не открывая popup. Переключатель меняет то же поле
 * `running`, что и чекбокс в настройках, поэтому состояние общее.
 *
 * Тост рисуем сами в правом верхнем углу (не `alert()`): он не блокирует
 * страницу и не мешает работе со сканером.
 */

declare const chrome: any;

import { getSettings, saveSettings } from "@/utils/api";

const TOAST_ID = "__printnum_toast";
const TOAST_MS = 2500;

function removeToast(): void {
  document.getElementById(TOAST_ID)?.remove();
}

/** Показывает плашку в правом верхнем углу (зелёная — вкл, красная — выкл). */
function showToast(text: string, ok: boolean): void {
  removeToast();

  const el = document.createElement("div");
  el.id = TOAST_ID;
  el.textContent = text;
  el.style.cssText = [
    "position:fixed",
    "top:16px",
    "right:16px",
    "z-index:2147483647",
    "max-width:340px",
    "padding:10px 14px",
    "border-radius:10px",
    "font:600 13px/1.35 Arial, Helvetica, sans-serif",
    "color:#fff",
    "pointer-events:none",
    "box-shadow:0 6px 24px rgba(0,0,0,.28)",
    `background:${ok ? "#16a34a" : "#dc2626"}`,
    "opacity:1",
    "transition:opacity .25s ease",
  ].join(";");

  const host = document.body || document.documentElement;
  if (!host) return;
  host.appendChild(el);

  window.setTimeout(() => {
    el.style.opacity = "0";
    window.setTimeout(removeToast, 300);
  }, TOAST_MS);
}

let busy = false;

/** Читает текущее состояние и переключает печать. */
async function togglePrinting(): Promise<void> {
  if (busy) return;
  busy = true;

  try {
    const settings = await getSettings();
    if (!settings) {
      showToast("PrintNum не запущен", false);
      return;
    }

    const next = !settings.running;
    const result = await saveSettings({ running: next });

    if (!result.ok) {
      showToast(result.error || "Не удалось переключить печать", false);
      return;
    }

    showToast(next ? "Печать включена" : "Печать выключена", next);
  } catch {
    showToast("PrintNum не запущен", false);
  } finally {
    busy = false;
  }
}

export default defineContentScript({
  matches: ["https://turbo-pvz.ozon.ru/*"],

  // document_start: перехватываем Ctrl+O раньше страницы.
  runAt: "document_start",

  main(ctx) {
    // Ctrl+O (и Cmd+O на macOS). Shift допускается как альтернатива на случай,
    // если браузер всё же перехватит Ctrl+O своим «открыть файл».
    ctx.addEventListener(
      window,
      "keydown",
      (event: KeyboardEvent) => {
        if (event.repeat) return;
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.altKey) return;
        if (event.key.toLowerCase() !== "o") return;

        event.preventDefault();
        event.stopPropagation();

        void togglePrinting();
      },
      { capture: true },
    );
  },
});
