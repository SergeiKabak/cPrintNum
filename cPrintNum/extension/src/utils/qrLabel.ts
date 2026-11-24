/**
 * Превью комбинированной этикетки `/print-barcode`:
 * QR слева + значение по центру + QR справа.
 *
 * Геометрия повторяет C-службу (`draw_qr_label_core`):
 * - QR кодирует всё значение (`ii19382868529`), ECC Medium, тихая зона 4 модуля;
 * - последние 4 символа печатаются жирным на новой строке;
 * - размеры модуля/шрифтов подбираются под размер этикетки.
 *
 * Результат — SVG-строка, которую можно показать в popup и напечатать
 * из браузера. Печать через PrintNum всё равно выполняет C-служба.
 */

import qrcode from "qrcode-generator";

export type TextMeasurer = (
  text: string,
  fontSizePx: number,
  bold: boolean,
) => number;

export type QrLabelOptions = {
  /** Ширина этикетки в мм (из `paper`, по умолчанию 43). */
  widthMm?: number;
  /** Высота этикетки в мм (из `paper`, по умолчанию 25). */
  heightMm?: number;
  /** DPI для расчёта пикселей (preview — 203, как у термопринтера). */
  dpi?: number;
  /** Точное измерение текста (canvas); без него — приблизительная оценка. */
  measureText?: TextMeasurer;
};

export type QrLabel = {
  svg: string;
  widthPx: number;
  heightPx: number;
  widthMm: number;
  heightMm: number;
};

const DEFAULT_WIDTH_MM = 43;
const DEFAULT_HEIGHT_MM = 25;
const DEFAULT_DPI = 203;

function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / 25.4) * dpi);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Приблизительная ширина текста Arial, если canvas недоступен. */
function approxTextWidth(text: string, size: number, bold: boolean): number {
  return text.length * size * (bold ? 0.62 : 0.58);
}

/** Canvas-измеритель для точной подгонки текста, как в GDI. */
export function createCanvasTextMeasurer(): TextMeasurer | undefined {
  if (typeof document === "undefined") return undefined;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;

  return (text, size, bold) => {
    ctx.font = `${bold ? "700" : "400"} ${size}px Arial, Helvetica, sans-serif`;
    return ctx.measureText(text).width;
  };
}

/**
 * Строит SVG комбинированной этикетки.
 *
 * Бросает ошибку, если значение пустое или содержит не-ASCII символы:
 * C-служба (`draw_qr_label_core`) тоже принимает только ASCII 32..127.
 */
