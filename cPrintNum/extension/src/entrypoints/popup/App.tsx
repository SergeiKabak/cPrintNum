import { useEffect } from "preact/hooks";

import StatusPrinting from "./statusPrinting";
import PrintSettingsPanel from "./PrintSettingsPanel";
import AutoPrintPanel from "./AutoPrintPanel";
import BarcodeGenerator from "./BarcodeGenerator";
import DebtorsPanel from "./DebtorsPanel";

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

      <AutoPrintPanel />

      <DebtorsPanel />

      <BarcodeGenerator />
    </div>
  );
}

export default App;
