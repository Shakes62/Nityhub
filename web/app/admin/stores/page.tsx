"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { PageHero } from "@/components/layout/page-hero";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/field";
import { Stat } from "@/components/ui/stat";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { useToast } from "@/contexts/toast-context";
import { useAsyncData } from "@/hooks/use-async-data";
import { getAdminStorefronts, setStorefrontSuspended, type AdminStorefront } from "@/services/admin";
import { formatDate, formatMoney } from "@/lib/format";
import { errorMessage } from "@/lib/errors";

/** Reseller eStores across the platform, with sales and a suspend switch. */
export default function AdminStoresPage() {
  const toast = useToast();
  const stores = useAsyncData(getAdminStorefronts, []);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<AdminStorefront | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    const list = stores.data ?? [];
    return term ? list.filter((s) => `${s.name} ${s.slug} ${s.ownerUid} ${s.whatsapp}`.toLowerCase().includes(term)) : list;
  }, [stores.data, query]);

  const totals = useMemo(() => (stores.data ?? []).reduce(
    (sum, s) => ({ sales: sum.sales + s.stats.sales, profit: sum.profit + s.stats.profit, revenue: sum.revenue + s.stats.revenue }),
    { sales: 0, profit: 0, revenue: 0 },
  ), [stores.data]);

  const toggle = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await setStorefrontSuspended(pending.slug, !pending.suspended);
      toast.success(pending.suspended ? "Store restored" : "Store suspended");
      setPending(null);
      void stores.reload();
    } catch (error) {
      toast.error(errorMessage(error, "Could not update the store."));
    } finally {
      setBusy(false);
    }
  };

  const loading = stores.loading && !stores.data;

  return (
    <>
      <PageHero title="eStores" description="Reseller storefronts, their sales, and moderation." />

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Stores" value={stores.data?.length ?? 0} loading={loading} />
        <Stat label="Sales delivered" value={totals.sales} loading={loading} />
        <Stat label="Sales value" value={formatMoney(totals.revenue)} loading={loading} />
        <Stat label="Reseller profit paid" value={formatMoney(totals.profit)} loading={loading} />
      </div>

      <Card className="flex flex-col gap-4">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input className="pl-9" placeholder="Search name, address, owner…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search stores" />
        </div>
        {stores.error ? (
          <ErrorState message={stores.error} onRetry={stores.reload} />
        ) : loading ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : rows.length === 0 ? (
          <EmptyState title="No stores" description={query ? "No store matches that search." : "No reseller has opened a store yet."} />
        ) : (
          <TableWrap>
            <Table className="min-w-[48rem]">
              <thead>
                <tr><Th>Store</Th><Th>Status</Th><Th>Margins</Th><Th>Sales</Th><Th>Profit paid</Th><Th>Created</Th><Th /></tr>
              </thead>
              <tbody>
                {rows.map((store) => (
                  <tr key={store.slug}>
                    <Td>
                      <span className="block font-medium text-ink">{store.name}</span>
                      <span className="block font-mono text-xs text-muted">{store.slug}{store.customDomain ? ` · ${store.customDomain}` : ""}</span>
                    </Td>
                    <Td>
                      {store.suspended ? <Badge tone="danger">Suspended</Badge>
                        : store.paused ? <Badge tone="warning">Paused by owner</Badge>
                        : <Badge tone="success">Live</Badge>}
                    </Td>
                    <Td className="text-xs tabular">
                      MTN {formatMoney(store.margins.mtn || 0)} · TEL {formatMoney(store.margins.telecel || 0)} · AT {formatMoney(store.margins.at || 0)}
                    </Td>
                    <Td className="tabular">{store.stats.sales}</Td>
                    <Td className="tabular">{formatMoney(store.stats.profit)}</Td>
                    <Td>{formatDate(store.createdAt)}</Td>
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <a href={store.storeUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants("ghost", "sm")} aria-label={`Open ${store.name}`}>
                          <ExternalLink className="size-4" aria-hidden />
                        </a>
                        <Button variant={store.suspended ? "secondary" : "ghost"} size="sm" onClick={() => setPending(store)}>
                          {store.suspended ? "Restore" : "Suspend"}
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(pending)}
        onCancel={() => (busy ? undefined : setPending(null))}
        onConfirm={toggle}
        title={pending?.suspended ? `Restore ${pending?.name}?` : `Suspend ${pending?.name}?`}
        description={pending?.suspended
          ? "The store goes live again immediately."
          : "Buyers will see that the store is unavailable. Orders already paid still complete."}
        confirmLabel={pending?.suspended ? "Restore" : "Suspend"}
        confirmVariant={pending?.suspended ? "primary" : "danger"}
      />
    </>
  );
}
