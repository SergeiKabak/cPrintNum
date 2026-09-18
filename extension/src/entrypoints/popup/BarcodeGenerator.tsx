/**
 * Генератор штрихкодов Code128 в popup.
 *
 * Возможности:
 * - ручной ввод текста ШК;
 * - предпросмотр (SVG);
 * - печать из браузера (открывает окно с ШК и вызывает window.print());
 * - печать через приложение PrintNum на реальный принтер (Win32 GDI).
 *
 * Параметры штрихкода по умолчанию: высота полосок 10 мм, модуль 0.25 мм.
 */

import { useState } from "preact/hooks";
import { Printer, Barcode, MonitorUp } from "lucide-preact";
import { barcode128ToSvg } from "@/utils/code128";
import { Button } from "@/components/preact/button";
import { sendServer } from "@/utils/api";

/** Параметры печати ШК (мм). */
const MODULE_MM = 0.25;
const HEIGHT_MM = 10;

type Status = { kind: "idle" } | { kind: "ok"; msg: string } | { kind: "err"; msg: string };

export default function BarcodeGenerator() {
  const [text, setText] = useState("ii18725308927");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Проверяем валидность и получаем SVG (или null при ошибке).
  let svg: string | null = null;
  let error: string | null = null;
  if (text.trim()) {
    try {
      svg = barcode128ToSvg(text.trim(), MODULE_MM, HEIGHT_MM);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Печать из браузера: открывает окно с ШК и вызывает печать. */
  const printInBrowser = () => {
    if (!svg) return;
    const w = window.open("", "_blank", "width=600,height=400");
    if (!w) {
      setStatus({ kind: "err", msg: "Браузер заблокировал окно печати" });
      return;
    }
    w.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Штрихкод</title>` +
        `<style>@page{margin:5mm}body{margin:0;display:flex;justify-content:center}svg{max-width:100%}</style>` +
        `</head><body>${svg}<script>window.onload=()=>{window.print();}` +
        // закрываем окно после печати (в некоторых браузерах событие не сработает)
        `window.onafterprint=()=>window.close();<\/script></body></html>`,
    );
    w.document.close();
    setStatus({ kind: "ok", msg: "Открыто окно печати браузера" });
  };

  /** Печать через приложение PrintNum (Win32 GDI). */
  const printViaPrintNum = async () => {
    if (!svg) return;
    setStatus({ kind: "idle" });
    try {
      const res = await sendServer.post("print-barcode", {
        text: text.trim(),
        heightMm: HEIGHT_MM,
        moduleMm: MODULE_MM,
      });
      if (res.ok) {
        setStatus({ kind: "ok", msg: "Отправлено в PrintNum" });
      } else {
        setStatus({
          kind: "err",
          msg: `PrintNum вернул ошибку ${res.status}`,
        });
      }
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
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center gap-2 select-none">
        <Barcode class="h-4 w-4 text-emerald-600 dark:text-emerald-500 shrink-0" />
        <span className="text-sm font-bold tracking-tight">Штрихкод Code128</span>
      </div>

      <div className="p-3 flex flex-col gap-3">
        {/* Ввод */}
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
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-white p-2 min-h-16 overflow-hidden">
          {svg ? (
            <div
              className="max-w-full overflow-hidden"
              // svg сгенерирован нами, вставка безопасна
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {error ? `Ошибка: ${error}` : "Введите текст"}
            </span>
          )}
        </div>

        {/* Кнопки */}
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