import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    permissions: ["storage"],
    action: {},
    name: "PrintNum - Печать Ячеек (Ozon)",
    description:
      "Полезные инструменты для turbo-pvz.ozon.ru: печать ячеек, автоскрипты, удобная автоматизация по QR-кодам и другое.",
    host_permissions: ["http://localhost/*", "http://127.0.0.1/*"],
  },

  srcDir: "src",

  // Папка сборки: extension/output/<браузер> (например, output/chrome-mv3).
  outDir: "output",

  vite: () => ({
    // Popup написан на Preact (лёгкая замена React): JSX компилируется
    // в вызовы preact/jsx-runtime.
    esbuild: {
      jsx: "automatic",
      jsxImportSource: "preact",
      target: "es2022",
    },
    build: {
      target: "es2022",
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