import { defineConfig } from "wxt";

// Список entrypoint'ов, которые попадают в сборку. Всё, чего здесь нет,
// WXT пропускает (файлов вне списка в сборке нет).
const INCLUDED_ENTRYPOINTS = [
  "background",
  "popup",
  "sendPrintNum", // печать ячеек (основная функция)
  "labelCopy",    // подхват ШК из кнопок «копировать»
  "pageHook",     // MAIN-world перехват ответов Ozon (инъекция из background)
];

// See https://wxt.dev/api/config.html
export default defineConfig({
  filterEntrypoints: INCLUDED_ENTRYPOINTS,

  manifest: {
    permissions: ["storage", "scripting"],
    action: {},
    name: "PrintNum - Печать Ячеек (Ozon)",
    description:
      "Полезные инструменты для turbo-pvz.ozon.ru: печать ячеек, автоскрипты, удобная автоматизация по QR-кодам и другое.",
    host_permissions: [
      "http://localhost/*",
      "http://127.0.0.1/*",
      // Нужно для chrome.scripting.executeScript({ world: "MAIN" })
      // и инъекции pageHook на страницы Ozon.
      "https://turbo-pvz.ozon.ru/*",
    ],
  },

  srcDir: "src",

  // Папка сборки: extension/output/<браузер> (например, output/chrome-mv3).
  outDir: "output",

  vite: () => ({
    // Popup написан на Preact (лёгкая замена React): JSX компилируется
    // в вызовы preact/jsx-runtime.
    esbuild: {
      jsx: "automatic" as const,
      jsxImportSource: "preact",
      target: "es2022",
    },
    build: {
      target: "es2022" as const,
      // Отключаем inline-полифилл modulepreload (CSP в MV3 блокирует inline-скрипты).
      modulePreload: { polyfill: false },
    },
    resolve: {
      alias: {
        // Позволяет писать `import { useState } from "react"` при желании,
        // но основной код использует preact напрямую.
        react: "preact/compat",
        "react-dom": "preact/compat",
      },
    },
  }),
});