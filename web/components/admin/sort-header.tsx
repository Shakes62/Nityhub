"use client";

import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { Th } from "@/components/ui/table";
import type { SortDir } from "@/hooks/use-table";

interface SortHeaderProps {
  label: string;
  sortKey: string;
  activeKey: string | null;
  dir: SortDir;
  onSort: (key: string) => void;
  className?: string;
  /** Right-align numeric columns. */
  align?: "left" | "right";
}

/** A clickable table header that drives {@link useTable} sorting. */
export function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  className,
  align = "left",
}: SortHeaderProps) {
  const active = activeKey === sortKey;
  const Icon = active ? (dir === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <Th
      className={cn("p-0", className)}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "flex w-full items-center gap-1 px-4 py-3 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] transition-colors hover:text-ink-soft",
          active ? "text-ink-soft" : "text-muted",
          align === "right" ? "justify-end" : "justify-start",
        )}
      >
        {align === "right" ? null : <span>{label}</span>}
        <Icon className={cn("size-3.5 shrink-0", active ? "text-brand" : "text-muted")} />
        {align === "right" ? <span>{label}</span> : null}
      </button>
    </Th>
  );
}
