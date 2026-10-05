/**
 * Генератор штрихкодов Code128 в popup.
 *
 * Возможности:
 * - ручной ввод текста ШК;
 * - настройка параметров: высота полосок, ширина модуля, показ текста (HRI);
 * - предпросмотр (SVG);
 * - печать из браузера (окно с ШК + window.print());
 * - печать через приложение PrintNum (Win32 GDI).
 *
 * Настройки сохраняются в chrome.storage.local.
 */

declare const chrome: any;

import { useState, useEffect } from "preact/hooks";
import { Printer, Barcode, MonitorUp, Settings2 } from "lucide-preact";
import { barcode128ToSvg } from "@/utils/code128";
import { Button } from "@/components/preact/button";
import { sendServer } from "@/utils/api";
import { useStorageValue } from "@/hooks/useStorageValue";
import { isNativeAvailable, sendNative } from "@/utils/nativeMessaging";
import { LAST_LABEL_KEY } from "@/entrypoints/labelCopy.content";

/** Значения по умолчанию. */
const DEFAULT_TEXT = "";
const DEFAULT_MODULE_MM = 0.25;
const DEFAULT_HEIGHT_MM = 17;

type Status =
  | { kind: "idle" }
  | { kind: "ok"; msg: string }
  | { kind: "err"; msg: string };

