"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, useFieldId } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { PageHero } from "@/components/layout/page-hero";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { NetworkDot } from "@/components/ui/network-dot";
import { useToast } from "@/contexts/toast-context";
import { useAsyncData } from "@/hooks/use-async-data";
import { ApiError } from "@/types/api";
import { ADMIN_NETWORKS, ADMIN_PROVIDERS, PROVIDER_MAPPING_FIELDS } from "@/types/admin";
import type { AdminPackage, ProviderRouting } from "@/types/admin";
import {
  getAdminPackages,
  getProviderHealth,
  getProviderRouting,
  updateAdminPackages,
  updateProviderRouting,
} from "@/services/admin";
import { formatDate } from "@/lib/format";

/* --------------------------- Editable package row -------------------------- */

interface EditRow {
  _key: string;
  id: string;
  label: string;
  volume: string;
  userPrice: string;
  agentPrice: string;
  sortOrder: string;
  enabled: boolean;
  providerMappings: Record<string, unknown>;
  /** Fields the backend says are blank for the active provider (server truth). */
  mappingMissing: string[];
  /** Mapping edited since the last load, so the server verdict is stale. */
  mappingDirty: boolean;
}

function toEditRow(p: AdminPackage): EditRow {
  return {
    _key: p.id || (globalThis.crypto?.randomUUID?.() ?? String(Math.random())),
    id: p.id || "",
    label: p.label || "",
    volume: p.volume != null ? String(p.volume) : "",
    userPrice: p.userPrice != null ? String(p.userPrice) : "",
    agentPrice: p.agentPrice != null ? String(p.agentPrice) : "",
    sortOrder: p.sortOrder != null ? String(p.sortOrder) : "",
    enabled: p.enabled !== false,
    providerMappings: (p.providerMappings as Record<string, unknown>) || {},
    mappingMissing: Array.isArray(p.mappingMissing) ? p.mappingMissing : [],
    mappingDirty: false,
  };
}

function toPackage(r: EditRow): AdminPackage {
  return {
    id: r.id || undefined,
    label: r.label,
    volume: Number(r.volume) || 0,
    userPrice: Number(r.userPrice) || 0,
    agentPrice: Number(r.agentPrice) || 0,
    sortOrder: Number(r.sortOrder) || 0,
    enabled: r.enabled,
    providerMappings: r.providerMappings,
  } as AdminPackage;
}

/** Pull one provider's mapping values out of a package, as editable strings. */
function readProviderFields(
  providerMappings: Record<string, unknown> | undefined,
  provider: string,
): Record<string, string> {
  const mapping = (providerMappings?.[provider] as Record<string, unknown>) ?? {};
  const fields = PROVIDER_MAPPING_FIELDS[provider] ?? [];
  return Object.fromEntries(fields.map((f) => [f.key, String(mapping[f.key] ?? "")]));
}

/* ------------------------------ Health render ------------------------------ */

