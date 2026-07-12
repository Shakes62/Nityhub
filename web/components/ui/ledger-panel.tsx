import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface LedgerPanelProps {
  label: string;
  value: ReactNode;
  meta?: string;
  loading?: boolean;
  /** Right-aligned slot (e.g. a chip/link). */
  children?: ReactNode;
  className?: string;
}

/**
 * The signature "Ledger Panel": a deep-jade money surface with a faint contour
 * texture. Presentational only. Used in exactly two places — the Dashboard
 * balance and the Wallet balance — so the dark green always means "your money".
 */
export function LedgerPanel({
  label,
  value,
  meta,
  loading,
  children,
  className,
}: LedgerPanelProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-card bg-linear-to-br from-ledger to-ledger-deep",
        "p-6 text-ledger-ink shadow-ledger",
        className,
      )}
    >
      {/* Concentric contour texture, anchored bottom-right. */}
      <svg
        className="pointer-events-none absolute -bottom-16 -right-12 h-64 w-64 fill-none stroke-ledger-line"
        viewBox="0 0 256 256"
        aria-hidden
      >
        <circle cx="200" cy="200" r="48" strokeWidth="1" />
        <circle cx="200" cy="200" r="80" strokeWidth="1" />
        <circle cx="200" cy="200" r="112" strokeWidth="1" />
        <circle cx="200" cy="200" r="144" strokeWidth="1" />
        <circle cx="200" cy="200" r="176" strokeWidth="1" />
      </svg>

      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-ledger-muted">
            {label}
          </p>
          {loading ? (
            <div className="mt-2 h-10 w-40 animate-pulse rounded-md bg-white/15 motion-reduce:animate-none" />
          ) : (
            <p className="mt-1 text-[2.5rem] font-semibold leading-[1.1] tracking-tight tabular text-ledger-ink">
              {value}
            </p>
          )}
          {meta ? (
            <p className="mt-1 text-sm text-ledger-muted">{meta}</p>
          ) : null}
        </div>
        {children ? <div className="relative shrink-0">{children}</div> : null}
      </div>
    </div>
  );
}
