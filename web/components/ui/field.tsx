import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

const CONTROL =
  "h-12 w-full rounded-md border border-border bg-surface px-3.5 text-sm text-ink " +
  "transition-colors placeholder:text-muted focus:border-brand focus:outline-none " +
  "focus:ring-2 focus:ring-brand/25 disabled:opacity-60";

interface FieldProps {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}

/** Label + control + hint/error wrapper for consistent form rows. */
export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(CONTROL, className)} {...props} />;
  },
);

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(CONTROL, "select-chevron appearance-none pr-9", className)}
      {...props}
    />
  );
});

/** Convenience hook for stable field ids. */
export function useFieldId(prefix: string): string {
  return `${prefix}-${useId()}`;
}
