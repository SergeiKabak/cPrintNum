/**
 * Кнопка на Preact (замена Radix `@radix-ui/react-slot`-кнопки).
 *
 * Поддерживает варианты оформления, используемые в popup:
 * `default`, `ghost`, `secondary`, `outline`, `destructive`.
 */

import type { ComponentChildren, JSX } from "preact";
import { cn } from "@/lib/utils";

export type ButtonVariant = "default" | "ghost" | "secondary" | "outline" | "destructive";

export type ButtonSize = "default" | "sm" | "lg" | "icon";

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ComponentChildren;
  [key: string]: unknown;
}

const VARIANTS: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  ghost: "hover:bg-muted/40 text-foreground",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  outline: "border border-border bg-background hover:bg-muted/40",
  destructive: "bg-red-500 text-white hover:bg-red-500/90",
};

const SIZES: Record<ButtonSize, string> = {
  default: "h-9 px-4 py-2",
  sm: "h-8 px-3 text-xs",
  lg: "h-10 px-6",
  icon: "h-9 w-9",
};

export function Button({
  variant = "default",
  size = "default",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...(props as JSX.ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {children}
    </button>
  );
}
