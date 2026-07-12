import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/skeleton";

interface StatProps {
  label: string;
  value: ReactNode;
  meta?: string;
  loading?: boolean;
  className?: string;
}

/** Compact metric tile used on the dashboard and page heroes. */
export function Stat({ label, value, meta, loading, className }: StatProps) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface-soft p-4", className)}
    >
      <p className="text-[0.6875rem] font-semibold uppercase leading-[1.3] tracking-[0.08em] text-muted">
        {label}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-24 rounded-md" />
      ) : (
        <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular text-ink">
          {value}
        </p>
      )}
      {meta ? <p className="mt-1 text-xs text-muted">{meta}</p> : null}
    </div>
  );
}
