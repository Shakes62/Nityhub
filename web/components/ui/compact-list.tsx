"use client";

import { cn } from "@/lib/cn";

/**
 * A deliberately short scroll container.
 *
 * Long histories should not push the rest of a page out of view, so the
 * container is sized to roughly `rows` items and scrolls internally. Pair it
 * with useInfiniteScroll and render the returned sentinel as the last child so
 * more rows are revealed as the user scrolls inside it.
 */
export function CompactList({
  rows = 4,
  rowHeight = 56,
  className,
  children,
}: {
  /** Approximate number of rows visible before scrolling. */
  rows?: number;
  /** Row height in px, used to compute the max height. */
  rowHeight?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("overflow-y-auto overscroll-contain pr-0.5", className)}
      style={{ maxHeight: rows * rowHeight }}
    >
      {children}
    </div>
  );
}
