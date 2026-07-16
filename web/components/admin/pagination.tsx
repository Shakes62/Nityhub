"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PaginationProps {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  /** Noun for the row type, e.g. "users", "orders". */
  noun?: string;
  onPage: (page: number) => void;
}

/** Row-count summary + prev/next controls shared by every admin table. */
export function Pagination({
  page,
  pageCount,
  from,
  to,
  total,
  noun = "rows",
  onPage,
}: PaginationProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
      <p className="text-xs text-muted tabular">
        {total === 0 ? `No ${noun}` : `${from}–${to} of ${total} ${noun}`}
      </p>
      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-xs font-medium text-ink-soft tabular">
            {page} / {pageCount}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onPage(page + 1)}
            disabled={page >= pageCount}
            aria-label="Next page"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
