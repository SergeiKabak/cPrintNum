import { sendServer } from "@/utils/api";
import { SELECTORS, workPathNames } from "@/utils/constants";
import { subscribe } from "@/utils/observer";
import { registerScannerSimulator, onSimulatedScan } from "@/utils/scannerSimulator";

export default defineContentScript({
  matches: ["https://turbo-pvz.ozon.ru/*"],

  async main() {
    // В dev-сборке доступен эмулятор сканера: PrintNumScanner.simulate("123-47").
    registerScannerSimulator();

    let firstRun = false;
    let observer: MutationObserver | null = null;

    // Старый список текстов, с которым сравниваем новый
    let previousTexts: string[] = [];

    const URL = "print-number";

    async function sendNumber(number: string): Promise<boolean> {
      try {
        const response = await sendServer.post(URL, { text: number });

        if (!response.ok) {
          console.error(
            `Ошибка сервера: ${response.status} ${response.statusText}`,
          );
          return false;
        }

        return true;
      } catch (error) {
        console.error("Ошибка отправки номера:", error);
        return false;
      }
    }

    function getTexts(): string[] {
      const tags = document.querySelectorAll(SELECTORS.numprint);

      return Array.from(tags)
        .map((tag) => tag.textContent?.trim() || "")
        .filter(Boolean)
        .slice(0, 10);
    }

    function areListsEqual(first: string[], second: string[]): boolean {
      if (first.length !== second.length) {
        return false;
      }

      return first.every((text, index) => text === second[index]);
    }

    function runScript() {
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
      // Отправляем первый текст нового списка
      const newText = currentTexts[0];

      sendNumber(newText);

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

    // Логирование симулированного сканирования (dev) — видно в консоли.
    onSimulatedScan((value) => {
      console.info(`[PrintNum:scanner] обработка номера: "${value}"`);
    });
  },
});
