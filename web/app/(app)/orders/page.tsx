"use client";

import { useMemo, useState } from "react";
import { MessageCircle, Search } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Badge, statusLabel, statusTone } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { PageHero } from "@/components/layout/page-hero";
import { NetworkDot } from "@/components/ui/network-dot";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { formatDate, formatMoney } from "@/lib/format";
import { SUPPORT_WHATSAPP } from "@/constants/config";
import type { Order } from "@/types/models";
import { getUserOrders } from "@/services/api";
import { useAsyncData } from "@/hooks/use-async-data";

function reportLink(order: Order): string {
  const lines = [
    "Hello, I want to report an order.",
    `Reference: ${order.reference || "-"}`,
    `Network: ${String(order.network || "-").toUpperCase()}`,
    `Phone: ${order.phone || "-"}`,
    `Bundle: ${order.label || `${order.volume || "-"}MB`}`,
    `Amount: ${formatMoney(order.amount || 0)}`,
    `Status: ${statusLabel(order.status)}`,
    `Date: ${formatDate(order.timestamp || order.createdAt)}`,
  ];
  return `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(lines.join("\n"))}`;
}

export default function OrdersPage() {
  const { data, loading, error, reload } = useAsyncData(() => getUserOrders(200), []);
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const all = data || [];
    const term = search.trim().toLowerCase();
    if (!term) return all;
    return all.filter((order) => {
      const ref = String(order.reference || "").toLowerCase();
      const phone = String(order.phone || "").toLowerCase();
      return ref.includes(term) || phone.includes(term);
    });
  }, [data, search]);

  const searchControl = (
    <div className="relative w-full sm:w-64">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
        aria-hidden
      />
      <Input
        id="order-search"
        type="search"
        aria-label="Search"
        placeholder="Reference or phone"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="h-10 pl-9 font-mono"
      />
    </div>
  );

  return (
    <>
      <PageHero title="Orders" description="Track every purchase and its status." />

      <Card className="flex flex-col gap-4">
        <CardHeader title="History" action={searchControl} />

        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={search ? "No matching orders" : "No orders yet"}
            description={
              search
                ? "Try a different reference or phone number."
                : "Your purchases will appear here once you buy a bundle."
            }
          />
        ) : (
          <>
            {/* Desktop table */}
            <TableWrap className="hidden md:block">
              <Table>
                <thead>
                  <tr>
                    <Th>Reference</Th>
                    <Th>Network</Th>
                    <Th>Phone</Th>
                    <Th>Bundle</Th>
                    <Th>Amount</Th>
                    <Th>Status</Th>
                    <Th>Date</Th>
                    <Th>Report</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((order, index) => (
                    <tr
                      key={order.reference || index}
                      className="transition-colors duration-100 hover:bg-surface-soft/60"
                    >
                      <Td
                        className="font-mono text-[0.8125rem] font-medium text-ink"
                        title={order.reference || ""}
                      >
                        {order.reference || "-"}
                      </Td>
                      <Td>
                        <span className="inline-flex items-center gap-1.5">
                          <NetworkDot network={order.network} />
                          {String(order.network || "-").toUpperCase()}
                        </span>
                      </Td>
                      <Td className="font-mono text-[0.8125rem]">{order.phone || "-"}</Td>
                      <Td>{order.label || `${order.volume || "-"}MB`}</Td>
                      <Td className="tabular">{formatMoney(order.amount || 0)}</Td>
                      <Td>
                        <Badge tone={statusTone(order.status)} dot>
                          {statusLabel(order.status)}
                        </Badge>
                      </Td>
                      <Td>{formatDate(order.timestamp || order.createdAt)}</Td>
                      <Td>
                        <a
                          href={reportLink(order)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={buttonVariants("subtle", "sm")}
                        >
                          <MessageCircle className="size-3.5" aria-hidden />
                          Report
                        </a>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>

            {/* Mobile stacked cards */}
            <div className="flex flex-col gap-2 md:hidden">
              {rows.map((order, index) => (
                <div
                  key={order.reference || index}
                  className="rounded-lg border border-border bg-surface-soft p-3.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className="truncate font-mono text-[0.8125rem] font-medium text-ink"
                      title={order.reference || ""}
                    >
                      {order.reference || "-"}
                    </span>
                    <Badge tone={statusTone(order.status)} dot>
                      {statusLabel(order.status)}
                    </Badge>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-sm text-ink-soft">
                    <NetworkDot network={order.network} />
                    <span>{String(order.network || "-").toUpperCase()}</span>
                    <span className="text-muted">·</span>
                    <span>{order.label || `${order.volume || "-"}MB`}</span>
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-3">
                    <div className="text-xs text-muted">
                      <div className="font-mono">{order.phone || "-"}</div>
                      <div className="tabular">
                        {formatDate(order.timestamp || order.createdAt)}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <span className="text-sm font-semibold tabular text-ink">
                        {formatMoney(order.amount || 0)}
                      </span>
                      <a
                        href={reportLink(order)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonVariants("subtle", "sm")}
                      >
                        <MessageCircle className="size-3.5" aria-hidden />
                        Report
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </>
  );
}
