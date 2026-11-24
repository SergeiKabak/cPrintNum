/**
 * Хук значения с сохранением в `chrome.storage.local` (Preact).
 *
 * В отличие от `useStorageState` (работает с массивами-переключателями),
 * этот хук хранит любое одиночное значение: число, строку, boolean.
 *
 * Возвращает пару `[state, setState]`.
 */

declare const chrome: any;

import { useState, useEffect } from "preact/hooks";

export function useStorageValue<T>(key: string, initialValue: T) {
  const [state, setState] = useState<T>(initialValue);

  // Загружаем значение при старте popup.
  useEffect(() => {
    chrome.storage.local.get([key], (result: any) => {
      if (result[key] !== undefined) {
        setState(result[key] as T);
      }
    });
  }, [key]);

  // Сеттер с сохранением в хранилище.
  const setValue = (value: T | ((prev: T) => T)) => {
    setState((prev) => {
      const next =
        typeof value === "function" ? (value as (p: T) => T)(prev) : value;
      chrome.storage.local.set({ [key]: next });
      return next;
    });
  };

  return [state, setValue] as const;
}