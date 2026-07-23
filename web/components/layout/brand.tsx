import Image from "next/image";
import { cn } from "@/lib/cn";

/**
 * The NityHub mark: the interlocking-hexagon "N" symbol on a rounded jade badge.
 *
 * The white symbol lives in /brand/nityhub-symbol-white.png (exported from the
 * brand artwork); we tint the badge with the brand color so it matches the
 * favicon, PWA, and social icons. Marked priority so it paints on first render.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="NityHub"
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-[28%] bg-brand",
        className,
      )}
    >
      <Image
        src="/brand/nityhub-symbol-white.png"
        alt=""
        width={64}
        height={64}
        priority
        className="size-[62%] object-contain"
      />
    </span>
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
