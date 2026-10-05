/**
 * Настройки печати прямо из окна расширения.
 *
 * Раньше настройки задавались только в десктопном приложении: расширение
 * умело лишь отправлять номера. Теперь оно читает и меняет те же поля,
 * что и `config.json` (`GET /config`, `POST /config`).
 *
 * Приложение подхватывает изменения на лету — перезапускать его не нужно.
 * То же верно и в обратную сторону: если настройку поменяли в приложении,
 * при следующем открытии окна расширения здесь будут актуальные значения.
 *
 * Если приложение недоступно, блок показывает подсказку и не даёт
 * редактировать поля (менять нечего — сохранять некуда).
 */

import { useCallback, useEffect, useState } from "preact/hooks";
import {
  getPapers,
  getPrinters,
  getSettings,
  saveSettings,
  type PrintSettings,
} from "@/utils/api";
import { Button } from "@/components/preact/button";

/**
 * Список размеров этикеток, если приложение недоступно.
 *
 * В обычной работе список приходит из `GET /papers` — он живёт в
 * `config.json`, поэтому добавленный в приложении размер сразу
 * появляется в расширении. Значения ниже нужны только чтобы показать
 * хоть что-то, когда связь с приложением отсутствует.
 */
const FALLBACK_PAPERS = ["30*20"];

export default function PrintSettingsPanel() {
  const [settings, setSettings] = useState<PrintSettings | null>(null);
  const [printers, setPrinters] = useState<string[]>([]);
  const [papers, setPapers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [s, p, pp] = await Promise.all([
      getSettings(),
      getPrinters(),
      getPapers(),
    ]);

    if (!s) {
      setSettings(null);
      setError("Приложение PrintNum не запущено");
      return;
    }

    setError(null);
    setSettings(s);
    setPrinters(p);
    setPapers(pp.length ? pp : FALLBACK_PAPERS);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Отправляет частичное изменение и обновляет состояние из ответа. */
  const patch = useCallback(
    async (changes: Partial<PrintSettings>) => {
      // Оптимистично применяем локально — UI отзывается сразу.
      setSettings((prev) => (prev ? { ...prev, ...changes } : prev));
      setSaving(true);

      const result = await saveSettings(changes);
      setSaving(false);

      if (result.ok) {
        // Сервер вернул полный конфиг — берём его как источник правды.
        setSettings(result.settings);
        setError(null);
        setSavedAt(Date.now());
      } else {
        setError(result.error);
        // Откатываемся: перечитываем реальное состояние.
        load();
      }
    },
    [load],
  );

  if (!settings) {
    return (
      <div className="w-full rounded-xl border bg-card text-card-foreground shadow-sm p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold tracking-tight">
            Настройки печати
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {error || "Загрузка настроек..."}
        </p>
      </div>
    );
  }

  return (
    <div className="w-full rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden">
      {/* Заголовок */}
      <div className="px-3 py-2.5 bg-muted/30 border-b border-border flex items-center gap-2">
        <span className="text-sm font-bold tracking-tight flex-1 truncate leading-none">
          Настройки печати
        </span>
        {saving ? (
          <span className="text-[10px] text-muted-foreground">сохранение…</span>
        ) : savedAt ? (
          <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
            сохранено
          </span>
        ) : null}
      </div>

      <div className="p-3 flex flex-col gap-3">
        {/* Печать вкл/выкл */}
        <button
          type="button"
          onClick={() => patch({ running: !settings.running })}
          className={`flex items-center justify-between w-full rounded-lg border px-3 py-2 transition-colors ${
            settings.running
              ? "bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/15"
              : "bg-red-500/10 border-red-500/30 hover:bg-red-500/15"
          }`}
        >
          <span
            className={`text-sm font-bold tracking-wide ${
              settings.running
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {settings.running ? "Печать включена" : "Печать выключена"}
          </span>
          <span className="text-[10px] text-muted-foreground">
            нажмите, чтобы {settings.running ? "выключить" : "включить"}
          </span>
        </button>

        {/* Принтер */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Принтер
          </span>
          <select
            value={settings.printer}
            onChange={(e) => patch({ printer: (e.target as HTMLSelectElement).value })}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">— не выбран —</option>
            {/* Сохранённый принтер, отсутствующий в списке.
                На macOS список всегда пуст (заглушка — печати нет),
                поэтому пометка «не найден» только запутывала бы:
                показываем имя принтера как есть. */}
            {settings.printer && !printers.includes(settings.printer) && (
              <option value={settings.printer}>
                {printers.length
                  ? `${settings.printer} (не найден)`
                  : settings.printer}
              </option>
            )}
            {printers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        {/* Размер этикетки */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Этикетка (мм)
          </span>
          <select
            value={settings.paper}
            onChange={(e) => patch({ paper: (e.target as HTMLSelectElement).value })}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          >
            {/* Размер, сохранённый в конфиге, но отсутствующий в списке
                (например, его убрали из papers) — отдельным пунктом,
                чтобы текущий выбор не «слетал». */}
            {settings.paper && !papers.includes(settings.paper) && (
              <option value={settings.paper}>{settings.paper} (нет в списке)</option>
            )}
            {papers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        {/* Флаги оформления */}
        <div className="flex flex-col gap-2 pt-1">
          <Checkbox
            label="Показывать ID"
            checked={settings.idNum}
            onChange={(v) => patch({ idNum: v })}
          />
          <Checkbox
            label="Подчёркивание"
            checked={settings.endLine}
            onChange={(v) => patch({ endLine: v })}
          />
          <Checkbox
            label="Гибридный формат"
            checked={settings.hybrid}
            onChange={(v) => patch({ hybrid: v })}
          />

          {/* Порог показываем только когда он влияет на печать. */}
          {settings.hybrid && (
            <label className="flex items-center gap-2 pl-6">
              <span className="text-[11px] text-muted-foreground">
                Начиная с номера
              </span>
              <input
                type="number"
                min={1}
                value={settings.expand}
                onChange={(e) => {
                  const raw = parseInt((e.target as HTMLInputElement).value, 10);
                  if (!Number.isNaN(raw) && raw >= 1) patch({ expand: raw });
                }}
                className="h-7 w-20 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          )}
        </div>

        {error && (
          <div className="text-[11px] text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => load()}
        >
          Обновить
        </Button>
      </div>
    </div>
  );
}

/** Чекбокс в стиле остальных элементов popup. */
function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
      />
      <span className="text-xs">{label}</span>
    </label>
  );
}
