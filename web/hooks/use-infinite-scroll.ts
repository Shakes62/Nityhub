"use client";

import { useEffect, useRef, useState } from "react";

interface InfiniteScroll<T> {
  /** The slice of `items` revealed so far. */
  visible: T[];
  /** Whether more rows remain to reveal. */
  hasMore: boolean;
  /** Attach to a sentinel element rendered after the list. */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Progressive "infinite scroll" over an in-memory array. Reveals `pageSize`
 * rows initially and `pageSize` more each time a sentinel enters the viewport
 * (via IntersectionObserver) — so the DOM only ever holds revealed rows, never
 * the entire dataset. Resets to the first page whenever `items` changes
 * (e.g. after a search/filter).
 */
export function useInfiniteScroll<T>(items: T[], pageSize = 20): InfiniteScroll<T> {
  const [count, setCount] = useState(pageSize);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Reset the window when the underlying list identity changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCount(pageSize);
  }, [items, pageSize]);

  const hasMore = count < items.length;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setCount((current) => Math.min(current + pageSize, items.length));
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, items.length, pageSize]);

  return { visible: items.slice(0, count), hasMore, sentinelRef };
}
