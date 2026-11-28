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
import { applyGiveoutGuard } from "@/utils/giveoutGuard";
import { codeMatches } from "@/utils/ozonSessions";
import { showToast } from "@/utils/toast";

const MAX_ENTRIES = 3000;
const STATS_KEY = "debtorStats";
const BLOCK_KEY = "debtorBlockGiveout";
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
    /** Блокировать ли кнопку «Выдать», когда клиент сессии в долгу. */
    let blockGiveout = true;
    /** Сессия, по которой уже показали предупреждение (чтобы не спамить). */
    let warnedSession = "";
    /** Последний клиент-должник: нужен, чтобы вернуть блокировку после
     *  выключения и включения галки в popup. */
    let lastDebtor: { clientId: string; name?: string } | null = null;

    const loadDebtors = () => {
      readDebtors().then((list) => {
        debtors = list;
      });
    };

    loadDebtors();

    chrome.storage.local.get([BLOCK_KEY], (stored: any) => {
      if (typeof stored?.[BLOCK_KEY] === "boolean") blockGiveout = stored[BLOCK_KEY];
      else blockGiveout = true;
    });

    const onStorageChanged = (changes: any, area: string) => {
      if (area !== "local") return;
      if (changes?.debtors) loadDebtors();
      if (changes?.[BLOCK_KEY] && typeof changes[BLOCK_KEY].newValue === "boolean") {
        blockGiveout = changes[BLOCK_KEY].newValue;
        if (!blockGiveout) {
          applyGiveoutGuard(null);
        } else if (lastDebtor) {
          // Галку вернули, а предметы уже выбраны — блокируем снова.
          applyGiveoutGuard(lastDebtor);
        }
      }
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

      if (pairs.length) sessionOrders = pairs.slice(-MAX_ENTRIES);

      // Диагностика для popup: сколько связок «клиент ↔ отправление» поймали.
      try {
        chrome.storage.local.set({
          [STATS_KEY]: {
            pairs: sessionOrders.length,
            clients: clientNames.size,
            at: Date.now(),
          },
        });
      } catch {
        // storage может быть недоступен при выгрузке расширения
      }

      if (!pairs.length) return;

      const byClient = new Map<string, number>();
      for (const { clientId } of sessionOrders) {
        byClient.set(clientId, (byClient.get(clientId) ?? 0) + 1);
      }

      const hits = debtors.filter((d) => byClient.has(d.clientId));
      if (hits.length) {
        console.info(
          `[PrintNum:debt] в сессиях выдачи должники: ${hits.map((d) => d.clientId).join(", ")}`,
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

      const display = debtor.name || clientNames.get(debtor.clientId) || "";
      const who = display ? `${display} (${debtor.clientId})` : debtor.clientId;
      showToast(`Не оплачено!\n${who}\nОтправление: ${code}`, "err", TOAST_MS);
      console.warn(`[PrintNum:debt] должник ${who}, отправление ${code}`);
    };

    /**
     * Решение по клиенту сессии выдачи: должник → блокируем кнопку «Выдать»
     * и показываем плашку с именем из Ozon (`shortName`).
     */
    const evaluateGiveout = (input: {
      clientId: string;
      sessionId?: string;
      clientName?: string;
      /** Снимать блокировку, если клиент не должник (только явный ввод кода). */
      allowClear?: boolean;
    }) => {
      const { clientId } = input;
      if (!clientId) return;

      const debtor = debtors.find((d) => d.clientId === clientId);
      if (!debtor) {
        // Блокировку снимаем только по явному вводу кода другого клиента:
        // фоновые ответы API не должны «разблокировать» должника случайно.
        if (input.allowClear) {
          lastDebtor = null;
          applyGiveoutGuard(null);
          warnedSession = "";
        }
        return;
      }

      const ozonName = input.clientName?.trim() || clientNames.get(clientId) || debtor.name || "";
      const who = ozonName ? `${ozonName} (${clientId})` : clientId;
      const clientKey = input.sessionId || clientId;

      lastDebtor = { clientId, name: ozonName || clientId };
      if (blockGiveout) applyGiveoutGuard(lastDebtor);

      if (warnedSession !== clientKey) {
        warnedSession = clientKey;
        // Висит, пока оператор не закроет крестиком (ms = 0).
        showToast(
          `Не оплачено!\nКлиент: ${who}\nВыдача заблокирована — закройте плашку крестиком, когда разберётесь`,
          "err",
          0,
        );
        console.warn(`[PrintNum:debt] должник ${who}, сессия ${input.sessionId || "—"}`);
      }
    };

    /**
     * Код выдачи Ozon — `<clientId>*<NNNN>` (например, `89367626*0328`).
     * Проверяем прямо в поле сканера: блокировка включается до ответа API.
     */
    const GIVEOUT_CODE_RE = /^(\d{3,})\s*\*\s*\d{1,6}$/;

    const onScanInput = (event: Event) => {
      const el = event.target as HTMLInputElement | null;
      if (!el || el.tagName !== "INPUT") return;
      const value = (el.value || "").trim();
      if (!value.includes("*")) return;
      const m = value.match(GIVEOUT_CODE_RE);
      if (!m?.[1]) return;
      evaluateGiveout({ clientId: m[1], allowClear: true });
    };

    document.addEventListener("input", onScanInput, true);
    ctx.onInvalidated(() => document.removeEventListener("input", onScanInput, true));

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
            (p: any) => p && typeof p.clientId === "string" && typeof p.code === "string",
          ),
          clients.filter((c: any) => c && typeof c.clientId === "string"),
        );
        return;
      }

      if (data.type === "GIVEOUT") {
        const payload = data.payload ?? {};
        evaluateGiveout({
          clientId: typeof payload.clientId === "string" ? payload.clientId : "",
          sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
          clientName: typeof payload.clientName === "string" ? payload.clientName : "",
        });
        return;
      }

      if (data.type === "ORDER") {
        const code = data.payload?.code;
        if (typeof code === "string") checkScan(code.trim());
      }
    });
  },
});
