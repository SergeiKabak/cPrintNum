/**
 * Панель «Должники» в popup.
 *
 * Локальная база клиентов, которым нельзя выдавать заказы: список хранится в
 * `chrome.storage.local` (`debtors`), сопоставление с Ozon — по `clientId`.
 * Проверка происходит на странице при сканировании (`debtorWatch.content.ts`),
 * здесь только CRUD и импорт/экспорт.
 */

declare const chrome: any;

import { useEffect, useMemo, useState } from "preact/hooks";
import { CircleAlert, Download, Plus, Trash2, Upload, UserRound } from "lucide-preact";
import { Button } from "@/components/preact/button";
import {
  DEBTORS_KEY,
  normalizeClientId,
  parseDebtorsJson,
  readDebtors,
  removeDebtor,
  stringifyDebtors,
  upsertDebtor,
  writeDebtors,
  type Debtor,
} from "@/utils/debtors";

type Status = { kind: "idle" | "ok" | "err"; msg?: string };

/** Диагностика из content script: сколько пар «клиент ↔ отправление» поймано. */
type WatchStats = { pairs: number; clients: number; at: number };

/** Ключ настройки: блокировать кнопку «Выдать» у должника. */
const BLOCK_KEY = "debtorBlockGiveout";

export default function DebtorsPanel() {
  const [list, setList] = useState<Debtor[]>([]);
  const [clientId, setClientId] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [watch, setWatch] = useState<WatchStats | null>(null);
  const [blockGiveout, setBlockGiveout] = useState(true);

  const reload = () => {
    readDebtors().then(setList);
  };

  useEffect(() => {
    reload();

    chrome.storage.local.get(["debtorStats", BLOCK_KEY], (stored: any) => {
      if (stored?.debtorStats) setWatch(stored.debtorStats as WatchStats);
      if (typeof stored?.[BLOCK_KEY] === "boolean") setBlockGiveout(stored[BLOCK_KEY]);
    });

    const onChanged = (changes: any, area: string) => {
      if (area !== "local") return;
      if (changes?.[DEBTORS_KEY]) reload();
      if (changes?.debtorStats) setWatch(changes.debtorStats.newValue ?? null);
      if (changes?.[BLOCK_KEY]) setBlockGiveout(changes[BLOCK_KEY].newValue !== false);
    };

    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const canSave = normalizeClientId(clientId).length >= 3;

  const resetForm = () => {
    setClientId("");
    setName("");
    setNote("");
    setEditId(null);
  };

  const save = async () => {
    if (!canSave) return;

    const next = await upsertDebtor({
      id: editId ?? undefined,
      clientId,
      name: name.trim() || undefined,
      note: note.trim() || undefined,
    });

    setList(next);
    setStatus({ kind: "ok", msg: editId ? "Изменено" : "Добавлено" });
    resetForm();
  };

  const remove = async (id: string) => {
    setList(await removeDebtor(id));
    if (editId === id) resetForm();
    setStatus({ kind: "ok", msg: "Удалено" });
  };

  const startEdit = (d: Debtor) => {
    setEditId(d.id);
    setClientId(d.clientId);
    setName(d.name ?? "");
    setNote(d.note ?? "");
    setStatus({ kind: "idle" });
  };

  const exportJson = () => {
    const blob = new Blob([stringifyDebtors(list)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "debtors.json";
    a.click();
    URL.revokeObjectURL(url);
    setStatus({ kind: "ok", msg: `Экспортировано: ${list.length}` });
  };

  const importJson = async (file: File) => {
    try {
      const parsed = parseDebtorsJson(await file.text());
      await writeDebtors(parsed);
      setList(await readDebtors());
      setStatus({ kind: "ok", msg: `Импортировано: ${parsed.length}` });
    } catch (e) {
      setStatus({
        kind: "err",
        msg: e instanceof Error ? e.message : "Не удалось прочитать JSON",
      });
    }
  };

  const sorted = useMemo(
    () => [...list].sort((a, b) => a.clientId.localeCompare(b.clientId)),
    [list],
  );

  return (
    <div className="w-full rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden">
      <div className="px-3 py-2.5 bg-muted/30 border-b border-border flex items-center gap-2 select-none">
        <UserRound class="h-4 w-4 text-red-600 dark:text-red-500 shrink-0" />
        <span className="text-sm font-bold tracking-tight flex-1 truncate leading-none">
          Должники
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">{list.length}</span>
      </div>

      <div className="p-3 flex flex-col gap-2">
        <span className="text-[10px] text-muted-foreground leading-tight">
          При скане отправления на выдачу сверяем `clientId` с этим списком и показываем
          предупреждение, если клиент в базе.
        </span>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            clientId <span className="text-red-500">*</span>
          </span>
          <input
            type="text"
            value={clientId}
            onInput={(e) => setClientId((e.target as HTMLInputElement).value)}
            placeholder="например, 100000000240360429"
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <div className="flex gap-2">
          <label className="flex flex-col gap-1 flex-1 min-w-0">
            <span className="text-[11px] font-medium text-muted-foreground">Имя</span>
            <input
              type="text"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1 flex-1 min-w-0">
            <span className="text-[11px] font-medium text-muted-foreground">Комментарий</span>
            <input
              type="text"
              value={note}
              onInput={(e) => setNote((e.target as HTMLInputElement).value)}
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        </div>

        <div className="flex gap-2">
          <Button variant="default" size="sm" className="flex-1" disabled={!canSave} onClick={save}>
            <Plus class="h-4 w-4 shrink-0" />
            <span>{editId ? "Сохранить" : "Добавить"}</span>
          </Button>
          {editId && (
            <Button variant="outline" size="sm" onClick={resetForm}>
              Отмена
            </Button>
          )}
        </div>

        <label className="flex items-center gap-2 text-[11px] leading-tight cursor-pointer select-none">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-red-600"
            checked={blockGiveout}
            onChange={(e) => {
              const next = e.currentTarget.checked;
              setBlockGiveout(next);
              chrome.storage.local.set({ [BLOCK_KEY]: next });
            }}
          />
          <span>Блокировать кнопку «Выдать» у должника</span>
        </label>

        {watch && (
          <span className="text-[10px] text-muted-foreground leading-tight">
            Из ответов Ozon: отправлений {watch.pairs}, клиентов {watch.clients}
            {watch.pairs === 0
              ? " — связка «клиент ↔ отправление» ещё не встречалась, проверка не сработает"
              : ""}
          </span>
        )}

        {status.kind !== "idle" && status.msg && (
          <div
            className={`flex items-start gap-1.5 text-[10px] leading-snug ${
              status.kind === "err"
                ? "text-red-600 dark:text-red-400"
                : "text-emerald-600 dark:text-emerald-400"
            }`}
          >
            <CircleAlert class="h-3 w-3 shrink-0 mt-0.5" />
            <span>{status.msg}</span>
          </div>
        )}

        {/* Список */}
        <div className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {sorted.length === 0 && (
            <div className="p-2 text-[11px] text-muted-foreground">Список пуст</div>
          )}

          {sorted.map((d) => (
            <div key={d.id} className="flex items-center gap-2 p-2">
              <button
                type="button"
                onClick={() => startEdit(d)}
                className="flex-1 min-w-0 text-left"
                title="Изменить"
              >
                <div className="text-[11px] font-semibold truncate">{d.name || d.clientId}</div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {d.clientId}
                  {d.note ? ` · ${d.note}` : ""}
                </div>
              </button>
              <button
                type="button"
                onClick={() => remove(d.id)}
                className="shrink-0 p-1 rounded text-red-600 hover:bg-red-500/10"
                title="Удалить"
              >
                <Trash2 class="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>

        {/* Импорт/экспорт */}
        <div className="flex gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={exportJson}
            disabled={!list.length}
          >
            <Download class="h-3.5 w-3.5 shrink-0" />
            <span>Экспорт</span>
          </Button>

          <div className="flex-1">
            <input
              id="debtors-import"
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const input = e.target as HTMLInputElement;
                const file = input.files?.[0];
                if (file) void importJson(file);
                input.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                const input = document.getElementById("debtors-import") as HTMLInputElement | null;
                input?.click();
              }}
            >
              <Upload class="h-3.5 w-3.5 shrink-0" />
              <span>Импорт</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
