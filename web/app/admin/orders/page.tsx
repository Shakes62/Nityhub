"use client";

import { useMemo, useState } from "react";
import { Copy, Layers, PencilLine, RefreshCw } from "lucide-react";
import { Badge, statusLabel, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { NetworkDot } from "@/components/ui/network-dot";
import { PageHero } from "@/components/layout/page-hero";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { FilterSelect, FilterToolbar, SearchInput } from "@/components/admin/filters";
import { Pagination } from "@/components/admin/pagination";
import { SortHeader } from "@/components/admin/sort-header";
import { RowActions } from "@/components/admin/row-actions";
import { DetailGrid, DetailRow, DetailSection } from "@/components/admin/detail";
import { BulkStatusModal } from "@/components/admin/bulk-status-modal";
import { OrderStatusModal } from "@/components/admin/order-status-modal";
import { formatDate, formatMoney, shortRef } from "@/lib/format";
import { useAdminData } from "@/contexts/admin-data-context";
import { useToast } from "@/contexts/toast-context";
import { useTable } from "@/hooks/use-table";
import { ADMIN_NETWORKS, ORDER_STATUSES } from "@/types/admin";
import type { AdminOrder, AdminUser } from "@/types/admin";

async function copyText(value: string, onDone: () => void) {
  try {
    await navigator.clipboard.writeText(value);
    onDone();
  } catch {
    /* clipboard unavailable — no-op */
  }
}

const NETWORK_OPTIONS = [
  { value: "all", label: "All networks" },
  ...ADMIN_NETWORKS.map((n) => ({ value: n, label: n.toUpperCase() })),
];

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  ...ORDER_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
];

