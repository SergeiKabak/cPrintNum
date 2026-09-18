/**
 * Хук состояния с сохранением в `chrome.storage.local` (Preact).
 *
 * Аналог прежнего React-хука. Возвращает пару `[state, toggle]`,
 * где `toggle` переключает наличие элемента в массиве.
 *
 * Важно: имя экспортируется так же (`useStorageState`), чтобы WXT
 * auto-import продолжал работать без правок в потребителях.
 */

declare const chrome: any;

import { useState, useEffect } from "preact/hooks";

export function useStorageState(key: string, initialValue: string[]) {
  const [state, setState] = useState<string[]>(initialValue);

  // Загружаем данные при старте popup.
  useEffect(() => {
    chrome.storage.local.get([key], (result: any) => {
      if (result[key]) {
        setState(result[key]);
      }
    });
  }, [key]);

  // Переключатель элемента.
  const toggleItem = (item: string) => {
    setState((prev) => {
      const newValue = prev.includes(item)
        ? prev.filter((i) => i !== item)
        : [...prev, item];

      // Сохраняем в память расширения.
      chrome.storage.local.set({ [key]: newValue });

      return newValue;
    });
  };

  return [state, toggleItem] as const;
}