export function buildQrLabelSvg(
  input: string,
  options: QrLabelOptions = {},
): QrLabel {
  const text = input.trim();
  if (!text) throw new Error("Пустая строка: нечего кодировать");

  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 127) {
      throw new Error(
        `Недопустимый символ '${ch}': QR-этикетка поддерживает только ASCII 32..127`,
      );
    }
  }

  const widthMm = options.widthMm ?? DEFAULT_WIDTH_MM;
  const heightMm = options.heightMm ?? DEFAULT_HEIGHT_MM;
  const dpi = options.dpi ?? DEFAULT_DPI;
  const measure = options.measureText ?? approxTextWidth;

  // QR: авто-версия, ECC Medium — как PNQR_DEMO_ECC в C-службе.
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();

  const count = qr.getModuleCount();
  const widthPx = mmToPx(widthMm, dpi);
  const heightPx = mmToPx(heightMm, dpi);

  // Константы C-службы: 0.5 мм поля, 0.125 мм зазор,
  // 4 мм обычный текст, 6 мм жирный суффикс.
  const marginX = Math.max(1, mmToPx(0.5, dpi));
  const gapBetween = Math.max(0, mmToPx(0.125, dpi));
  let prefixSize = Math.max(8, mmToPx(4, dpi));
  let suffixSize = Math.max(10, mmToPx(6, dpi));

  const qrModules = count + 8; // + тихая зона 4 модуля с каждой стороны
  const minTextW = Math.max(1, Math.round((widthPx * 88) / 344));
  const availW = widthPx - 2 * marginX - minTextW;
  const availH = heightPx - Math.max(1, Math.round((4 * dpi) / 203));

  const byW = Math.floor(availW / (2 * qrModules));
  const byH = Math.floor(availH / qrModules);
  let modulePx = Math.min(byW, byH);
  if (modulePx < 1) modulePx = 1;

  const qrSide = qrModules * modulePx;
  const leftX = marginX;
  const rightX = widthPx - marginX - qrSide;
  const qrY = Math.floor((heightPx - qrSide) / 2);

  // Всё, кроме последних 4 символов — обычным; последние 4 — жирным.
  const split = text.length > 4 ? text.length - 4 : 0;
  const prefix = text.slice(0, split);
  const suffix = text.slice(split);

  const quietPx = 4 * modulePx;
  const textGap = 2 * modulePx + gapBetween;
  const centerLeft = leftX + quietPx + count * modulePx + textGap;
  const centerRight = rightX + quietPx - textGap;
  const centerW = Math.max(1, centerRight - centerLeft);
  const cx = (centerLeft + centerRight) / 2;

  // Авто-сжатие текста под центральную область (как в C-службе).
  while (prefix && prefixSize > 8 && measure(prefix, prefixSize, false) > centerW) {
    prefixSize--;
  }
  while (suffixSize > 10 && measure(suffix, suffixSize, true) > centerW) {
    suffixSize--;
  }

  const lineGap = Math.max(1, Math.round((2 * dpi) / 203));
  const prefixHeight = Math.round(prefixSize * 1.15);
  const suffixHeight = Math.round(suffixSize * 1.15);
  const totalH = prefixHeight + lineGap + suffixHeight;
  const y0 = Math.floor((heightPx - totalH) / 2);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" ` +
      `viewBox="0 0 ${widthPx} ${heightPx}" shape-rendering="crispEdges">`,
  );
  parts.push(`<rect width="${widthPx}" height="${heightPx}" fill="#ffffff"/>`);

  // Два одинаковых QR: слева и справа.
  for (const qrX of [leftX, rightX]) {
    parts.push(
      `<rect x="${qrX}" y="${qrY}" width="${qrSide}" height="${qrSide}" fill="#ffffff"/>`,
    );

    const rects: string[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (!qr.isDark(row, col)) continue;
        const x = qrX + (col + 4) * modulePx;
        const y = qrY + (row + 4) * modulePx;
        rects.push(`<rect x="${x}" y="${y}" width="${modulePx}" height="${modulePx}"/>`);
      }
    }
    parts.push(`<g fill="#000000">${rects.join("")}</g>`);
  }

  // Текст: верхняя строка — обычная, нижняя (последние 4) — жирная.
  const textAttrs =
    `text-anchor="middle" font-family="Arial, Helvetica, sans-serif" fill="#000000" ` +
    `dominant-baseline="text-before-edge"`;

  if (prefix) {
    parts.push(
      `<text x="${cx}" y="${y0}" font-size="${prefixSize}" font-weight="400" ${textAttrs}>` +
        `${escapeXml(prefix)}</text>`,
    );
  }

  parts.push(
    `<text x="${cx}" y="${y0 + prefixHeight + lineGap}" font-size="${suffixSize}" ` +
      `font-weight="700" ${textAttrs}>${escapeXml(suffix)}</text>`,
  );

  parts.push("</svg>");

  return {
    svg: parts.join(""),
    widthPx,
    heightPx,
    widthMm,
    heightMm,
  };
}

/** `"43*25"` → `{ widthMm: 43, heightMm: 25 }`. */
export function parsePaperSize(paper: string | undefined): {
  widthMm: number;
  heightMm: number;
} {
  const m = /^\s*(\d+)\s*\*\s*(\d+)\s*$/.exec(paper ?? "");
  if (!m) return { widthMm: DEFAULT_WIDTH_MM, heightMm: DEFAULT_HEIGHT_MM };

  return {
    widthMm: Number(m[1]),
    heightMm: Number(m[2]),
  };
}