export default function AdminOrdersPage() {
  const { overview, loading, error, reload } = useAdminData();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [network, setNetwork] = useState("all");
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [viewOrder, setViewOrder] = useState<AdminOrder | null>(null);
  const [statusOrder, setStatusOrder] = useState<AdminOrder | null>(null);

  // Resolve a customer by uid so we show a human name, never the raw UID.
  const usersByUid = useMemo(() => {
    const map = new Map<string, AdminUser>();
    (overview?.users ?? []).forEach((u) => map.set(u.uid, u));
    return map;
  }, [overview]);
  const nameFor = (uid?: string) => {
    const u = uid ? usersByUid.get(uid) : undefined;
    return u?.username || u?.email || "Unknown user";
  };

  const filtered = useMemo(() => {
    const orders = overview?.orders ?? [];
    const term = search.trim().toLowerCase();
    const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toMs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    return orders.filter((o) => {
      if (network !== "all" && (o.network || "").toLowerCase() !== network) return false;
      if (status !== "all" && (o.status || "") !== status) return false;
      const ts = Number(o.timestamp || o.createdAt || 0);
      if (fromMs !== null && ts < fromMs) return false;
      if (toMs !== null && ts > toMs) return false;
      if (!term) return true;
      return [o.reference, o.phone, nameFor(o.userId), o.label, o.provider, o.providerStatusDescription, o.providerStatusRaw]
        .map((v) => String(v || "").toLowerCase())
        .some((v) => v.includes(term));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, search, network, status, from, to]);

  const table = useTable<AdminOrder>(
    filtered,
    {
      date: (o) => Number(o.timestamp || o.createdAt || 0),
      amount: (o) => Number(o.amount || 0),
      status: (o) => o.status || "",
      network: (o) => o.network || "",
    },
    { pageSize: 25, initialSort: { key: "date", dir: "desc" } },
  );

  return (
    <>
      <PageHero
        title="Orders"
        description="All customer orders and fulfilment status."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setBulkOpen(true)}>
              <Layers className="size-4" />
              Bulk update
            </Button>
            <Button variant="secondary" size="sm" onClick={reload} loading={loading}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          </>
        }
      />

      <Card className="flex flex-col gap-4">
        <CardHeader title={`${filtered.length} ${filtered.length === 1 ? "order" : "orders"}`} />

        <FilterToolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Reference, phone or name" />
          <FilterSelect label="Network" value={network} onChange={(e) => setNetwork(e.target.value)} options={NETWORK_OPTIONS} />
          <FilterSelect label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_OPTIONS} />
          <Input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-10 w-full sm:w-auto" />
          <Input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} className="h-10 w-full sm:w-auto" />
        </FilterToolbar>

        {loading && !overview ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : filtered.length === 0 ? (
          <EmptyState title="No matching orders" description="Adjust your filters or date range." />
        ) : (
          <>
            <TableWrap>
              <Table className="min-w-[68rem]">
                <thead>
                  <tr>
                    <Th>Reference</Th>
                    <Th>Customer</Th>
                    <SortHeader label="Network" sortKey="network" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <Th>Phone</Th>
                    <Th>Bundle</Th>
                    <SortHeader label="Amount" sortKey="amount" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} align="right" />
                    <Th>Provider</Th>
                    <SortHeader label="Status" sortKey="status" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <Th>Delivery (provider)</Th>
                    <SortHeader label="Date" sortKey="date" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {table.pageRows.map((o) => (
                    <tr key={`${o.userId}-${o.id}`} className="transition-colors hover:bg-surface-soft/60">
                      <Td className="font-mono text-[0.8125rem] font-medium text-ink" title={o.reference}>
                        {shortRef(o.reference, 12)}
                      </Td>
                      <Td className="max-w-[10rem] truncate text-ink-soft">{nameFor(o.userId)}</Td>
                      <Td>
                        <span className="inline-flex items-center gap-1.5">
                          <NetworkDot network={o.network} />
                          {String(o.network || "-").toUpperCase()}
                        </span>
                      </Td>
                      <Td className="font-mono text-[0.8125rem]">{o.phone || "-"}</Td>
                      <Td>{o.label || `${o.volume || "-"}MB`}</Td>
                      <Td className="text-right tabular">{formatMoney(o.amount)}</Td>
                      <Td className="capitalize">{o.provider || "-"}</Td>
                      <Td>
                        <Badge tone={statusTone(o.status)} dot>
                          {statusLabel(o.status)}
                        </Badge>
                        {o.commercialReview ? <Badge tone="warning">Pricing review</Badge> : null}
                      </Td>
                      <Td className="max-w-[14rem]">
                        {o.providerStatusDescription || o.providerStatusRaw ? (
                          <span
                            className="block truncate text-[0.8125rem] text-ink-soft"
                            title={o.providerStatusRaw || o.providerStatusDescription}
                          >
                            {o.providerStatusDescription || o.providerStatusRaw}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap">{formatDate(o.timestamp || o.createdAt)}</Td>
                      <Td className="text-right">
                        <RowActions
                          onView={() => setViewOrder(o)}
                          moreItems={[
                            {
                              label: "Change status",
                              icon: <PencilLine />,
                              disabled: !o.reference,
                              onClick: () => setStatusOrder(o),
                            },
                            {
                              label: "Copy reference",
                              icon: <Copy />,
                              disabled: !o.reference,
                              onClick: () => copyText(o.reference || "", () => toast.success("Reference copied")),
                            },
                          ]}
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <Pagination
              page={table.page}
              pageCount={table.pageCount}
              from={table.from}
              to={table.to}
              total={table.total}
              noun="orders"
              onPage={table.setPage}
            />
          </>
        )}
      </Card>

      <BulkStatusModal open={bulkOpen} onClose={() => setBulkOpen(false)} onDone={reload} />

      <OrderStatusModal order={statusOrder} onClose={() => setStatusOrder(null)} onDone={reload} />

      {/* Order detail */}
      <Modal
        open={Boolean(viewOrder)}
        onClose={() => setViewOrder(null)}
        title="Order details"
        description={viewOrder ? nameFor(viewOrder.userId) : undefined}
        size="md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setViewOrder(null)}>
              Close
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!viewOrder?.reference}
              onClick={() => {
                setStatusOrder(viewOrder);
                setViewOrder(null);
              }}
            >
              <PencilLine className="size-4" />
              Change status
            </Button>
          </>
        }
      >
        {viewOrder ? (
          <div className="flex flex-col gap-5">
            <DetailSection title="Order">
              <DetailGrid>
                <DetailRow label="Reference" value={viewOrder.reference} mono full />
                <DetailRow label="Network" value={String(viewOrder.network || "—").toUpperCase()} />
                <DetailRow label="Provider" value={<span className="capitalize">{viewOrder.provider || "—"}</span>} />
                <DetailRow label="Bundle" value={viewOrder.label || `${viewOrder.volume || "—"}MB`} />
                <DetailRow label="Beneficiary" value={viewOrder.phone} mono />
                <DetailRow label="Amount" value={<span className="font-semibold tabular">{formatMoney(viewOrder.amount)}</span>} />
                <DetailRow label="Package ID" value={viewOrder.packageId} mono />
              </DetailGrid>
            </DetailSection>
            <DetailSection title="Status">
              <DetailGrid>
                <DetailRow
                  label="Order status"
                  value={<Badge tone={statusTone(viewOrder.status)} dot>{statusLabel(viewOrder.status)}</Badge>}
                />
                <DetailRow label="Payment" value={<span className="capitalize">{viewOrder.paymentStatus || "—"}</span>} />
                <DetailRow label="Provider status" value={viewOrder.providerStatusDescription} full />
                <DetailRow label="Provider status (raw)" value={viewOrder.providerStatusRaw} mono full />
              </DetailGrid>
            </DetailSection>
            <DetailSection title="Timeline">
              <DetailGrid>
                <DetailRow label="Created" value={formatDate(viewOrder.createdAt || viewOrder.timestamp)} />
                <DetailRow label="Last updated" value={formatDate(viewOrder.updatedAt)} />
              </DetailGrid>
            </DetailSection>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
