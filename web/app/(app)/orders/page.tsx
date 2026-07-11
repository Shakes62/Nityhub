"use client";

import { useMemo, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Badge, statusLabel, statusTone } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { PageHero } from "@/components/layout/page-hero";
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

  return (
    <>
      <PageHero title="Orders" description="Track every purchase and its status." />

      <Card className="flex flex-col gap-4">
        <Field label="Search" htmlFor="order-search" className="max-w-sm">
          <Input
            id="order-search"
            type="search"
            placeholder="Reference or phone"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardHeader title="History" />

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
          <TableWrap>
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
                  <tr key={order.reference || index} className="hover:bg-surface-soft">
                    <Td className="font-medium text-ink" title={order.reference || ""}>
                      {order.reference || "-"}
                    </Td>
                    <Td>{String(order.network || "-").toUpperCase()}</Td>
                    <Td>{order.phone || "-"}</Td>
                    <Td>{order.label || `${order.volume || "-"}MB`}</Td>
                    <Td>{formatMoney(order.amount || 0)}</Td>
                    <Td>
                      <Badge tone={statusTone(order.status)}>
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
                        Report
                      </a>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
