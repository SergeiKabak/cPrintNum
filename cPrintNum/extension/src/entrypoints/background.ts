declare const chrome: any;

import {
  AUTO_PRINT_KEY,
  DEFAULT_AUTO_PRINT,
} from "@/utils/autoPrintSettings";
import { handleAutoPrint } from "@/utils/autoPrint";

export default defineBackground({
  async main() {
    // ========================================================
    // Автопечать: миграция настроек.
    //
    // Существующие пользователи (update) остаются на привычном DOM-
    // режиме, новые установки получают перехват ответов Ozon.
    // Если пользователь уже менял настройки — не трогаем.
    // ========================================================
    chrome.runtime.onInstalled.addListener(async ({ reason }: any) => {
      try {
        const stored = await chrome.storage.local.get(AUTO_PRINT_KEY);
        if (stored?.[AUTO_PRINT_KEY]) return;

        await chrome.storage.local.set({
          [AUTO_PRINT_KEY]: {
            ...DEFAULT_AUTO_PRINT,
            mode: reason === "install" ? "xhr" : "dom",
          },
        });
      } catch (err) {
        console.error(`PrintNum: autoPrint init: ${err}`);
      }
    });

    // ========================================================
    // Автопечать: очередь и сообщения от content scripts.
    //
    // Очередь нужна, потому что C-служба печатает синхронно и
    // однопоточно: так этикетки уходят в порядке событий.
    // ========================================================
    let printChain: Promise<unknown> = Promise.resolve();

    chrome.runtime.onMessage.addListener(
      (message: any, sender: any, sendResponse: any) => {
        if (message?.action === "injectPageHook") {
          if (
            sender?.tab?.id == null ||
            typeof chrome.scripting?.executeScript !== "function"
          ) {
            sendResponse?.({ ok: false, error: "scripting unavailable" });
            return;
          }

          chrome.scripting.executeScript(
            {
              target: {
                tabId: sender.tab.id,
                frameIds: [sender.frameId ?? 0],
              },
              // Chrome 95+: MAIN-world инъекция без manifest-ключа
              // `world` (его поддерживает только Chrome 111+, а на
              // Windows 7 максимум Chrome 109).
              world: "MAIN",
              files: ["pageHook.js"],
            },
            () => {
              const err = chrome.runtime.lastError;
              if (err) {
                console.warn(`PrintNum: pageHook injection: ${err.message}`);
              }
              sendResponse?.({
                ok: !err,
                ...(err ? { error: err.message } : {}),
              });
            },
          );

          // Ответ асинхронный — ждём результата executeScript.
          return true;
        }

        if (message?.action === "printAuto") {
          printChain = printChain
            .then(() => handleAutoPrint(message.payload))
            .catch((err) => {
              console.error(`PrintNum: autoPrint: ${err}`);
            });

          sendResponse?.({ ok: true, queued: true });
          return;
        }
      },
    );

  },
});
