/**
 * Клиент native messaging для связи с приложением PrintNum через stdio.
 *
 * Альтернатива HTTP: браузер сам запускает `printnum.exe --native-host`
 * и обменивается JSON-сообщениями. Не требует открытого порта.
 *
 * Требует разрешения `nativeMessaging` и зарегистрированного host-манифеста
 * (`ru.printnum.host`). Если host недоступен — вызывающий код может
 * откатиться на HTTP (`sendServer`).
 */

declare const chrome: any;

/** Имя host-манифеста (должно совпадать при регистрации). */
export const NATIVE_HOST_NAME = "ru.printnum.host";

/** Есть ли доступ к native messaging в этом браузере. */
export function isNativeAvailable(): boolean {
  return typeof chrome !== "undefined" && !!chrome.runtime?.sendNativeMessage;
}

/**
 * Отправляет сообщение в native-host и возвращает ответ.
 * Бросает ошибку, если host недоступен.
 */
export function sendNative<T = any>(message: object): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!isNativeAvailable()) {
      reject(new Error("native messaging недоступен"));
      return;
    }
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      message,
      (response: any) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || "native host error"));
          return;
        }
        resolve(response as T);
      },
    );
  });
}

/** Проверка доступности host-приложения (команда ping). */
export async function nativePing(): Promise<boolean> {
  try {
    const r = await sendNative<{ status?: string }>({ command: "ping" });
    return r?.status === "ok";
  } catch {
    return false;
  }
}