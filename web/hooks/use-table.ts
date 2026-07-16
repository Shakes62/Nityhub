"use client";

import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

/** A column's sortable accessor, keyed by a stable id. */
export type Accessors<T> = Record<string, (row: T) => string | number | null | undefined>;

interface UseTableOptions {
  pageSize?: number;
  initialSort?: { key: string; dir: SortDir };
}

export interface TableController<T> {
  /** Rows for the current page (already sorted). */
  pageRows: T[];
  /** Total rows after filtering (before pagination). */
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  /** 1-based index of the first visible row (0 when empty). */
  from: number;
  /** 1-based index of the last visible row. */
  to: number;
  setPage: (page: number) => void;
  sortKey: string | null;
  sortDir: SortDir;
  /** Toggle sort on a key (asc → desc → asc). */
  toggleSort: (key: string) => void;
}

/**
 * Client-side sort + pagination over an already-filtered array. Pages perform
 * their own search/filter (with useMemo) and hand the reduced rows here; this
 * keeps sorting and pagination identical across every admin table.
 *
 * Sorting is stable and type-aware: numeric accessors compare numerically,
 * everything else compares as lowercased strings.
 */
export function useTable<T>(
  rows: T[],
  accessors: Accessors<T>,
  options: UseTableOptions = {},
): TableController<T> {
  const pageSize = options.pageSize ?? 25;
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<string | null>(options.initialSort?.key ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(options.initialSort?.dir ?? "desc");

  const sorted = useMemo(() => {
    if (!sortKey) {
      return rows;
    }
    const accessor = accessors[sortKey];
    if (!accessor) {
      return rows;
    }
    const factor = sortDir === "asc" ? 1 : -1;
    // Decorate → sort → undecorate to keep the comparison stable.
    return rows
      .map((row, index) => ({ row, index, value: accessor(row) }))
      .sort((a, b) => {
        const av = a.value;
        const bv = b.value;
        const aEmpty = av === null || av === undefined || av === "";
        const bEmpty = bv === null || bv === undefined || bv === "";
        if (aEmpty && bEmpty) return a.index - b.index;
        if (aEmpty) return 1; // empties sink to the bottom regardless of dir
        if (bEmpty) return -1;
        let cmp: number;
        if (typeof av === "number" && typeof bv === "number") {
          cmp = av - bv;
        } else {
          cmp = String(av).toLowerCase().localeCompare(String(bv).toLowerCase());
        }
        return cmp === 0 ? a.index - b.index : cmp * factor;
      })
      .map((entry) => entry.row);
  }, [rows, accessors, sortKey, sortDir]);

  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  const toggleSort = (key: string) => {
    setPage(1);
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  return {
    pageRows,
    total,
    page: safePage,
    pageCount,
    pageSize,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + pageSize, total),
    setPage,
    sortKey,
    sortDir,
    toggleSort,
  };
}