function HealthEntries({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data || {});
  if (!entries.length) {
    return <p className="text-xs text-muted">No data.</p>;
  }
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="col-span-2 flex items-baseline justify-between gap-3 border-b border-border/60 py-1 last:border-0">
          <dt className="shrink-0 capitalize text-muted">{key.replace(/_/g, " ")}</dt>
          <dd className="truncate text-right font-medium text-ink-soft" title={typeof value === "object" ? JSON.stringify(value) : String(value)}>
            {typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------------- Page ----------------------------------- */

export default function AdminCatalogPage() {
  const toast = useToast();
  const [network, setNetwork] = useState<string>(ADMIN_NETWORKS[0]);

  const packagesQuery = useAsyncData(() => getAdminPackages(network), [network]);
  const routingQuery = useAsyncData(getProviderRouting, []);
  const healthQuery = useAsyncData(getProviderHealth, []);

  const [rows, setRows] = useState<EditRow[]>([]);
  const [savingPackages, setSavingPackages] = useState(false);
  const [mappingKey, setMappingKey] = useState<string | null>(null);
  const [mappingFields, setMappingFields] = useState<Record<string, string>>({});
  const [mappingText, setMappingText] = useState("");
  const [showRawMapping, setShowRawMapping] = useState(false);

  const [routingDraft, setRoutingDraft] = useState<ProviderRouting>({});
  const [savingRouting, setSavingRouting] = useState(false);

  // Re-seed the editable rows whenever a fresh catalog payload arrives.
  useEffect(() => {
    if (packagesQuery.data) {
      // Syncing loaded server data into local editable state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRows(packagesQuery.data.packages.map(toEditRow));
    }
  }, [packagesQuery.data]);

  // Seed routing draft from the loaded config.
  useEffect(() => {
    if (routingQuery.data) {
      // Syncing loaded server data into local editable state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRoutingDraft({ ...routingQuery.data.routing });
    }
  }, [routingQuery.data]);

  const activeProvider = packagesQuery.data?.activeProvider || "";

  const updateRow = (key: string, patch: Partial<EditRow>) => {
    setRows((prev) => prev.map((r) => (r._key === key ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        _key: globalThis.crypto?.randomUUID?.() ?? String(Math.random()),
        id: "",
        label: "",
        volume: "",
        userPrice: "",
        agentPrice: "",
        sortOrder: "",
        enabled: false,
        providerMappings: {},
        mappingMissing: [],
        mappingDirty: true,
      },
    ]);
  };

  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r._key !== key));

  const savePackages = async () => {
    const payload = rows.filter((r) => Number(r.volume) > 0).map(toPackage);
    if (!payload.length) {
      toast.error("Add at least one package with a volume greater than 0");
      return;
    }
    setSavingPackages(true);
    try {
      await updateAdminPackages(network, payload);
      toast.success("Catalog saved");
      await packagesQuery.reload();
    } catch (err) {
      toast.error(err instanceof ApiError || err instanceof Error ? err.message : "Failed to save catalog");
    } finally {
      setSavingPackages(false);
    }
  };

  const openMapping = (row: EditRow) => {
    setMappingKey(row._key);
    setMappingFields(readProviderFields(row.providerMappings, activeProvider));
    setMappingText(JSON.stringify(row.providerMappings ?? {}, null, 2));
    setShowRawMapping(false);
  };

  /**
   * Merge the edited fields back over the row's existing mapping. Only the
   * active provider's fields are touched, so a package that also carries a
   * mapping for another provider keeps it.
   */
  const saveMapping = () => {
    if (!mappingKey) return;

    let next: Record<string, unknown>;
    if (showRawMapping) {
      try {
        next = mappingText.trim() ? (JSON.parse(mappingText) as Record<string, unknown>) : {};
      } catch {
        toast.error("Provider mapping is not valid JSON");
        return;
      }
    } else {
      if (!activeProvider) {
        toast.error("Set a provider for this network under Provider routing first");
        return;
      }
      const row = rows.find((r) => r._key === mappingKey);
      const base = { ...(row?.providerMappings ?? {}) } as Record<string, unknown>;
      const existing = (base[activeProvider] as Record<string, unknown>) ?? {};
      next = {
        ...base,
        [activeProvider]: { ...existing, ...mappingFields },
      };
    }

    updateRow(mappingKey, { providerMappings: next, mappingDirty: true });
    setMappingKey(null);
    toast.info("Mapping staged — remember to save the catalog");
  };

  const saveRouting = async () => {
    setSavingRouting(true);
    try {
      const saved = await updateProviderRouting(routingDraft);
      setRoutingDraft({ ...saved.routing });
      toast.success("Provider routing updated");
      await Promise.all([packagesQuery.reload(), healthQuery.reload()]);
    } catch (err) {
      toast.error(err instanceof ApiError || err instanceof Error ? err.message : "Failed to update routing");
    } finally {
      setSavingRouting(false);
    }
  };

  const networkOptions = useMemo(
    () => ADMIN_NETWORKS.map((n) => ({ value: n, label: n.toUpperCase() })),
    [],
  );

  const netId = useFieldId("catalog-network");

  return (
    <>
      <PageHero
        title="Catalog"
        description="Packages, pricing, provider routing and health."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void packagesQuery.reload();
              void routingQuery.reload();
              void healthQuery.reload();
            }}
          >
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        }
      />

      {/* Provider routing */}
      <Card className="flex flex-col gap-4">
        <CardHeader
          title="Provider routing"
          description="Which upstream provider fulfils each network."
        />
        {routingQuery.loading && !routingQuery.data ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : routingQuery.error ? (
          <ErrorState message={routingQuery.error} onRetry={routingQuery.reload} />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {ADMIN_NETWORKS.map((net) => (
                <div key={net} className="rounded-lg border border-border p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink">
                    <NetworkDot network={net} />
                    {net.toUpperCase()}
                  </p>
                  <Select
                    aria-label={`Provider for ${net}`}
                    className="h-10"
                    value={routingDraft[net] || ""}
                    onChange={(e) => setRoutingDraft((prev) => ({ ...prev, [net]: e.target.value }))}
                  >
                    <option value="" disabled>
                      Select provider
                    </option>
                    {ADMIN_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted">
                {routingQuery.data?.updatedAt
                  ? `Last updated ${formatDate(routingQuery.data.updatedAt)}`
                  : "Not yet configured"}
              </p>
              <Button variant="primary" size="sm" onClick={saveRouting} loading={savingRouting}>
                <Save className="size-4" />
                Save routing
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* Packages */}
      <Card className="flex flex-col gap-4">
        <CardHeader
          title="Packages"
          description="Edit prices and availability. Disabled rows can skip provider mapping."
          action={
            <Field label="Network" htmlFor={netId} className="w-40">
              <Select
                id={netId}
                className="h-10"
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
              >
                {networkOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          }
        />

        {activeProvider ? (
          <p className="text-xs text-muted">
            Active provider for {network.toUpperCase()}: <span className="font-medium text-ink-soft capitalize">{activeProvider}</span>
          </p>
        ) : null}

        {packagesQuery.loading && !packagesQuery.data ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : packagesQuery.error ? (
          <ErrorState message={packagesQuery.error} onRetry={packagesQuery.reload} />
        ) : (
          <>
            <TableWrap>
              <Table className="min-w-[54rem]">
                <thead>
                  <tr>
                    <Th>Label</Th>
                    <Th>Volume (MB)</Th>
                    <Th>User price</Th>
                    <Th>Agent price</Th>
                    <Th>Sort</Th>
                    <Th>Enabled</Th>
                    <Th>Mapping</Th>
                    <Th className="text-right">Remove</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <Td colSpan={8}>
                        <EmptyState title="No packages" description="Add a package to get started." />
                      </Td>
                    </tr>
                  ) : (
                    rows.map((r) => {
                      // Server truth, not "does the key exist": a row can carry
                      // a godsway mapping whose networkKey is blank, which the
                      // save path rejects. Locally-edited mappings are unverified
                      // until the next save+reload, so they say so.
                      const mappingBadge = r.mappingDirty
                        ? { tone: "info" as const, text: "Edited", title: "Save the catalog to verify this mapping" }
                        : r.mappingMissing.length === 0
                          ? { tone: "success" as const, text: "Mapped", title: `Complete for ${activeProvider}` }
                          : {
                              tone: "warning" as const,
                              text: `Missing ${r.mappingMissing.join(", ")}`,
                              title: `${activeProvider} needs ${r.mappingMissing.join(" and ")} — click to set`,
                            };
                      return (
                        <tr key={r._key}>
                          <Td className="min-w-[8rem]">
                            <Input
                              aria-label="Label"
                              className="h-9"
                              value={r.label}
                              onChange={(e) => updateRow(r._key, { label: e.target.value })}
                            />
                          </Td>
                          <Td className="w-28">
                            <Input
                              type="number"
                              aria-label="Volume in MB"
                              className="h-9"
                              value={r.volume}
                              onChange={(e) => updateRow(r._key, { volume: e.target.value })}
                            />
                          </Td>
                          <Td className="w-28">
                            <Input
                              type="number"
                              step="0.01"
                              aria-label="User price"
                              className="h-9"
                              value={r.userPrice}
                              onChange={(e) => updateRow(r._key, { userPrice: e.target.value })}
                            />
                          </Td>
                          <Td className="w-28">
                            <Input
                              type="number"
                              step="0.01"
                              aria-label="Agent price"
                              className="h-9"
                              value={r.agentPrice}
                              onChange={(e) => updateRow(r._key, { agentPrice: e.target.value })}
                            />
                          </Td>
                          <Td className="w-20">
                            <Input
                              type="number"
                              aria-label="Sort order"
                              className="h-9"
                              value={r.sortOrder}
                              onChange={(e) => updateRow(r._key, { sortOrder: e.target.value })}
                            />
                          </Td>
                          <Td>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={r.enabled}
                              onClick={() => updateRow(r._key, { enabled: !r.enabled })}
                              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${r.enabled ? "bg-brand" : "bg-surface-muted"}`}
                            >
                              <span
                                className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${r.enabled ? "translate-x-6" : "translate-x-1"}`}
                              />
                            </button>
                          </Td>
                          <Td>
                            <button
                              type="button"
                              onClick={() => openMapping(r)}
                              className="inline-flex items-center gap-1.5"
                              title={mappingBadge.title}
                            >
                              <Badge tone={mappingBadge.tone}>{mappingBadge.text}</Badge>
                            </button>
                          </Td>
                          <Td className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeRow(r._key)}
                              aria-label="Remove package"
                            >
                              <Trash2 className="size-4 text-danger" />
                            </Button>
                          </Td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </Table>
            </TableWrap>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button variant="secondary" size="sm" onClick={addRow}>
                <Plus className="size-4" />
                Add package
              </Button>
              <Button variant="primary" size="sm" onClick={savePackages} loading={savingPackages}>
                <Save className="size-4" />
                Save catalog
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* Provider health */}
      <Card className="flex flex-col gap-4">
        <CardHeader
          title="Provider health"
          description="Upstream status and order-sync summary."
          action={
            <Button variant="ghost" size="sm" onClick={healthQuery.reload} loading={healthQuery.loading}>
              <Activity className="size-4" />
              Check
            </Button>
          }
        />
        {healthQuery.loading && !healthQuery.data ? (
          <Skeleton className="h-32 rounded-lg" />
        ) : healthQuery.error ? (
          <ErrorState message={healthQuery.error} onRetry={healthQuery.reload} />
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {Object.entries(healthQuery.data?.providers ?? {}).map(([provider, info]) => (
              <div key={provider} className="rounded-lg border border-border bg-surface-soft p-4">
                <p className="mb-2 text-sm font-semibold capitalize text-ink">{provider}</p>
                <HealthEntries data={info as Record<string, unknown>} />
              </div>
            ))}
            {healthQuery.data?.sync ? (
              <div className="rounded-lg border border-border bg-surface-soft p-4 md:col-span-3">
                <p className="mb-2 text-sm font-semibold text-ink">Order sync</p>
                <HealthEntries data={healthQuery.data.sync} />
              </div>
            ) : null}
          </div>
        )}
      </Card>

      {/* Provider mapping editor */}
      <Modal
        open={mappingKey !== null}
        onClose={() => setMappingKey(null)}
        title="Provider mapping"
        description={
          activeProvider
            ? `What ${activeProvider} needs to fulfil this package on ${network.toUpperCase()}.`
            : "Values used by the upstream provider."
        }
        size="lg"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setMappingKey(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={saveMapping}>
              Apply
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {showRawMapping ? (
            <textarea
              value={mappingText}
              onChange={(e) => setMappingText(e.target.value)}
              spellCheck={false}
              rows={14}
              aria-label="Provider mapping JSON"
              className="w-full rounded-md border border-border bg-surface p-3 font-mono text-xs text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
            />
          ) : (
            <div className="flex flex-col gap-4">
              {(PROVIDER_MAPPING_FIELDS[activeProvider] ?? []).map((field) => (
                <Field
                  key={field.key}
                  label={field.label}
                  hint={field.hint}
                  htmlFor={`mapping-${field.key}`}
                >
                  <Input
                    id={`mapping-${field.key}`}
                    value={mappingFields[field.key] ?? ""}
                    onChange={(e) =>
                      setMappingFields((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    spellCheck={false}
                  />
                </Field>
              ))}
              {(PROVIDER_MAPPING_FIELDS[activeProvider] ?? []).length === 0 ? (
                <p className="text-sm text-muted">
                  No active provider for this network yet — set one under Provider routing first, or
                  edit the raw JSON below.
                </p>
              ) : null}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowRawMapping((v) => !v)}
            className="self-start text-xs font-medium text-muted underline underline-offset-2 hover:text-ink-soft"
          >
            {showRawMapping ? "Back to fields" : "Edit raw JSON (all providers)"}
          </button>
        </div>
      </Modal>
    </>
  );
}
