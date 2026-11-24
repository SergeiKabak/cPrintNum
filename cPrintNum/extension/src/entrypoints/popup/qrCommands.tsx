import { SettingSection } from "./SettingSection";
import { Ban, QrCode } from "lucide-preact";
import { Accordion } from "@/components/preact/accordion";
import { Printer } from "lucide-preact";
import { UniversalLinkButton } from "@/components/opeTabURL";

export default function QrCommands() {
  const [qrCodes, setQrCodes] = useStorageState("qrCodes", []);
  const [offQrCodes, setOffQrId] = useStorageState("offQrCodes", []);

  return (
    <div className="bg-background flex items-center gap-1 w-full">
      <Accordion
        type="single"
        collapsible
        className="border rounded-xl bg-background overflow-hidden flex-1 min-w-0"
      >
        <SettingSection
          value="qr-settings"
          title="Обработчики QR-кодов"
          items={qrCodes}
          hiddenItems={offQrCodes}
          onItemToggle={setOffQrId}
          VisibleIcon={QrCode}
          HiddenIcon={Ban}
        />
      </Accordion>
      <UniversalLinkButton
        fileUrl="/qrCodes.pdf"
        icon={Printer}
        variant="ghost"
      />
    </div>
  );
}