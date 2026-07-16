"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHero } from "@/components/layout/page-hero";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { Modal } from "@/components/ui/modal";
import { FilterToolbar, SearchInput } from "@/components/admin/filters";
import { Pagination } from "@/components/admin/pagination";
import { SortHeader } from "@/components/admin/sort-header";
import { RowActions } from "@/components/admin/row-actions";
import { DetailGrid, DetailRow, DetailSection } from "@/components/admin/detail";
import { formatDate, formatMoney, shortRef } from "@/lib/format";
import { useAdminData } from "@/contexts/admin-data-context";
import { useTable } from "@/hooks/use-table";
import type { AdminAfaRegistration } from "@/types/admin";

export default function AdminAfaPage() {
  const { overview, loading, error, reload } = useAdminData();
  const [search, setSearch] = useState("");
  const [viewAfa, setViewAfa] = useState<AdminAfaRegistration | null>(null);

  const filtered = useMemo(() => {
    const rows = overview?.afa ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) =>
      [r.fullname, r.phone, r.location, r.ghanaCard, r.userId]
        .map((v) => String(v || "").toLowerCase())
        .some((v) => v.includes(term)),
    );
  }, [overview, search]);

  const table = useTable<AdminAfaRegistration>(
    filtered,
    {
      name: (r) => (r.fullname || "").toLowerCase(),
      location: (r) => (r.location || "").toLowerCase(),
      fee: (r) => Number(r.fee || 0),
      date: (r) => Number(r.timestamp || 0),
    },
    { pageSize: 25, initialSort: { key: "date", dir: "desc" } },
  );

  return (
    <>
      <PageHero
        title="AFA registrations"
        description="Agent/AFA sign-ups submitted by customers."
        actions={
          <Button variant="secondary" size="sm" onClick={reload} loading={loading}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        }
      />

      <Card className="flex flex-col gap-4">
        <CardHeader
          title={`${filtered.length} ${filtered.length === 1 ? "registration" : "registrations"}`}
          action={
            <FilterToolbar>
              <SearchInput value={search} onChange={setSearch} placeholder="Name, phone, card or location" />
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
          <EmptyState title="No matching registrations" description={search ? "Adjust your search." : undefined} />
        ) : (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <SortHeader label="Full name" sortKey="name" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <Th>Phone</Th>
                    <Th>Ghana Card</Th>
                    <Th>DOB</Th>
                    <SortHeader label="Location" sortKey="location" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <SortHeader label="Fee" sortKey="fee" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} align="right" />
                    <SortHeader label="Date" sortKey="date" activeKey={table.sortKey} dir={table.sortDir} onSort={table.toggleSort} />
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {table.pageRows.map((r) => (
                    <tr key={r.id} className="transition-colors hover:bg-surface-soft/60">
                      <Td className="font-medium text-ink">{r.fullname || "-"}</Td>
                      <Td className="font-mono text-[0.8125rem]">{r.phone || "-"}</Td>
                      <Td className="font-mono text-[0.8125rem]" title={r.ghanaCard}>{shortRef(r.ghanaCard, 16)}</Td>
                      <Td>{r.dob || "-"}</Td>
                      <Td>{r.location || "-"}</Td>
                      <Td className="text-right tabular">{formatMoney(r.fee)}</Td>
                      <Td className="whitespace-nowrap">{formatDate(r.timestamp)}</Td>
                      <Td className="text-right">
                        <RowActions onView={() => setViewAfa(r)} />
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
              noun="registrations"
              onPage={table.setPage}
            />
          </>
        )}
      </Card>

      {/* Registration detail */}
      <Modal
        open={Boolean(viewAfa)}
        onClose={() => setViewAfa(null)}
        title="AFA registration"
        description={viewAfa?.fullname || undefined}
        size="md"
        footer={
          <Button variant="ghost" size="sm" onClick={() => setViewAfa(null)}>
            Close
          </Button>
        }
      >
        {viewAfa ? (
          <DetailSection title="Registration">
            <DetailGrid>
              <DetailRow label="Full name" value={viewAfa.fullname} full />
              <DetailRow label="Phone" value={viewAfa.phone} mono />
              <DetailRow label="Date of birth" value={viewAfa.dob} />
              <DetailRow label="Ghana Card" value={viewAfa.ghanaCard} mono full />
              <DetailRow label="Location" value={viewAfa.location} />
              <DetailRow label="Fee" value={<span className="tabular">{formatMoney(viewAfa.fee)}</span>} />
              <DetailRow label="Submitted" value={formatDate(viewAfa.timestamp)} full />
            </DetailGrid>
          </DetailSection>
        ) : null}
      </Modal>
    </>
  );
}
