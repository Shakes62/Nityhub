import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "subtle" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold " +
  "transition-[background-color,transform,box-shadow] duration-150 select-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-2 " +
  "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-55 aria-busy:cursor-progress " +
  "motion-reduce:transition-none motion-reduce:active:scale-100";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand text-brand-ink shadow-sm hover:bg-brand-strong hover:shadow-md",
  secondary: "border border-border-strong bg-surface text-ink hover:bg-surface-muted",
  subtle:
    "border border-transparent bg-surface-muted text-ink-soft hover:border-border-strong",
  ghost: "text-ink-soft hover:bg-surface-muted",
  danger: "bg-danger text-white hover:brightness-95",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm",
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

/** Compose button classes for use on non-button elements (e.g. links). */
export function buttonVariants(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Show a spinner and disable interaction. */
  loading?: boolean;
  /** Stretch to fill the container width. */
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, fullWidth, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(buttonVariants(variant, size), fullWidth && "w-full", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});
