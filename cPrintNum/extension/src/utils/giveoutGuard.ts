/**
 * Блокировка кнопки выдачи, когда клиент в долгу.
 *
 * Задача — не просто предупредить, а физически не дать оператору завершить
 * выдачу должнику. Способ: находим в DOM кнопки выдачи («Выдать»,
 * «Завершить», «Подтвердить») и, пока клиент-должник активен:
 *
 * - ставим `disabled` / `pointer-events: none` / `aria-disabled`;
 * - ловим клик в capture-фазе и гасим его (`preventDefault` +
 *   `stopImmediatePropagation`);
 * - показываем красный баннер с именем должника;
 * - перепроверяем DOM на мутациях и раз в 700 мс (SPA перерисовывает кнопки).
 *
 * Модуль не знает про Ozon-API: только «включить блокировку с такой подписью»
 * и «снять».
 */

import { showToast } from "@/utils/toast";

/** Слова, по которым узнаём кнопку завершения выдачи. */
const ACTION_WORDS = ["выдать", "завершить", "подтвердить"];

/** Кнопки, которые блокировать нельзя (отмена, печать и т.п.). */
const SKIP_WORDS = ["отмен", "закрыть", "назад", "печать", "распечат", "копир", "оплат"];

const BANNER_ID = "__printnum_guard_banner";
const MARK_ATTR = "data-printnum-guard";

type GuardTarget = HTMLElement & { __pnOriginal?: SavedStyle };

type SavedStyle = {
  pointerEvents: string;
  opacity: string;
  cursor: string;
  ariaDisabled: string | null;
  disabled?: boolean;
};

/** Активный должник (null — блокировка снята). */
let active: { clientId: string; name?: string } | null = null;

/** Заблокированные элементы: нужны, чтобы вернуть исходное состояние. */
const touched = new Set<GuardTarget>();

let observer: MutationObserver | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let scheduled = false;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Похоже ли на кнопку подтверждения выдачи. */
export function isGiveoutControl(el: Element): boolean {
  const text = normalize((el as HTMLElement).innerText || el.textContent || "");
  if (!text || text.length > 40) return false;
  if (SKIP_WORDS.some((w) => text.includes(w))) return false;
  return ACTION_WORDS.some((w) => text.includes(w));
}

const isVisible = (el: HTMLElement) => {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
};

/** Кандидаты на блокировку: кнопки/роли-кнопки с текстом действия. */
const candidates = (): HTMLElement[] => {
  const list = document.querySelectorAll<HTMLElement>(
    'button, [role="button"], a[role="button"], a',
  );
  const out: HTMLElement[] = [];
  for (const el of list) {
    if (!isGiveoutControl(el)) continue;
    if (!isVisible(el)) continue;
    out.push(el);
  }
  return out;
};

const blockOne = (el: GuardTarget) => {
  if (touched.has(el)) return;

  el.__pnOriginal = {
    pointerEvents: el.style.pointerEvents,
    opacity: el.style.opacity,
    cursor: el.style.cursor,
    ariaDisabled: el.getAttribute("aria-disabled"),
    disabled: "disabled" in el ? (el as HTMLButtonElement).disabled : undefined,
  };

  el.setAttribute(MARK_ATTR, "1");
  el.setAttribute("aria-disabled", "true");
  el.style.pointerEvents = "none";
  el.style.opacity = "0.45";
  el.style.cursor = "not-allowed";
  if ("disabled" in el) (el as HTMLButtonElement).disabled = true;

  touched.add(el);
};

const unblockOne = (el: GuardTarget) => {
  const orig = el.__pnOriginal;
  el.removeAttribute(MARK_ATTR);
  if (!orig) return;

  el.style.pointerEvents = orig.pointerEvents;
  el.style.opacity = orig.opacity;
  el.style.cursor = orig.cursor;
  if (orig.ariaDisabled === null) el.removeAttribute("aria-disabled");
  else el.setAttribute("aria-disabled", orig.ariaDisabled);
  if ("disabled" in el && typeof orig.disabled === "boolean") {
    (el as HTMLButtonElement).disabled = orig.disabled;
  }

  delete el.__pnOriginal;
  touched.delete(el);
};

const unblockAll = () => {
  for (const el of [...touched]) unblockOne(el);
  touched.clear();
};

const banner = (): HTMLElement | null => document.getElementById(BANNER_ID);

const setBanner = (text: string | null) => {
  const existing = banner();
  if (!text) {
    existing?.remove();
    return;
  }

  const el = existing ?? document.createElement("div");
  if (!existing) {
    el.id = BANNER_ID;
    el.style.cssText = [
      "position:fixed",
      "top:12px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "padding:10px 18px",
      "border-radius:10px",
      "background:#c81e1e",
      "color:#fff",
      "font:600 14px/1.35 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
      "box-shadow:0 6px 24px rgba(0,0,0,.35)",
      "pointer-events:none",
      "text-align:center",
      "max-width:80vw",
    ].join(";");
    (document.body ?? document.documentElement).appendChild(el);
  }
  el.textContent = text;
};

/** Перечитывает DOM и приводит кнопки в соответствие с состоянием. */
const apply = () => {
  scheduled = false;

  if (typeof document === "undefined") return;

  if (!active) {
    unblockAll();
    setBanner(null);
    return;
  }

  for (const el of candidates()) blockOne(el);

  setBanner(`Выдача заблокирована${active.name ? `: ${active.name}` : ""} (должник)`);

  for (const el of [...touched]) {
    if (!el.isConnected || !isGiveoutControl(el)) unblockOne(el);
  }
};

const schedule = () => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(apply);
};

const onClickCapture = (event: Event) => {
  if (!active) return;

  const target = event.target as Element | null;
  const el = target?.closest?.("button, [role=button], a") as Element | null;
  if (!el || !isGiveoutControl(el)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  showToast(
    `Выдача заблокирована${active.name ? `: ${active.name}` : ""}\nКлиент в списке должников`,
    "err",
    5000,
  );
};

const startWatching = () => {
  if (observer) return;

  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("auxclick", onClickCapture, true);

  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-disabled", "class"],
  });

  // SPA перерисовывает кнопку (React заменяет узлы), а иногда и без мутаций в
  // поддереве — поэтому не «по необходимости», а просто переприменяем состояние.
  // Стоимость низкая: один querySelectorAll раз в 700 мс.
  timer = setInterval(() => {
    if (!active) return;
    apply();
  }, 700);
};

const stopWatching = () => {
  document.removeEventListener("click", onClickCapture, true);
  document.removeEventListener("auxclick", onClickCapture, true);
  observer?.disconnect();
  observer = null;
  if (timer) clearInterval(timer);
  timer = null;
};

/**
 * Включает блокировку выдачи для указанного должника или снимает её (`null`).
 */
export function applyGiveoutGuard(debtor: { clientId: string; name?: string } | null) {
  if (!debtor) {
    if (!active) return;
    console.info("[PrintNum:guard] блокировка выдачи снята");
    active = null;
    apply();
    stopWatching();
    return;
  }

  const changed = active?.clientId !== debtor.clientId;
  active = { clientId: debtor.clientId, name: debtor.name };

  if (changed) {
    console.warn(
      `[PrintNum:guard] выдача заблокирована: должник ${debtor.name || debtor.clientId}`,
    );
  }

  startWatching();
  apply();
}

/** Текущее состояние — для отладки. */
export function giveoutGuardState(): { clientId: string; name?: string } | null {
  return active ? { ...active } : null;
}
