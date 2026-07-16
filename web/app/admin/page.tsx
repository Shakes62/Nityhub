"use client";

import { useMemo } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { Badge, statusLabel, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { NetworkDot } from "@/components/ui/network-dot";
import { PageHero } from "@/components/layout/page-hero";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { formatDate, formatMoney } from "@/lib/format";
import { useAdminData } from "@/contexts/admin-data-context";

/** Local midnight in ms, for "today" counters. */
function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export default function AdminOverviewPage() {
  const { overview, loading, error, reload } = useAdminData();

  const stats = useMemo(() => {
    if (!overview) {
      return null;
    }
    const { users, walletsMap, orders, transactions, afa } = overview;
    const todayStart = startOfToday();
    const delivered = orders.filter((o) => o.status === "delivered");
    const active = orders.filter((o) => ["pending", "accepted", "processing"].includes(o.status || ""));
    const failed = orders.filter((o) => ["failed", "cancelled"].includes(o.status || ""));
    const todayOrders = orders.filter((o) => Number(o.timestamp || o.createdAt || 0) >= todayStart);
    const walletTotal = Object.values(walletsMap).reduce((sum, w) => sum + Number(w.balance || 0), 0);
    const revenue = delivered.reduce((sum, o) => sum + Number(o.amount || 0), 0);
    return {
      userCount: users.length,
      adminCount: users.filter((u) => u.isadmin).length,
      agentCount: users.filter((u) => u.isagent).length,
      walletTotal,
      orderCount: orders.length,
      deliveredCount: delivered.length,
      activeCount: active.length,
      failedCount: failed.length,
      todayOrderCount: todayOrders.length,
      todaySales: todayOrders
        .filter((o) => o.status === "delivered")
        .reduce((sum, o) => sum + Number(o.amount || 0), 0),
      revenue,
      txCount: transactions.length,
      afaCount: afa.length,
    };
  }, [overview]);

  const recentOrders = useMemo(() => (overview?.orders ?? []).slice(0, 8), [overview]);

  return (
    <>
      <PageHero
        title="Overview"
        description="Live snapshot of accounts, orders and revenue."
        actions={
          <Button variant="secondary" size="sm" onClick={reload} loading={loading}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        }
      />

      {error ? (
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Users" value={String(stats?.userCount ?? 0)} meta={`${stats?.adminCount ?? 0} admins · ${stats?.agentCount ?? 0} agents`} loading={loading} />
            <Stat label="Wallet float" value={formatMoney(stats?.walletTotal)} meta="Total user balances" loading={loading} />
            <Stat label="Revenue" value={formatMoney(stats?.revenue)} meta="Delivered orders" loading={loading} />
            <Stat label="Orders" value={String(stats?.orderCount ?? 0)} meta={`${stats?.activeCount ?? 0} active · ${stats?.failedCount ?? 0} failed`} loading={loading} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Today's orders" value={String(stats?.todayOrderCount ?? 0)} meta="Placed today" loading={loading} />
            <Stat label="Today's sales" value={formatMoney(stats?.todaySales)} meta="Delivered today" loading={loading} />
            <Stat label="Transactions" value={String(stats?.txCount ?? 0)} meta="All-time ledger" loading={loading} />
            <Stat label="AFA registrations" value={String(stats?.afaCount ?? 0)} meta="All-time" loading={loading} />
          </div>

          <Card className="flex flex-col gap-4">
            <CardHeader
              title="Recent orders"
              action={
                <Link href="/admin/orders" className="text-sm font-medium text-brand-strong hover:underline">
                  View all
                </Link>
              }
            />
            {loading ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-11 rounded-lg" />
                ))}
              </div>
            ) : recentOrders.length === 0 ? (
              <EmptyState title="No orders yet" description="Orders will appear here as customers buy bundles." />
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>Reference</Th>
                      <Th>Network</Th>
                      <Th>Bundle</Th>
                      <Th className="text-right">Amount</Th>
                      <Th>Status</Th>
                      <Th>Date</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.map((order) => (
                      <tr key={order.id} className="transition-colors hover:bg-surface-soft/60">
                        <Td className="font-mono text-[0.8125rem] font-medium text-ink" title={order.reference}>
                          {order.reference || "-"}
                        </Td>
                        <Td>
                          <span className="inline-flex items-center gap-1.5">
                            <NetworkDot network={order.network} />
                            {String(order.network || "-").toUpperCase()}
                          </span>
                        </Td>
                        <Td>{order.label || `${order.volume || "-"}MB`}</Td>
                        <Td className="text-right tabular">{formatMoney(order.amount)}</Td>
                        <Td>
                          <div className="flex flex-col items-start gap-1">
                            <Badge tone={statusTone(order.status)} dot>
                              {statusLabel(order.status)}
                            </Badge>
                            {order.providerStatusDescription || order.providerStatusRaw ? (
                              <span
                                className="max-w-[11rem] truncate text-xs text-muted"
                                title={order.providerStatusRaw || order.providerStatusDescription}
                              >
                                {order.providerStatusDescription || order.providerStatusRaw}
                              </span>
                            ) : null}
                          </div>
                        </Td>
                        <Td>{formatDate(order.timestamp || order.createdAt)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Card>
        </>
      )}
    </>
  );
}
