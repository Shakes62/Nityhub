"use client";

import { useEffect, useRef, useState } from "react";

interface VirtualList<T> {
  /** Attach to the scrolling viewport element. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Only the rows currently within (or near) the viewport. */
  items: T[];
  /** Absolute index of the first rendered row (for stable keys/striping). */
  startIndex: number;
  /** Spacer height above the rendered window, in px. */
  topPad: number;
  /** Spacer height below the rendered window, in px. */
  bottomPad: number;
}

/**
 * Fixed-height row virtualization. Renders only the rows visible in the scroll
 * viewport (plus an overscan buffer), regardless of how many thousands of rows
 * the dataset holds — keeping the DOM tiny and scrolling smooth. Rows MUST all
 * be exactly `rowHeight` px tall for the math to line up.
 */
export function useVirtualList<T>(
  items: T[],
  rowHeight: number,
  options: { overscan?: number; estimatedViewport?: number } = {},
): VirtualList<T> {
  const overscan = options.overscan ?? 8;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(options.estimatedViewport ?? 560);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setScrollTop(el.scrollTop);
      setViewport(el.clientHeight || viewport);
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
    // Measure callbacks read the latest ref; we only wire listeners once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = items.length;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const windowCount = Math.ceil(viewport / rowHeight) + overscan * 2;
  const end = Math.min(total, start + windowCount);

  return {
    scrollRef,
    items: items.slice(start, end),
    startIndex: start,
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (total - end) * rowHeight),
  };
}
