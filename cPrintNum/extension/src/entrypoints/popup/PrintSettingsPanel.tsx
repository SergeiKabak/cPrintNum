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
  getServiceStatus,
  installService,
  uninstallService,
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
  const [serviceInstalled, setServiceInstalled] = useState(false);
  const [serviceBusy, setServiceBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, p, pp, svc] = await Promise.all([
      getSettings(),
      getPrinters(),
      getPapers(),
      getServiceStatus(),
    ]);

    setServiceInstalled(svc);

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
        <span className="text-[10px] text-muted-foreground leading-tight">
          Быстрое переключение на странице Ozon — <b>Ctrl+O</b> (Cmd+O на macOS).
        </span>

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
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring appearance-none"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`,
              backgroundPosition: 'right 8px center',
              backgroundRepeat: 'no-repeat',
              backgroundSize: '16px 16px',
            }}
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
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring appearance-none"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`,
              backgroundPosition: 'right 8px center',
              backgroundRepeat: 'no-repeat',
              backgroundSize: '16px 16px',
            }}
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

          {/* QR товара рядом с номером ячейки (config → qrWithNumber). */}
          <Checkbox
            label="QR товара рядом с номером"
            checked={!!settings.qrWithNumber}
            onChange={(v) => patch({ qrWithNumber: v })}
          />
          {settings.qrWithNumber && (
            <span className="text-[10px] text-muted-foreground leading-tight pl-6">
              Номер печатается без точки, QR — справа. Нужен штрихкод в ответе
              Ozon (режим автопечати «Перехват ответов Ozon»).
            </span>
          )}

          {/* Режим печати: драйвер Windows или raw ESC/POS (без настроек). */}
          <div className="flex flex-col gap-2 pt-2 mt-1 border-t border-border/50">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                Режим печати
              </span>
              <select
                value={settings.printerMode || "gdi"}
                onChange={(e) =>
                  patch({ printerMode: (e.target as HTMLSelectElement).value })
                }
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="gdi">Через драйвер Windows (GDI)</option>
                <option value="escpos">ESC/POS (raw, без настроек драйвера)</option>
              </select>
              <span className="text-[10px] text-muted-foreground leading-tight">
                ESC/POS печатает картинку напрямую: размер этикетки, зазор и
                сдвиг задаются здесь, а не в свойствах принтера.
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                Папка превью (вместо печати)
              </span>
              <input
                type="text"
                defaultValue={settings.previewDir || ""}
                placeholder="C:\\PrintNum\\preview"
                onBlur={(e) =>
                  patch({
                    previewDir: (e.target as HTMLInputElement).value.trim(),
                  })
                }
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="text-[10px] text-muted-foreground leading-tight">
                Если задано — принтер не используется, каждая печать сохраняется
                в BMP: удобно проверять всю цепочку без бумаги.
              </span>
            </label>

            {settings.printerMode === "escpos" && (
              <>
                <MmInput
                  label="Зазор, мм"
                  valueX10={settings.labelGapMm}
                  fallbackX10={30}
                  onChange={(v) => patch({ labelGapMm: v })}
                />
                <MmInput
                  label="Сдвиг вправо, мм"
                  valueX10={settings.rawXOffsetMm}
                  fallbackX10={0}
                  min={0}
                  onChange={(v) => patch({ rawXOffsetMm: v })}
                />
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    Транспорт
                  </span>
                  <select
                    value={settings.rawTransport || "spooler"}
                    onChange={(e) =>
                      patch({ rawTransport: (e.target as HTMLSelectElement).value })
                    }
                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="spooler">Спулер (USB/LAN/BT)</option>
                    <option value="tcp">TCP :9100 (сеть)</option>
                  </select>
                </label>
                {settings.rawTransport === "tcp" && (
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      IP принтера
                    </span>
                    <input
                      type="text"
                      defaultValue={settings.rawHost || ""}
                      placeholder="192.168.1.50"
                      onBlur={(e) =>
                        patch({ rawHost: (e.target as HTMLInputElement).value.trim() })
                      }
                      className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                )}
              </>
            )}
          </div>

          {/* Шахматка + обводка: раньше задавались только в config.json. */}
          <div className="flex flex-col gap-2 pt-2 mt-1 border-t border-border/50">
            <Checkbox
              label="Шахматка (экономия термоголовки)"
              checked={!!settings.checker}
              onChange={(v) => patch({ checker: v })}
            />
            {settings.checker && (
              <MmInput
                label="Макс. клетка, мм"
                valueX10={settings.checkerMm}
                fallbackX10={10}
                onChange={(v) => patch({ checkerMm: v })}
              />
            )}
            <Checkbox
              label="Обводка по контуру"
              checked={!!settings.outline}
              onChange={(v) => patch({ outline: v })}
            />
            {settings.outline && (
              <MmInput
                label="Толщина, мм"
                valueX10={settings.outlineMm}
                fallbackX10={5}
                scale={100}
                step={0.01}
                onChange={(v) => patch({ outlineMm: v })}
              />
            )}
            <span className="text-[10px] text-muted-foreground leading-tight">
              Работает и вместе с QR. Клетка зависит от числа цифр: 1 → 0.5 мм,
              2 → 0.25 мм, 3 → 0.125 мм, 4+ → 0.05 мм; значение выше — только
              верхняя граница.
            </span>
          </div>

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

        {/* Панель управления службой */}
        <div className="pt-1 border-t border-border/50">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">
              Автозагрузка службы
            </span>
            <span
              className={`text-[10px] font-bold ${
                serviceInstalled
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              {serviceInstalled ? "установлена" : "не установлена"}
            </span>
          </div>
          <Button
            variant={serviceInstalled ? "destructive" : "outline"}
            size="sm"
            className="w-full mt-1.5"
            disabled={serviceBusy}
            onClick={async () => {
              setServiceBusy(true);
              const result = serviceInstalled
                ? await uninstallService()
                : await installService();
              setServiceBusy(false);

              if (result.ok) {
                setServiceInstalled(!serviceInstalled);
                setError(null);
              } else {
                setError(result.error || "Ошибка");
              }
            }}
          >
            {serviceBusy
              ? "Подождите…"
              : serviceInstalled
                ? "Удалить из автозагрузки"
                : "Установить в автозагрузку"}
          </Button>
          <p className="text-[10px] text-muted-foreground mt-1 leading-tight">
            При автозагрузке служба запускается автоматически при входе в систему. Печать работает без открытого окна приложения.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Поле «размер в мм» для настроек, которые хранятся в 0.1 мм (10 = 1.0). */
function MmInput({
  label,
  valueX10,
  fallbackX10,
  min = 0.1,
  scale = 10,
  step = 0.1,
  onChange,
}: {
  label: string;
  valueX10: number | undefined;
  fallbackX10: number;
  min?: number;
  /** Во сколько раз значение в конфиге больше миллиметров (10 = 0.1 мм). */
  scale?: number;
  step?: number;
  onChange: (valueX10: number) => void;
}) {
  const mm = (valueX10 ?? fallbackX10) / scale;

  return (
    <label className="flex items-center justify-between gap-2 pl-6">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={mm}
        onChange={(e) => {
          const parsed = parseFloat((e.target as HTMLInputElement).value);
          if (Number.isNaN(parsed)) return;
          const units = Math.max(0, Math.round(parsed * scale));
          onChange(units);
        }}
        className="h-7 w-20 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
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
