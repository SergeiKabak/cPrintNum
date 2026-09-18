import { Bell, BellOff } from "lucide-preact";
import { SettingSection } from "../SettingSection";

export default function Notification() {
  const [notification, setNotification] = useStorageState("notification", []);
  const [offNotification, setOffNotification] = useStorageState(
    "offNotification",
    [],
  );

  return (
    <SettingSection
      value="notification-settings"
      title="Видимость уведомлений"
      items={notification}
      hiddenItems={offNotification}
      onItemToggle={setOffNotification}
      VisibleIcon={Bell}
      HiddenIcon={BellOff}
    />
  );
}