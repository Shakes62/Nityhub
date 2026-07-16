import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A titled block within a detail view. */
export function DetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A bordered definition-list grid used to lay out record fields. */
export function DetailGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-soft p-4 text-sm">
      {children}
    </dl>
  );
}

/** A single label/value pair inside a {@link DetailGrid}. */
export function DetailRow({
  label,
  value,
  mono = false,
  full = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div className={cn(full && "col-span-2", "min-w-0")}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn("mt-0.5 break-words text-ink", mono && "font-mono text-[0.8125rem]")}>
        {value === null || value === undefined || value === "" ? "—" : value}
      </dd>
    </div>
  );
}
