/**
 * Превью и печать комбинированной QR-этикетки PrintNum.
 *
 * C-служба (`POST /print-barcode`) печатает:
 *   [QR]  ii1938286  [QR]
 *           8529
 *
 * Здесь тот же макет строится в SVG: QR слева/справа, значение по центру,
 * последние 4 символа — жирным на новой строке. Превью обновляется по мере
 * ввода и учитывает размер этикетки из `GET /config` (`paper`).
 *
 * Печать:
 * - «Печать через PrintNum» — HTTP POST /print-barcode (C-служба);
 * - «Печать из браузера» — печатает тот же SVG через `window.print()`.
 */

declare const chrome: any;

import { useEffect, useMemo, useState } from "preact/hooks";
import { Barcode, MonitorUp, Printer } from "lucide-preact";
import { Button } from "@/components/preact/button";
import { getSettings, sendServer } from "@/utils/api";
import { LAST_LABEL_KEY } from "@/entrypoints/labelCopy.content";
import {
  buildQrLabelSvg,
  createCanvasTextMeasurer,
  parsePaperSize,
} from "@/utils/qrLabel";

/** Пример, который показываем, пока поле пустое. */
const SAMPLE_TEXT = "ii19382868529";

type Status =
  | { kind: "idle" }
  | { kind: "ok"; msg: string }
  | { kind: "err"; msg: string };

export default function BarcodeGenerator() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Размер этикетки берём из C-службы; без неё — 43×25 мм.
  const [paper, setPaper] = useState(() => parsePaperSize(undefined));

  useEffect(() => {
    let alive = true;

    getSettings().then((settings) => {
      if (alive && settings) setPaper(parsePaperSize(settings.paper));
    });

    return () => {
      alive = false;
    };
  }, []);

  // Точная подгонка текста по ширине (canvas), как GDI в C-службе.
  const measureText = useMemo(() => createCanvasTextMeasurer(), []);

  // Подхват штрихкода из кнопки «копировать» на странице Ozon.
  //
  // Значение кладёт content-script (labelCopy.content.ts) в
  // chrome.storage.local — окно расширения в момент клика обычно закрыто,
  // поэтому передача идёт через хранилище, а не напрямую.
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

  const trimmed = text.trim();
  const isSample = !trimmed;
  const previewText = trimmed || SAMPLE_TEXT;

  // Строим SVG (или показываем ошибку для не-ASCII/пустого значения).
  let svg: string | null = null;
  let error: string | null = null;

  try {
    svg = buildQrLabelSvg(previewText, {
      widthMm: paper.widthMm,
      heightMm: paper.heightMm,
      measureText,
    }).svg;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const canPrint = !!svg && !error && !isSample;

  /** Печать из браузера: окно с тем же SVG + window.print(). */
  const printInBrowser = () => {
    if (!svg || !canPrint) return;

    const w = window.open("", "_blank", "width=480,height=320");
    if (!w) {
      setStatus({ kind: "err", msg: "Браузер заблокировал окно печати" });
      return;
    }

    w.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>QR-этикетка</title>` +
        `<style>@page{size:${paper.widthMm}mm ${paper.heightMm}mm;margin:0}` +
        `html,body{margin:0;padding:0;background:#fff}` +
        `svg{display:block;width:${paper.widthMm}mm;height:${paper.heightMm}mm}</style>` +
        `</head><body>${svg}<script>window.onload=()=>{window.print();}` +
        `window.onafterprint=()=>window.close();<\/script></body></html>`,
    );
    w.document.close();
    setStatus({ kind: "ok", msg: "Открыто окно печати браузера" });
  };

  /** Печать через приложение PrintNum (HTTP, C-служба на 127.0.0.1:5000). */
  const printViaPrintNum = async () => {
    if (!svg || !canPrint) return;
    setStatus({ kind: "idle" });

    try {
      const res = await sendServer.post("print-barcode", { text: trimmed });
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
          QR-этикетка ii
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {paper.widthMm}×{paper.heightMm} мм
        </span>
      </div>

      <div className="p-4 flex flex-col gap-3">
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

        {/* Превью */}
        <div className="relative flex items-center justify-center rounded-lg border border-dashed border-border bg-white p-2 min-h-16 overflow-hidden">
          {svg ? (
            <div
              className="w-full [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
              // SVG сгенерирован нами по фиксированной геометрии — вставка безопасна
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {error ? `Ошибка: ${error}` : "Введите текст"}
            </span>
          )}

          {isSample && svg && (
            <span className="absolute right-2 top-2 rounded bg-black/5 px-1.5 py-0.5 text-[9px] text-muted-foreground">
              пример
            </span>
          )}
        </div>

        <span className="text-[10px] text-muted-foreground">
          QR слева и справа, последние 4 цифры — жирным. Печать выполняется
          приложением PrintNum.
        </span>

        {/* Кнопки печати */}
        <div className="flex flex-col gap-1.5">
          <Button
            variant="default"
            size="sm"
            className="w-full"
            disabled={!canPrint}
            onClick={printViaPrintNum}
          >
            <Printer class="h-4 w-4 shrink-0" />
            <span>Печать через PrintNum</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={!canPrint}
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
