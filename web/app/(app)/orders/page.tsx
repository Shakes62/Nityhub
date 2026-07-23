"use client";

import { useMemo, useState } from "react";
import { Eye, MessageCircle, Search } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Badge, statusLabel, statusTone } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { PageHero } from "@/components/layout/page-hero";
import { NetworkDot } from "@/components/ui/network-dot";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Table, Td, Th } from "@/components/ui/table";
import { formatDate, formatMoney, shortRef } from "@/lib/format";
import { SUPPORT_WHATSAPP } from "@/constants/config";
import type { Order } from "@/types/models";
import { getUserOrders } from "@/services/api";
import { useAsyncData } from "@/hooks/use-async-data";
import { useVirtualList } from "@/hooks/use-virtual-list";

/** Fixed row height (px) — must match the `h-9` rows for virtualization. */
const ROW_H = 36;

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
  const [view, setView] = useState<Order | null>(null);

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

  const { scrollRef, items, startIndex, topPad, bottomPad } = useVirtualList(rows, ROW_H);

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
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-11 rounded-lg" />
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
          <div
            ref={scrollRef}
            className="no-scrollbar max-h-[65vh] overflow-auto rounded-lg border border-border"
          >
            <Table className="min-w-[34rem]">
              <thead className="sticky top-0 z-10">
                <tr>
                  <Th>Reference</Th>
                  <Th>Network</Th>
                  <Th>Bundle</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Status</Th>
                  <Th>Date</Th>
                  <Th className="text-right">View</Th>
                </tr>
              </thead>
              <tbody>
                {topPad > 0 ? (
                  <tr aria-hidden style={{ height: topPad }}>
                    <td colSpan={7} className="p-0" />
                  </tr>
                ) : null}
                {items.map((order, i) => (
                  <tr
                    key={order.reference || startIndex + i}
                    className="h-9 transition-colors duration-100 hover:bg-surface-soft/60"
                  >
                    <Td
                      className="py-0 font-mono text-[0.8125rem] font-medium text-ink"
                      title={order.reference || ""}
                    >
                      {shortRef(order.reference, 12)}
                    </Td>
                    <Td className="py-0">
                      <span className="inline-flex items-center gap-1.5">
                        <NetworkDot network={order.network} />
                        {String(order.network || "-").toUpperCase()}
                      </span>
                    </Td>
                    <Td className="py-0 whitespace-nowrap">{order.label || `${order.volume || "-"}MB`}</Td>
                    <Td className="py-0 text-right tabular">{formatMoney(order.amount || 0)}</Td>
                    <Td className="py-0">
                      <Badge tone={statusTone(order.status)} dot>
                        {statusLabel(order.status)}
                      </Badge>
                    </Td>
                    <Td className="py-0 whitespace-nowrap">{formatDate(order.timestamp || order.createdAt)}</Td>
                    <Td className="py-0 text-right">
                      <button
                        type="button"
                        onClick={() => setView(order)}
                        aria-label="View order"
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-muted hover:text-ink"
                      >
                        <Eye className="size-4" />
                      </button>
                    </Td>
                  </tr>
                ))}
                {bottomPad > 0 ? (
                  <tr aria-hidden style={{ height: bottomPad }}>
                    <td colSpan={7} className="p-0" />
                  </tr>
                ) : null}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      {/* Order details (full reference lives here) */}
      <Modal
        open={Boolean(view)}
        onClose={() => setView(null)}
        title="Order details"
        description={view ? String(view.network || "").toUpperCase() : undefined}
        size="sm"
        footer={
          view ? (
            <a
              href={reportLink(view)}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants("secondary", "sm")}
            >
              <MessageCircle className="size-3.5" aria-hidden />
              Report
            </a>
          ) : null
        }
      >
        {view ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div className="col-span-2">
              <dt className="text-xs text-muted">Reference</dt>
              <dd className="mt-0.5 break-all font-mono text-[0.8125rem] text-ink">{view.reference || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Network</dt>
              <dd className="mt-0.5 text-ink">{String(view.network || "—").toUpperCase()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Beneficiary</dt>
              <dd className="mt-0.5 font-mono text-ink">{view.phone || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Bundle</dt>
              <dd className="mt-0.5 text-ink">{view.label || `${view.volume || "—"}MB`}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Amount</dt>
              <dd className="mt-0.5 font-semibold tabular text-ink">{formatMoney(view.amount || 0)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Status</dt>
              <dd className="mt-0.5">
                <Badge tone={statusTone(view.status)} dot>
                  {statusLabel(view.status)}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Date</dt>
              <dd className="mt-0.5 text-ink">{formatDate(view.timestamp || view.createdAt)}</dd>
            </div>
          </dl>
        ) : null}
      </Modal>
    </>
  );
}
