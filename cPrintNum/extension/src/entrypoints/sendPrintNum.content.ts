declare const chrome: any;

import { SELECTORS, CELL_CODE_RE, workPathNames } from "@/utils/constants";
import { subscribe } from "@/utils/observer";
import { registerScannerSimulator, onSimulatedScan } from "@/utils/scannerSimulator";
import {
  AUTO_PRINT_KEY,
  normalizeAutoPrint,
  type AutoPrintSettings,
} from "@/utils/autoPrintSettings";
import {
  normalizePlacement,
  type Placement,
} from "@/utils/ozonPlacements";

export default defineContentScript({
  matches: ["https://turbo-pvz.ozon.ru/*"],

  // document_start — чтобы bridge был готов до первых XHR страницы.
  runAt: "document_start",

  async main(ctx) {
    // В dev-сборке доступен эмулятор сканера: PrintNumScanner.simulate("123-47").
    registerScannerSimulator();

    let settings: AutoPrintSettings = normalizeAutoPrint(undefined);
    let firstRun = false;
    let observer: MutationObserver | null = null;

    // Старый список текстов, с которым сравниваем новый
    let previousTexts: string[] = [];

    /**
     * Отправляет событие в background. Печать выполняет service worker:
     * там дедупликация, проверка режима и HTTP-запрос к C-службе.
     */
    function requestPrint(placement: Placement): Promise<boolean> {
      return new Promise((resolve) => {
        try {
          // После обновления расширения старый content script уже невалиден.
          if (!chrome?.runtime?.id) {
            resolve(false);
            return;
          }

          chrome.runtime.sendMessage(
            { action: "printAuto", payload: placement },
            (response: any) => {
              // Ошибка «Receiving end does not exist» ожидаема, если
              // service worker ещё не поднялся; гасим lastError.
              void chrome.runtime.lastError;
              resolve(!!response?.ok);
            },
          );
        } catch {
          resolve(false);
        }
      });
    }

    // Настройки автопечати: читаем сразу и слушаем изменения popup'а.
    try {
      chrome.storage.local.get([AUTO_PRINT_KEY], (result: any) => {
        settings = normalizeAutoPrint(result?.[AUTO_PRINT_KEY]);
      });
    } catch {
      // Контекст расширения уже невалиден — работаем на дефолтах.
    }

    const onStorageChanged = (changes: any, area: string) => {
      if (area !== "local" || !changes?.[AUTO_PRINT_KEY]) return;
      settings = normalizeAutoPrint(changes[AUTO_PRINT_KEY].newValue);
    };

    chrome.storage.onChanged.addListener(onStorageChanged);
    ctx.onInvalidated(() => {
      try {
        chrome.storage.onChanged.removeListener(onStorageChanged);
      } catch {
        // контекст уже невалиден
      }
    });

    // --------------------------------------------------------
    // Bridge из MAIN-мира.
    //
    // pageHook.js перехватывает XHR и присылает сюда placement
    // через window.postMessage. Проверяем origin/source и форму.
    // --------------------------------------------------------
    ctx.addEventListener(window, "message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;

      const data = event.data;
      if (!data || data.source !== "PrintNum" || data.type !== "PLACEMENT") {
        return;
      }

      const placement = normalizePlacement(data.payload);
      if (!placement) return;

      void requestPrint(placement);
    });

    // Просим background внедрить pageHook в MAIN-мир.
    // Chrome 95+ / Firefox 102+: world "MAIN" через scripting API.
    //
    // На document_start service worker может ещё просыпаться, поэтому
    // первый sendMessage иногда не доходит до слушателя. Повторяем
    // с backoff — к моменту размещения товара hook уже точно стоит.
    function requestPageHook(attempt = 0) {
      try {
        if (!chrome?.runtime?.id) return;

        chrome.runtime.sendMessage(
          { action: "injectPageHook" },
          (response: any) => {
            const err = chrome.runtime.lastError;
            if (!err && response?.ok) return;

            if (attempt < 4) {
              ctx.setTimeout(
                () => requestPageHook(attempt + 1),
                250 * 2 ** attempt,
              );
              return;
            }

            console.warn(
              `[PrintNum] pageHook не внедрён: ${err?.message ?? response?.error ?? "unknown"}`,
            );
          },
        );
      } catch {
        // Контекст невалиден — вкладку нужно перезагрузить.
      }
    }

    requestPageHook();

    function getTexts(): string[] {
      const tags = document.querySelectorAll(SELECTORS.numprint);

      return Array.from(tags)
        .map((tag) => tag.textContent?.trim() || "")
        .filter(Boolean)
        // Исключаем текстовые ячейки ('Возврат-1', 'Прямой поток-5'):
        // они не являются номером ячейки.
        .filter((text) => CELL_CODE_RE.test(text))
        .slice(0, 10);
    }

    function areListsEqual(first: string[], second: string[]): boolean {
      if (first.length !== second.length) {
        return false;
      }

      return first.every((text, index) => text === second[index]);
    }

    function runScript() {
      // В режимах xhr/off DOM-наблюдатель молчит.
      if (settings.mode === "xhr" || settings.mode === "off") return;

      const currentTexts = getTexts();

      if (!currentTexts.length) return;

      // Первый запуск:
      // просто сохраняем список, ничего не отправляем
      if (!firstRun) {
        previousTexts = currentTexts;
        firstRun = true;
        return;
      }

      // Если список не изменился — ничего не делаем
      if (areListsEqual(currentTexts, previousTexts)) {
        return;
      }

      // Список изменился.
      // Отправляем первый текст нового списка.
      const newText = currentTexts[0];

      if (newText) {
        // DOM уже сравнил списки, поэтому dedupe: none — не подавляем
        // повторное размещение в ту же ячейку. В режиме both от двойной
        // печати DOM+XHR защищает overlapGuardMs в background.
        const placement = normalizePlacement({
          text: newText,
          origin: "dom",
          dedupe: "none",
          raw: newText,
        });
        if (placement) void requestPrint(placement);
      }

      // Обновляем старый список только после успешной отправки
      previousTexts = currentTexts;
    }

    function resetState() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }

      firstRun = false;
      previousTexts = [];
    }

    function toggleState() {
      // Всегда очищаем старый observer
      if (observer) {
        observer.disconnect();
        observer = null;
      }

      if (location.pathname !== workPathNames.recommendation) {
        resetState();
        return;
      }

      // Создаем новый observer
      observer = new MutationObserver(() => runScript());

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    subscribe(toggleState);

    // Логирование и обработка симулированного сканирования (dev).
    //
    // В боевом режиме печать вызывает XHR-hook или DOM-наблюдатель.
    // Эмулятор сканера меняет только keydown-события и DOM не трогает,
    // поэтому здесь явно прогоняем номер через ту же отправку.
    let lastSimulated: { value: string; at: number } | null = null;
    onSimulatedScan((value) => {
      // Эмулированное сканирование тоже не должно отправлять
      // текстовые ячейки: иначе в консоли придётся видеть мусор.
      if (!CELL_CODE_RE.test(value)) {
        console.info(
          `[PrintNum:scanner] пропущено (текстовая ячейка): "${value}"`,
        );
        return;
      }

      console.info(`[PrintNum:scanner] обработка номера: "${value}"`);

      // Защита от возможного дублирования с DOM-событием.
      const now = Date.now();
      if (
        lastSimulated &&
        lastSimulated.value === value &&
        now - lastSimulated.at < 500
      ) {
        return;
      }
      lastSimulated = { value, at: now };

      const placement = normalizePlacement({
        text: value,
        origin: "scanner",
        dedupe: "none",
        raw: value,
      });

      if (!placement) {
        console.info(`[PrintNum:scanner] некорректный номер: "${value}"`);
        return;
      }

      requestPrint(placement).then((ok) => {
        console.info(
          ok
            ? `[PrintNum:scanner] номер "${value}" отправлен в PrintNum`
            : `[PrintNum:scanner] не удалось отправить номер "${value}"`,
        );
      });
    });
  },
});
