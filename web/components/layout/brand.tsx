import { cn } from "@/lib/cn";

/**
 * The NityHub mark: a rounded jade badge carrying the "N" monogram.
 *
 * Inlined rather than loaded from /brand/*.svg so it paints with the first
 * render (no extra request, no flash) and can inherit sizing from the caller.
 * The standalone files in public/brand/ are the exportable versions.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("size-10", className)}
      role="img"
      aria-label="NityHub"
    >
      <rect width="64" height="64" rx="14" fill="var(--color-brand)" />
      <path
        d="M20 46V18l24 28V18"
        fill="none"
        stroke="#ffffff"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
      <BrandMark className="size-10 shrink-0 drop-shadow-sm" />
      <div className="leading-tight">
        <div className="text-sm font-semibold text-ink">NityHub</div>
        {withNote ? (
          <div className="text-xs text-muted">Smart data, cleaner workflow</div>
        ) : null}
      </div>
    </div>
  );
}
