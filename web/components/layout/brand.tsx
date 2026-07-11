import { cn } from "@/lib/cn";

/** NityHub brand lockup used in the sidebar and auth screen. */
export function Brand({
  withNote = true,
  className,
}: {
  withNote?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex size-10 items-center justify-center rounded-xl bg-brand text-sm font-bold text-brand-ink shadow-sm">
        NH
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold text-ink">NityHub</div>
        {withNote ? (
          <div className="text-xs text-muted">Smart data, cleaner workflow</div>
        ) : null}
      </div>
    </div>
  );
}
