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
import { showToast } from "@/utils/toast";

let busy = false;

/** Читает текущее состояние и переключает печать. */
async function togglePrinting(): Promise<void> {
  if (busy) return;
  busy = true;

  try {
    const settings = await getSettings();
    if (!settings) {
      showToast("PrintNum не запущен", "err");
      return;
    }

    const next = !settings.running;
    const result = await saveSettings({ running: next });

    if (!result.ok) {
      showToast(result.error || "Не удалось переключить печать", "err");
      return;
    }

    showToast(next ? "Печать включена" : "Печать выключена", next ? "ok" : "err");
  } catch {
    showToast("PrintNum не запущен", "err");
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
