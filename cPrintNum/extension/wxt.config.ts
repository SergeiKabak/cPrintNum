import { defineConfig } from "wxt";

// Список entrypoint'ов, которые попадают в сборку. Всё, чего здесь нет,
// WXT пропускает (файлов вне списка в сборке нет).
const INCLUDED_ENTRYPOINTS = [
  "background",
  "popup",
  "sendPrintNum", // печать ячеек (основная функция)
  "hotkeyToggle", // Ctrl+O — включить/выключить печать
  "debtorWatch",  // проверка должников по clientId при выдаче
  "labelCopy",    // подхват ШК из кнопок «копировать»
  "pageHook",     // MAIN-world перехват ответов Ozon (инъекция из background)
];

// See https://wxt.dev/api/config.html
export default defineConfig({
  filterEntrypoints: INCLUDED_ENTRYPOINTS,

  manifest: {
    permissions: ["storage", "scripting"],
    action: {},
    name: "PrintNum — печать этикеток для ПВЗ",
    short_name: "PrintNum",
    // ≤132 символов — требование магазинов расширений.
    description:
      "Печать ячеек и этикеток с QR для ПВЗ Ozon: автопечать, проверка должников. Нужна локальная служба PrintNum (Windows).",
    host_permissions: [
      // Локальная служба печати. Порт 5000 матчится любым портом (MV3 не
      // умеет порт в host_permissions), но только петлевой адрес.
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