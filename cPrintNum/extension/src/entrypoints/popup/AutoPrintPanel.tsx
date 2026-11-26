/**
 * Панель автопечати в popup.
 *
 * Настройки хранятся в `chrome.storage.local` (ключ `autoPrint`).
 * Background читает их на каждое событие, поэтому переключатель
 * применяется без перезагрузки страницы Ozon.
 */

declare const chrome: any;

import { useEffect, useState } from "preact/hooks";
import { CircleAlert, CircleCheck, ScanLine } from "lucide-preact";
import { useStorageValue } from "@/hooks/useStorageValue";
import { getSettings } from "@/utils/api";
import {
  AUTO_PRINT_KEY,
  DEFAULT_AUTO_PRINT,
  LAST_AUTO_PRINT_EVENT_KEY,
  SHELF_FEATURE,
  normalizeAutoPrint,
  type AutoPrintEvent,
  type AutoPrintMode,
  type AutoPrintSettings,
} from "@/utils/autoPrintSettings";

const MODES: { value: AutoPrintMode; label: string; hint: string }[] = [
  {
    value: "xhr",
    label: "Перехват ответов Ozon (рекомендуется)",
    hint: "Ячейки и полки из ответов Ozon, включая упаковку.",
  },
  {
    value: "dom",
    label: "По DOM (как раньше)",
    hint: "Печать при изменении списка ячеек на странице приёмки.",
  },
  {
    value: "both",
    label: "Оба (для отладки)",
    hint: "DOM + перехват. Дубли гасятся окном overlapGuardMs.",
  },
  { value: "off", label: "Выключено", hint: "Автопечать не выполняется." },
];

export default function AutoPrintPanel() {
  const [stored, setStored] = useStorageValue<AutoPrintSettings>(
    AUTO_PRINT_KEY,
    DEFAULT_AUTO_PRINT,
  );
  const settings = normalizeAutoPrint(stored);

  const [lastEvent, setLastEvent] = useState<AutoPrintEvent | null>(null);
  const [shelfSupported, setShelfSupported] = useState<boolean | null>(null);

  const patch = (changes: Partial<AutoPrintSettings>) => {
    setStored((prev) => normalizeAutoPrint({ ...normalizeAutoPrint(prev), ...changes }));
  };

  // Последнее событие автопечати — для диагностики.
  useEffect(() => {
    chrome.storage.local.get([LAST_AUTO_PRINT_EVENT_KEY], (result: any) => {
      setLastEvent(result?.[LAST_AUTO_PRINT_EVENT_KEY] ?? null);
    });

    const onChanged = (changes: any, area: string) => {
      if (area !== "local" || !changes?.[LAST_AUTO_PRINT_EVENT_KEY]) return;
      setLastEvent(changes[LAST_AUTO_PRINT_EVENT_KEY].newValue ?? null);
    };

    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Поддерживает ли установленный PrintNum полки (-88).
  useEffect(() => {
    let alive = true;

    getSettings().then((backend) => {
      if (!alive) return;
      if (!backend) {
        setShelfSupported(null);
        return;
      }
      setShelfSupported(
        Array.isArray(backend.features) && backend.features.includes(SHELF_FEATURE),
      );
    });

    return () => {
      alive = false;
    };
  }, []);

  const mode = MODES.find((m) => m.value === settings.mode) ?? MODES[1]!;

  return (
    <div className="w-full rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden">
      {/* Шапка */}
      <div className="px-3 py-2.5 bg-muted/30 border-b border-border flex items-center gap-2 select-none">
        <ScanLine class="h-4 w-4 text-sky-600 dark:text-sky-500 shrink-0" />
        <span className="text-sm font-bold tracking-tight flex-1 truncate leading-none">
          Автопечать при размещении
        </span>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {/* Режим */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Источник событий</span>
          <select
            value={settings.mode}
            onChange={(e) =>
              patch({ mode: (e.target as HTMLSelectElement).value as AutoPrintMode })
            }
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="text-[10px] text-muted-foreground">{mode.hint}</span>
        </label>

        {/* Что печатать */}
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 p-3">
          <CheckboxRow
            label="Полки (-88)"
            checked={settings.shelf}
            onChange={(checked) => patch({ shelf: checked })}
          />
          <CheckboxRow
            label="При упаковке (переупаковка)"
            checked={settings.packing}
            onChange={(checked) => patch({ packing: checked })}
          />
          <CheckboxRow
            label="По резолверу приёмки (GetResolveEntity)"
            checked={settings.resolve}
            onChange={(checked) => patch({ resolve: checked })}
          />
        </div>

        {/* Дедупликация */}
        <label className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            Не повторять ячейку, мс
          </span>
          <input
            type="number"
            value={settings.dedupeMs}
            min={0}
            max={60000}
            step={500}
            onInput={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v)) patch({ dedupeMs: v });
            }}
            className="h-7 w-20 rounded-md border border-border bg-background px-2 text-xs text-right outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        {/* Предупреждение о старом backend'е */}
        {shelfSupported === false && (
          <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
            <CircleAlert class="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <span className="text-[10px] leading-snug text-amber-700 dark:text-amber-300">
              Установленный PrintNum не поддерживает полки. Обновите приложение до версии с{" "}
              <code>features:["shelf-dash"]</code>.
            </span>
          </div>
        )}

        {/* Последнее событие */}
        {lastEvent && (
          <div className="flex items-start gap-1.5">
            {lastEvent.ok ? (
              <CircleCheck class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <CircleAlert class="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            )}
            <span
              className={`text-[10px] leading-snug ${
                lastEvent.ok
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              {lastEvent.ok
                ? `Напечатано: ${lastEvent.text}` +
                  (lastEvent.qr ? ` + QR ${lastEvent.qr}` : " — QR нет: ШК не найден")
                : `Ошибка (${lastEvent.text}): ${lastEvent.error ?? lastEvent.status ?? "—"}`}
              <span className="text-muted-foreground">
                {" "}
                · {new Date(lastEvent.at).toLocaleTimeString()}
              </span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function CheckboxRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        className="h-3.5 w-3.5 rounded border-border accent-sky-600"
      />
      <span className="text-[11px] text-foreground">{label}</span>
    </label>
  );
}