export default function BarcodeGenerator() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [moduleMm, setModuleMm] = useStorageValue<number>(
    "barcodeModuleMm",
    DEFAULT_MODULE_MM,
  );
  const [heightMm, setHeightMm] = useStorageValue<number>(
    "barcodeHeightMm",
    DEFAULT_HEIGHT_MM,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Подхват штрихкода из кнопки «копировать» на странице Ozon.
  //
  // Значение кладёт content-script (labelCopy.content.ts) в
  // chrome.storage.local — окно расширения в момент клика обычно закрыто,
  // поэтому передача идёт через хранилище, а не напрямую.
  //
  // Читаем существующее значение при открытии…
  useEffect(() => {
    chrome.storage.local.get([LAST_LABEL_KEY], (result: any) => {
      const value = result?.[LAST_LABEL_KEY];
      // Подставляем, только если пользователь ничего не вводил сам.
      if (typeof value === "string" && value) {
        setText((prev) => (prev ? prev : value));
      }
    });

    // …и следим за новыми копированиями, пока окно открыто.
    const onChanged = (changes: any, area: string) => {
      if (area !== "local") return;
      const value = changes?.[LAST_LABEL_KEY]?.newValue;
      if (typeof value === "string" && value) {
        setText(value);
        setStatus({ kind: "idle" });
      }
    };

    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Проверяем валидность и получаем SVG (или ошибку).
  let svg: string | null = null;
  let error: string | null = null;
  if (text.trim()) {
    try {
      svg = barcode128ToSvg(text.trim(), moduleMm, heightMm);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Печать из браузера: окно с ШК + window.print(). */
  const printInBrowser = () => {
    if (!svg) return;
    const w = window.open("", "_blank", "width=200,height=200");
    if (!w) {
      setStatus({ kind: "err", msg: "Браузер заблокировал окно печати" });
      return;
    }
    w.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Штрихкод</title>` +
        `<style>@page{margin:5mm}body{margin:0;display:flex;justify-content:center}svg{max-width:100%}</style>` +
        `</head><body>${svg}<script>window.onload=()=>{window.print();}` +
        `window.onafterprint=()=>window.close();<\/script></body></html>`,
    );
    w.document.close();
    setStatus({ kind: "ok", msg: "Открыто окно печати браузера" });
  };

  /** Печать через приложение PrintNum.
   * Сначала пробует native messaging (без порта), затем HTTP. */
  const printViaPrintNum = async () => {
    if (!svg) return;
    setStatus({ kind: "idle" });

    // 1. Native messaging (если зарегистрирован host).
    if (isNativeAvailable()) {
      try {
        const r = await sendNative<{ status: string; reason?: string; error?: string }>({
          command: "print-barcode",
          text: text.trim(),
          heightMm,
          moduleMm,
        });
        if (r?.status === "ok") {
          setStatus({ kind: "ok", msg: "Отправлено в PrintNum (native)" });
          return;
        }
        if (r?.status === "skipped") {
          setStatus({ kind: "err", msg: `Пропущено: ${r.reason}` });
          return;
        }
        // При ошибке/неизвестном статусе — пробуем HTTP ниже.
      } catch {
        // Host не зарегистрирован — переходим на HTTP.
      }
    }

    // 2. HTTP (если приложение запущено с сервером).
    try {
      const res = await sendServer.post("print-barcode", {
        text: text.trim(),
        heightMm,
        moduleMm,
      });
      setStatus(
        res.ok
          ? { kind: "ok", msg: "Отправлено в PrintNum" }
          : { kind: "err", msg: `PrintNum вернул ошибку ${res.status}` },
      );
    } catch {
      setStatus({
        kind: "err",
        msg: "PrintNum недоступен. Запущено ли приложение?",
      });
    }
  };

  return (
    <div className="w-full rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden">
      {/* Шапка */}
      <div className="px-3 py-2.5 bg-muted/30 border-b border-border flex items-center gap-2 select-none">
        <Barcode class="h-4 w-4 text-emerald-600 dark:text-emerald-500 shrink-0" />
        <span className="text-sm font-bold tracking-tight flex-1 truncate leading-none">
          Штрихкод Code128
        </span>
        <button
          type="button"
          title="Настройки штрихкода"
          onClick={() => setShowSettings((v) => !v)}
          className={`shrink-0 flex items-center justify-center h-6 w-6 rounded-md transition-colors ${
            showSettings
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-muted/60"
          }`}
        >
          <Settings2 class="h-4 w-4" />
        </button>
      </div>

      {/* Раздел ввода (отступ 16px вокруг: p-4) */}
      <div className="p-4 flex flex-col gap-3">
        {/* Настройки (по кнопке) */}
        {showSettings && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-4">
            <NumberField
              label="Высота полосок (мм)"
              value={heightMm}
              min={3}
              max={50}
              step={1}
              onChange={setHeightMm}
            />
            <NumberField
              label="Ширина модуля (мм)"
              value={moduleMm}
              min={0.1}
              max={1}
              step={0.05}
              onChange={setModuleMm}
            />
          </div>
        )}

        {/* Ввод текста */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Текст штрихкода
          </span>
          <input
            type="text"
            value={text}
            onInput={(e) => {
              setText((e.target as HTMLInputElement).value);
              setStatus({ kind: "idle" });
            }}
            placeholder="например, ii18725308927"
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        {/* Предпросмотр */}
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-white p-2 min-h-16 overflow-x-auto">
          {svg ? (
            <div
              className="[&>svg]:h-auto [&>svg]:max-w-full [&>svg]:w-auto"
              // svg сгенерирован нами, вставка безопасна
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {error ? `Ошибка: ${error}` : "Введите текст"}
            </span>
          )}
        </div>

        {/* Кнопки печати */}
        <div className="flex flex-col gap-1.5">
          <Button
            variant="default"
            size="sm"
            className="w-full"
            disabled={!svg}
            onClick={printViaPrintNum}
          >
            <Printer class="h-4 w-4 shrink-0" />
            <span>Печать через PrintNum</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={!svg}
            onClick={printInBrowser}
          >
            <MonitorUp class="h-4 w-4 shrink-0" />
            <span>Печать из браузера</span>
          </Button>
        </div>

        {/* Статус */}
        {status.kind !== "idle" && (
          <span
            className={`text-[11px] ${
              status.kind === "ok"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {status.msg}
          </span>
        )}
      </div>
    </div>
  );
}

/** Числовое поле с подписью. */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onInput={(e) => {
          const raw = parseFloat((e.target as HTMLInputElement).value);
          if (!Number.isNaN(raw)) {
            onChange(Math.min(max, Math.max(min, raw)));
          }
        }}
        className="h-7 w-20 rounded-md border border-border bg-background px-2 text-xs text-right outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}