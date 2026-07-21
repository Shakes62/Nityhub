"use client";

import { useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDate, formatMoney, shortRef } from "@/lib/format";
import type { WalletTransaction } from "@/types/models";
import { getWalletData } from "@/services/api";
import { useToast } from "@/contexts/toast-context";
import { Card } from "@/components/ui/card";
import { PageHero } from "@/components/layout/page-hero";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";

type Filter = "all" | "credit" | "debit";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "credit", label: "Money in" },
  { id: "debit", label: "Money out" },
];

export default function TransactionsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<WalletTransaction[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await getWalletData(500);
        if (active) setRows(data.transactions ?? []);
      } catch (error) {
        if (!active) return;
        setRows([]);
        toast.error(error instanceof Error ? error.message : "Failed to load transactions.");
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = (rows ?? []).filter((tx) => {
    if (filter === "all") return true;
    const credit = Number(tx.amount || 0) >= 0;
    return filter === "credit" ? credit : !credit;
  });

  // Reveal 20 at a time as the user scrolls, so the DOM never holds the lot.
  const { visible, hasMore, sentinelRef } = useInfiniteScroll(filtered, 20);

  return (
    <>
      <PageHero title="Transactions" description="Every deposit and purchase on your wallet." />

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setFilter(entry.id)}
              aria-pressed={filter === entry.id}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                filter === entry.id
                  ? "bg-brand text-brand-ink"
                  : "bg-surface-muted text-ink-soft hover:text-ink",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {rows === null ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-11 rounded-lg" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No transactions"
            description={
              filter === "all"
                ? "Deposits and purchases will show up here."
                : "Nothing matches this filter."
            }
          />
        ) : (
          <>
            <TableWrap>
              <Table className="min-w-[34rem]">
                <thead className="sticky top-0 z-10">
                  <tr>
                    <Th>Reference</Th>
                    <Th>Type</Th>
                    <Th className="text-right">Amount</Th>
                    <Th className="text-right">Balance</Th>
                    <Th>Date</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((tx, index) => {
                    const value = Number(tx.amount || 0);
                    const credit = value >= 0;
                    const reference = tx.reference || tx.details?.reference || "-";
                    const DirIcon = credit ? ArrowDownLeft : ArrowUpRight;
                    return (
                      <tr
                        key={`${reference}-${index}`}
                        className="h-11 transition-colors duration-100 hover:bg-surface-soft/60"
                      >
                        <Td
                          className="py-0 font-mono text-[0.8125rem] font-medium text-ink"
                          title={reference}
                        >
                          {shortRef(reference, 12)}
                        </Td>
                        <Td className="py-0">
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <DirIcon
                              className={cn("size-3.5", credit ? "text-success" : "text-muted")}
                              aria-hidden
                            />
                            {tx.type || "transaction"}
                          </span>
                        </Td>
                        <Td
                          className={cn(
                            "py-0 text-right font-medium tabular",
                            credit ? "text-success" : "text-ink",
                          )}
                        >
                          {credit ? `+${formatMoney(value)}` : `−${formatMoney(Math.abs(value))}`}
                        </Td>
                        <Td className="py-0 text-right tabular">{formatMoney(tx.balance || 0)}</Td>
                        <Td className="py-0 whitespace-nowrap">{formatDate(tx.timestamp)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
            {hasMore ? (
              <div ref={sentinelRef} aria-hidden className="py-2 text-center text-xs text-muted">
                Loading more…
              </div>
            ) : (
              <p className="py-1 text-center text-xs text-muted">
                {filtered.length} transaction{filtered.length === 1 ? "" : "s"}
              </p>
            )}
          </>
        )}
      </Card>
    </>
  );
}
