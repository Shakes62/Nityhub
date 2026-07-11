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
      className={cn(
        "rounded-lg border border-border bg-surface-soft p-4",
        className,
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <p className="mt-1.5 text-2xl font-semibold tracking-tight text-ink">
          {value}
        </p>
      )}
      {meta ? <p className="mt-1 text-xs text-muted">{meta}</p> : null}
    </div>
  );
}
