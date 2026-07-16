"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHero } from "@/components/layout/page-hero";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { Modal } from "@/components/ui/modal";
import { FilterSelect, FilterToolbar, SearchInput } from "@/components/admin/filters";
import { Pagination } from "@/components/admin/pagination";
import { SortHeader } from "@/components/admin/sort-header";
import { RowActions } from "@/components/admin/row-actions";
import { DetailGrid, DetailRow, DetailSection } from "@/components/admin/detail";
import { cn } from "@/lib/cn";
import { formatDate, formatMoney, shortRef } from "@/lib/format";
import { statusLabel } from "@/components/ui/badge";
import { useAdminData } from "@/contexts/admin-data-context";
import { useTable } from "@/hooks/use-table";
import type { AdminTransaction, AdminUser } from "@/types/admin";

function refOf(tx: AdminTransaction): string {
  const details = tx.details ?? {};
  return String(tx.reference || details.reference || tx.mutationId || "");
}

export default function AdminTransactionsPage() {
  const { overview, loading, error, reload } = useAdminData();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [viewTx, setViewTx] = useState<AdminTransaction | null>(null);

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

  const typeOptions = useMemo(() => {
    const types = new Set<string>();
    (overview?.transactions ?? []).forEach((t) => {
      if (t.type) types.add(String(t.type));
    });
    return [
      { value: "all", label: "All types" },
      ...Array.from(types)
        .sort()
        .map((t) => ({ value: t, label: statusLabel(t) })),
    ];
  }, [overview]);

  const filtered = useMemo(() => {
    const txs = overview?.transactions ?? [];
    const term = search.trim().toLowerCase();
    return txs.filter((t) => {
      if (type !== "all" && String(t.type || "") !== type) return false;
      if (!term) return true;
      return [nameFor(t.userId), t.type, refOf(t)]
        .map((v) => String(v || "").toLowerCase())
        .some((v) => v.includes(term));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, search, type]);

  const table = useTable<AdminTransaction>(
    filtered,
    {
      date: (t) => Number(t.timestamp || 0),
      amount: (t) => Number(t.amount || 0),
      type: (t) => t.type || "",
    },
    { pageSize: 25, initialSort: { key: "date", dir: "desc" } },
  );

  return (
    <>
      <PageHero
        title="Transactions"
        description="Every wallet credit, debit and adjustment."
        actions={
          <Button variant="secondary" size="sm" onClick={reload} loading={loading}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        }
      />

      <Card className="flex flex-col gap-4">
        <CardHeader
          title={`${filtered.length} ${filtered.length === 1 ? "transaction" : "transactions"}`}
          action={
            <FilterToolbar>
              <SearchInput value={search} onChange={setSearch} placeholder="Name, reference or type" />
              <FilterSelect label="Type" value={type} onChange={(e) => setType(e.target.value)} options={typeOptions} />
            </FilterToolbar>
          }
        />

        {loading && !overview ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : filtered.length === 0 ? (
          <EmptyState title="No matching transactions" description="Adjust your filters." />
        ) : (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <SortHeader label="Type" sortKey="type" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <Th>User</Th>
                    <SortHeader label="Amount" sortKey="amount" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} align="right" />
                    <Th className="text-right">Balance</Th>
                    <Th>Reference</Th>
                    <SortHeader label="Date" sortKey="date" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {table.pageRows.map((t) => {
                    const amount = Number(t.amount || 0);
                    return (
                      <tr key={t.id} className="transition-colors hover:bg-surface-soft/60">
                        <Td>
                          <Badge tone="neutral">{statusLabel(t.type)}</Badge>
                        </Td>
                        <Td className="max-w-[10rem] truncate text-ink-soft">{nameFor(t.userId)}</Td>
                        <Td className={cn("text-right font-medium tabular", amount < 0 ? "text-danger" : "text-success")}>
                          {amount < 0 ? "-" : "+"}
                          {formatMoney(Math.abs(amount))}
                        </Td>
                        <Td className="text-right tabular text-ink-soft">{formatMoney(t.balance)}</Td>
                        <Td className="font-mono text-xs text-muted" title={refOf(t)}>{shortRef(refOf(t), 16)}</Td>
                        <Td className="whitespace-nowrap">{formatDate(t.timestamp)}</Td>
                        <Td className="text-right">
                          <RowActions onView={() => setViewTx(t)} />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
            <Pagination
              page={table.page}
              pageCount={table.pageCount}
              from={table.from}
              to={table.to}
              total={table.total}
              noun="transactions"
              onPage={table.setPage}
            />
          </>
        )}
      </Card>

      {/* Transaction detail */}
      <Modal
        open={Boolean(viewTx)}
        onClose={() => setViewTx(null)}
        title="Transaction details"
        description={viewTx ? nameFor(viewTx.userId) : undefined}
        size="md"
        footer={
          <Button variant="ghost" size="sm" onClick={() => setViewTx(null)}>
            Close
          </Button>
        }
      >
        {viewTx ? (
          <div className="flex flex-col gap-5">
            <DetailSection title="Transaction">
              <DetailGrid>
                <DetailRow label="Type" value={statusLabel(viewTx.type)} />
                <DetailRow
                  label="Amount"
                  value={
                    <span className={cn("font-semibold tabular", Number(viewTx.amount) < 0 ? "text-danger" : "text-success")}>
                      {Number(viewTx.amount) < 0 ? "-" : "+"}
                      {formatMoney(Math.abs(Number(viewTx.amount || 0)))}
                    </span>
                  }
                />
                <DetailRow label="Balance after" value={<span className="tabular">{formatMoney(viewTx.balance)}</span>} />
                <DetailRow label="Date" value={formatDate(viewTx.timestamp)} />
                <DetailRow label="Reference" value={refOf(viewTx)} mono full />
              </DetailGrid>
            </DetailSection>
            {viewTx.details && Object.keys(viewTx.details).length > 0 ? (
              <DetailSection title="Metadata">
                <DetailGrid>
                  {Object.entries(viewTx.details).map(([key, value]) => (
                    <DetailRow
                      key={key}
                      label={key.replace(/_/g, " ")}
                      value={typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "—")}
                      full
                    />
                  ))}
                </DetailGrid>
              </DetailSection>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
