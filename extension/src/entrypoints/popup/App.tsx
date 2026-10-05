import { useEffect } from "preact/hooks";

import StatusPrinting from "./statusPrinting";
import PrintSettingsPanel from "./PrintSettingsPanel";
import BarcodeGenerator from "./BarcodeGenerator";

function App() {
  useEffect(() => {
    const body = document.documentElement;
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    body.classList.toggle("dark", isDark);
  }, []);

  return (
    <div className="flex flex-col w-full p-3 items-stretch gap-3">
      <StatusPrinting />

      <PrintSettingsPanel />

      <BarcodeGenerator />
    </div>
  );
}

export default App;