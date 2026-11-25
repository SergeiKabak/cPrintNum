/**
 * Проверка должников при выдаче.
 *
 * 1. `pageHook` (MAIN) перехватывает `/api2/giveout/Sessions` и присылает
 *    сюда пары «clientId → номер отправления».
 * 2. На скане отправления (ответ резолвера) приходит код отправления.
 * 3. Если `clientId` этого отправления есть в локальной базе должников
 *    (`chrome.storage.local.debtors`), показываем красную плашку:
 *    «Не оплачено: отправление …».
 *
 * База редактируется в popup (панель «Должники»), здесь только чтение.
 */

declare const chrome: any;

import { readDebtors, type Debtor } from "@/utils/debtors";
import { codeMatches } from "@/utils/ozonSessions";
import { showToast } from "@/utils/toast";

const MAX_ENTRIES = 3000;
const TOAST_MS = 8000;

export default defineContentScript({
  matches: ["https://turbo-pvz.ozon.ru/*"],

  // document_start: bridge из MAIN-мира должен быть готов до запросов страницы.
  runAt: "document_start",

  main(ctx) {
    /** Пары из ответов Ozon: какие отправления относятся к какому клиенту. */
    let sessionOrders: { clientId: string; code: string; clientName?: string }[] = [];
    /** `clientId → clientShortName` из `/giveout/Sessions` (там нет отправлений). */
    const clientNames = new Map<string, string>();
    let debtors: Debtor[] = [];

    const loadDebtors = () => {
      readDebtors().then((list) => {
        debtors = list;
      });
    };

    loadDebtors();

    const onStorageChanged = (changes: any, area: string) => {
      if (area !== "local" || !changes?.debtors) return;
      loadDebtors();
    };

    chrome.storage.onChanged.addListener(onStorageChanged);
    ctx.onInvalidated(() => {
      try {
        chrome.storage.onChanged.removeListener(onStorageChanged);
      } catch {
        // контекст уже невалиден
      }
    });

    const rememberSessions = (
      pairs: { clientId: string; code: string; clientName?: string }[],
      clients: { clientId: string; clientName?: string }[] = [],
    ) => {
      for (const c of clients) {
        if (c.clientName) clientNames.set(c.clientId, c.clientName);
      }

      if (!pairs.length) return;

      sessionOrders = pairs.slice(-MAX_ENTRIES);

      const byClient = new Map<string, number>();
      for (const { clientId } of sessionOrders) {
        byClient.set(clientId, (byClient.get(clientId) ?? 0) + 1);
      }

      const hits = debtors.filter((d) => byClient.has(d.clientId));
      if (hits.length) {
        console.info(
          `[PrintNum:debt] в сессиях выдачи должники: ${hits
            .map((d) => d.clientId)
            .join(", ")}`,
        );
      }
    };

    /** Проверка скана: находим clientId по номеру отправления. */
    const checkScan = (code: string) => {
      if (!code) return;

      const matchedClients = new Set<string>();
      for (const entry of sessionOrders) {
        if (codeMatches(code, entry.code)) matchedClients.add(entry.clientId);
      }

      if (!matchedClients.size) return;

      const debtor = debtors.find((d) => matchedClients.has(d.clientId));
      if (!debtor) return;

      const display =
        debtor.name || clientNames.get(debtor.clientId) || "";
      const who = display ? `${display} (${debtor.clientId})` : debtor.clientId;
      showToast(`Не оплачено!\n${who}\nОтправление: ${code}`, "err", TOAST_MS);
      console.warn(`[PrintNum:debt] должник ${who}, отправление ${code}`);
    };

    // ---- сообщения из pageHook (MAIN world) ----
    ctx.addEventListener(window, "message", (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;

      const data = event.data;
      if (!data || data.source !== "PrintNum") return;

      if (data.type === "SESSIONS") {
        const pairs = Array.isArray(data.payload?.orders) ? data.payload.orders : [];
        const clients = Array.isArray(data.payload?.clients) ? data.payload.clients : [];

        rememberSessions(
          pairs.filter(
            (p: any) =>
              p && typeof p.clientId === "string" && typeof p.code === "string",
          ),
          clients.filter(
            (c: any) => c && typeof c.clientId === "string",
          ),
        );
        return;
      }

      if (data.type === "ORDER") {
        const code = data.payload?.code;
        if (typeof code === "string") checkScan(code.trim());
      }
    });
  },
});
