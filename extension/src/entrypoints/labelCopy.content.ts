/**
 * Подхват штрихкода из кнопки «копировать» на странице Ozon.
 *
 * # Зачем
 *
 * На страницах Ozon есть кнопки копирования значений (номер отправления,
 * штрихкод, название товара). Их значения уже присутствуют в DOM — рядом
 * с кнопкой лежит скрытый `textarea`:
 *
 * ```html
 * <div class="_copy_1ulht_50 _copyButton_o3a5g_142">
 *   <button>
 *     <a href="..."><div>ii8923223139</div></a>
 *     <svg class="_icon_1ulht_18">…</svg>          <!-- иконка «копировать» -->
 *   </button>
 *   <textarea class="_textarea_1ulht_54" value="ii8923223139"></textarea>
 * </div>
 * ```
 *
 * Поэтому буфер обмена не нужен: при клике читаем `textarea.value`
 * и кладём значение в `chrome.storage.local`. Генератор штрихкодов
 * подставляет его при следующем открытии окна.
 *
 * # Почему не слушаем событие copy и не парсим тост
 *
 * - Тост «Скопировали этикетку» — текст в интерфейсе, его могут
 *   переименовать или локализовать; парсинг текста ненадёжен.
 * - Событие `copy` срабатывает на любое копирование на странице
 *   (включая ручное выделение текста).
 *
 * Чтение DOM даёт точное значение и не зависит от формулировок Ozon.
 *
 * # Фильтрация
 *
 * В `chrome.storage.local` попадают только значения формата штрихкода
 * (`ii` + 9–14 цифр, см. [`LABEL_BARCODE_RE`]). Клик по кнопке рядом
 * с названием товара или номером отправления ничего не меняет.
 */

declare const chrome: any;

import { LABEL_BARCODE_RE, SELECTORS } from "@/utils/constants";

/** Ключ в chrome.storage.local, откуда генератор читает последний ШК. */
export const LAST_LABEL_KEY = "lastCopiedLabel";

export default defineContentScript({
  matches: ["https://turbo-pvz.ozon.ru/*"],

  /**
   * @param event Событие клика (фаза перехвата).
   * @returns Найденный штрихкод либо `null`.
   */
  main(ctx) {
    /**
     * Достаёт скопированное значение из блока кнопки.
     *
     * @param target Элемент, по которому кликнули.
     * @returns Значение `textarea` либо `null`, если клик был не по кнопке.
     */
    function readCopiedValue(target: EventTarget | null): string | null {
      const el = target as HTMLElement | null;
      if (!el || typeof el.closest !== "function") return null;

      // Клик мог прийтись по иконке внутри кнопки — поднимаемся к кнопке,
      // затем к обёртке, в которой лежит textarea.
      const button = el.closest("button");
      if (!button) return null;

      const box = button.closest(SELECTORS.copyButton);
      if (!box) return null;

      const area = box.querySelector(SELECTORS.copyValue) as
        | HTMLTextAreaElement
        | null;

      const value = area?.value?.trim();
      return value ? value : null;
    }

    // Фаза перехвата (capture): значение в textarea уже есть, а обработчики
    // страницы могут менять DOM после клика — читаем до них.
    //
    // ctx.addEventListener снимает обработчик при перезагрузке расширения:
    // без этого старый content script на открытой вкладке продолжает
    // ловить клики и падает с `Extension context invalidated`.
    ctx.addEventListener(
      document,
      "click",
      (event) => {
        const value = readCopiedValue(event.target);
        if (!value) return;

        // Интересует только штрихкод отправления.
        if (!LABEL_BARCODE_RE.test(value)) return;

        try {
          // После обновления расширения старый контекст уже невалиден —
          // молча выходим, пока пользователь не обновит вкладку.
          if (!chrome?.runtime?.id) return;

          chrome.storage.local.set({ [LAST_LABEL_KEY]: value });
          console.info(`[PrintNum:label] подхвачен штрихкод: ${value}`);
        } catch (error) {
          console.debug("[PrintNum:label] storage недоступен:", error);
        }
      },
      { capture: true },
    );
  },
});
