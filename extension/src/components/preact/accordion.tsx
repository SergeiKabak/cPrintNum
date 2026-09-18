/**
 * Accordion на Preact (замена Radix UI).
 *
 * Реализует только то, что нужно popup: одиночное раскрытие секции
 * (`type="single"`) с возможностью закрыть (`collapsible`).
 *
 * Состояние хранится в контексте — компонент `Accordion` владеет открытым
 * значением, а `AccordionItem`/`AccordionTrigger`/`AccordionContent`
 * читают и меняют его.
 */

import { createContext } from "preact";
import { useContext, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { ChevronDown } from "lucide-preact";

// ---------- Контекст ----------

interface AccordionContextValue {
  openValue: string | null;
  toggle: (value: string) => void;
}

const AccordionContext = createContext<AccordionContextValue>({
  openValue: null,
  toggle: () => {},
});

interface ItemContextValue {
  value: string;
  isOpen: boolean;
}

const ItemContext = createContext<ItemContextValue>({
  value: "",
  isOpen: false,
});

// ---------- Корень ----------

export interface AccordionProps {
  /** "single" — открыт только один; "multiple" не используется в popup. */
  type?: "single";
  collapsible?: boolean;
  /** Начальное открытое значение (необязательно). */
  defaultValue?: string;
  className?: string;
  children?: ComponentChildren;
}

export function Accordion({
  collapsible = false,
  defaultValue,
  className,
  children,
}: AccordionProps) {
  const [openValue, setOpenValue] = useState<string | null>(
    defaultValue ?? null,
  );

  const toggle = (value: string) => {
    setOpenValue((prev) => {
      if (prev === value) {
        return collapsible ? null : prev;
      }
      return value;
    });
  };

  return (
    <AccordionContext.Provider value={{ openValue, toggle }}>
      <div className={className}>{children}</div>
    </AccordionContext.Provider>
  );
}

// ---------- Элемент ----------

export interface AccordionItemProps {
  value: string;
  className?: string;
  children?: ComponentChildren;
}

export function AccordionItem({
  value,
  className,
  children,
}: AccordionItemProps) {
  const { openValue } = useContext(AccordionContext);
  const isOpen = openValue === value;

  return (
    <ItemContext.Provider value={{ value, isOpen }}>
      <div className={className} data-state={isOpen ? "open" : "closed"}>
        {children}
      </div>
    </ItemContext.Provider>
  );
}

// ---------- Триггер ----------

export interface AccordionTriggerProps {
  className?: string;
  children?: ComponentChildren;
  [key: string]: unknown;
}

export function AccordionTrigger({
  className,
  children,
  ...props
}: AccordionTriggerProps) {
  const { toggle } = useContext(AccordionContext);
  const { value, isOpen } = useContext(ItemContext);

  return (
    <button
      type="button"
      className={`flex w-full items-center justify-between gap-2 text-left ${className ?? ""}`}
      data-state={isOpen ? "open" : "closed"}
      aria-expanded={isOpen}
      onClick={() => toggle(value)}
      {...props}
    >
      <span className="flex-1 text-left">{children}</span>
      <ChevronDown
        class={`h-4 w-4 shrink-0 transition-transform duration-200 ${
          isOpen ? "rotate-180" : ""
        }`}
      />
    </button>
  );
}

// ---------- Содержимое ----------

export interface AccordionContentProps {
  className?: string;
  children?: ComponentChildren;
}

export function AccordionContent({
  className,
  children,
}: AccordionContentProps) {
  const { isOpen } = useContext(ItemContext);

  if (!isOpen) return null;

  return (
    <div
      className="w-full overflow-hidden text-sm transition-all"
      data-state="open"
    >
      <div className={className}>{children}</div>
    </div>
  );
}