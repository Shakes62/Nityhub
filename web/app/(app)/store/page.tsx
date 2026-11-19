"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy, ExternalLink, Globe, MessageCircle, PauseCircle, Store as StoreIcon } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHero } from "@/components/layout/page-hero";
import { Field, Input } from "@/components/ui/field";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, statusLabel, statusTone } from "@/components/ui/badge";
import { Stat } from "@/components/ui/stat";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import {
  getMyStorefront,
  getMyStoreSales,
  saveMyStorefront,
  type OwnStorefront,
  type StoreSale,
} from "@/services/api";
import { NETWORKS } from "@/constants/networks";
import { SUPPORT_WHATSAPP } from "@/constants/config";
import { useToast } from "@/contexts/toast-context";
import { useLiveEvents } from "@/contexts/live-events-context";
import { formatDate, formatMoney, shortRef } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";

interface Draft {
  name: string;
  slug: string;
  tagline: string;
  whatsapp: string;
  customDomain: string;
  paused: boolean;
  margins: Record<string, string>;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  slug: "",
  tagline: "",
  whatsapp: "",
  customDomain: "",
  paused: false,
  margins: { mtn: "1", telecel: "1", at: "1" },
};

function draftFrom(store: OwnStorefront): Draft {
  return {
    name: store.name,
    slug: store.slug,
    tagline: store.tagline || "",
    whatsapp: store.whatsapp,
    customDomain: store.customDomain || "",
    paused: store.paused,
    margins: Object.fromEntries(NETWORKS.map((n) => [n.value, String(store.margins?.[n.value] ?? 0)])),
  };
}

const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 40);

export default function ManageStorePage() {
  const toast = useToast();
  const { onNotification } = useLiveEvents();
  const [store, setStore] = useState<OwnStorefront | null>(null);
  const [eligible, setEligible] = useState(false);
  const [baseDomain, setBaseDomain] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [slugTouched, setSlugTouched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [sales, setSales] = useState<StoreSale[] | null>(null);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const state = await getMyStorefront();
      setStore(state.store);
      setEligible(state.eligible);
      setBaseDomain(state.baseDomain);
      if (state.store) setDraft(draftFrom(state.store));
    } catch (error) {
      setLoadError(errorMessage(error, "Your store could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSales = useCallback(async () => {
    try {
      setSales(await getMyStoreSales());
    } catch {
      setSales((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (store) void loadSales();
  }, [store, loadSales]);

  // A sale credited while this page is open refreshes the numbers live.
  useEffect(
    () =>
      onNotification((note) => {
        if (note.type === "storefront_profit") {
          void load();
          void loadSales();
        }
      }),
    [onNotification, load, loadSales],
  );

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((old) => ({ ...old, [key]: value }));

  const previewUrl = store?.storeUrl ||
    (draft.slug ? (baseDomain ? `https://${draft.slug}.${baseDomain}` : `${typeof window === "undefined" ? "" : window.location.origin}/store/${draft.slug}`) : "");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    const margins = Object.fromEntries(NETWORKS.map((n) => [n.value, Number(draft.margins[n.value] || 0)]));
    if (Object.values(margins).some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
      setFormError("Margins must be between GHS 0 and GHS 100.");
      return;
    }
    setSaving(true);
    try {
      const updated = await saveMyStorefront({
        name: draft.name.trim(),
        slug: store ? undefined : draft.slug,
        tagline: draft.tagline.trim(),
        whatsapp: draft.whatsapp.trim(),
        customDomain: draft.customDomain.trim(),
        paused: draft.paused,
        margins,
      });
      setStore(updated);
      setDraft(draftFrom(updated));
      toast.success(store ? "Store updated" : "Your store is live!");
    } catch (error) {
      setFormError(errorMessage(error, "Could not save your store."));
    } finally {
      setSaving(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Link copied");
    } catch {
      toast.info(text);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-5">
        <PageHero title="Your eStore" description="Your own branded data shop." />
        <Skeleton className="h-40 rounded-card" />
        <Skeleton className="h-80 rounded-card" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-5">
        <PageHero title="Your eStore" />
        <Card><ErrorState message={loadError} onRetry={() => void load()} /></Card>
      </div>
    );
  }

  if (!store && !eligible) {
    return (
      <div className="flex flex-col gap-5">
        <PageHero title="Your eStore" description="Sell data under your own brand and earn on every sale." />
        <Card className="flex flex-col items-start gap-4">
          <span className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-brand">
            <StoreIcon className="size-5" aria-hidden />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-ink">eStores are for reseller accounts</h2>
            <p className="mt-1 max-w-prose text-sm text-muted">
              Resellers get wholesale prices, a branded store link to share on WhatsApp, and their margin credited to
              their wallet the moment each order is delivered. Message us to upgrade your account.
            </p>
          </div>
          <a
            href={`https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent("Hello, I'd like to become a reseller and open an eStore.")}`}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants("primary", "md")}
          >
            <MessageCircle className="size-4" aria-hidden /> Become a reseller
          </a>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="Your eStore"
        description="Buyers shop without an account. Your margin lands in your wallet when each order is delivered."
        actions={
          store ? (
            <a href={store.storeUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants("secondary", "sm")}>
              <ExternalLink className="size-4" aria-hidden /> Open store
            </a>
          ) : null
        }
      >
        {store ? (
          <div className="flex flex-wrap gap-2">
            {store.suspended ? <Badge tone="danger" dot>Suspended by NityHub</Badge>
              : store.paused ? <Badge tone="warning" dot>Paused</Badge>
              : <Badge tone="success" dot>Live</Badge>}
          </div>
        ) : null}
      </PageHero>

      {store ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Sales delivered" value={store.stats.sales} />
            <Stat label="Profit earned" value={formatMoney(store.stats.profit)} meta="Credited to your wallet" />
            <Stat label="Sales value" value={formatMoney(store.stats.revenue)} />
          </div>

          <Card className="flex flex-col gap-4">
            <CardHeader title="Share your store" description="Send this link to customers or put it in your WhatsApp status." />
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="flex min-h-11 min-w-0 flex-1 items-center rounded-md border border-border bg-surface-soft px-3.5">
                <span className="truncate font-mono text-sm text-ink">{store.storeUrl}</span>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => void copy(store.storeUrl)}>
                  <Copy className="size-4" aria-hidden /> Copy
                </Button>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(`Buy affordable data bundles from ${store.name}: ${store.storeUrl}`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants("primary", "md")}
                >
                  <MessageCircle className="size-4" aria-hidden /> Share
                </a>
              </div>
            </div>
            {store.customDomain ? (
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <Globe className="size-3.5" aria-hidden /> Also at <span className="font-mono text-ink-soft">https://{store.customDomain}</span>
              </p>
            ) : null}
          </Card>
        </>
      ) : null}

      <Card className="flex flex-col gap-5">
        <CardHeader
          title={store ? "Store settings" : "Create your store"}
          description={store ? "Changes apply to your public store immediately." : "Takes a minute. You can change everything except the address later."}
        />
        <form onSubmit={save} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Store name" htmlFor="store-name">
              <Input
                id="store-name"
                value={draft.name}
                maxLength={60}
                required
                onChange={(event) => {
                  set("name", event.target.value);
                  if (!store && !slugTouched) set("slug", slugify(event.target.value));
                }}
                placeholder="Daniel's Data"
              />
            </Field>
            <Field label="WhatsApp number" htmlFor="store-whatsapp" hint="Buyers reach you here for help.">
              <Input
                id="store-whatsapp"
                inputMode="tel"
                value={draft.whatsapp}
                onChange={(event) => set("whatsapp", event.target.value)}
                placeholder="0XXXXXXXXX"
                required
              />
            </Field>
          </div>
          <Field
            label="Store address"
            htmlFor="store-slug"
            hint={store ? "Your address is permanent." : previewUrl ? `Your store will be at ${previewUrl}` : "Lowercase letters, numbers and hyphens."}
          >
            <Input
              id="store-slug"
              value={draft.slug}
              onChange={(event) => {
                setSlugTouched(true);
                set("slug", slugify(event.target.value));
              }}
              disabled={Boolean(store)}
              required
              placeholder="daniels-data"
            />
          </Field>
          <Field label="Tagline (optional)" htmlFor="store-tagline" hint="One line shown under your store name.">
            <Input
              id="store-tagline"
              value={draft.tagline}
              maxLength={120}
              onChange={(event) => set("tagline", event.target.value)}
              placeholder="Fast, affordable bundles — delivered in minutes"
            />
          </Field>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-ink-soft">Your margin per bundle</legend>
            <p className="-mt-1 text-xs text-muted">Added on top of your wholesale price. Buyers see one final price.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {NETWORKS.map((n) => (
                <Field key={n.value} label={`${n.label} (GHS)`} htmlFor={`margin-${n.value}`}>
                  <Input
                    id={`margin-${n.value}`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="100"
                    step="0.01"
                    value={draft.margins[n.value] ?? ""}
                    onChange={(event) => setDraft((old) => ({ ...old, margins: { ...old.margins, [n.value]: event.target.value } }))}
                  />
                </Field>
              ))}
            </div>
          </fieldset>

          {store ? (
            <>
              <Field
                label="Custom domain (optional)"
                htmlFor="store-domain"
                hint="E.g. data.yourname.com. Point a CNAME record at our platform, then message support to finish setup."
              >
                <Input
                  id="store-domain"
                  value={draft.customDomain}
                  onChange={(event) => set("customDomain", event.target.value.toLowerCase().trim())}
                  placeholder="data.yourname.com"
                />
              </Field>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3.5 py-2.5">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-brand)]"
                  checked={draft.paused}
                  onChange={(event) => set("paused", event.target.checked)}
                />
                <PauseCircle className="size-4 text-muted" aria-hidden />
                <span className="text-sm text-ink">
                  Pause my store
                  <span className="block text-xs text-muted">Buyers see that the store is unavailable until you resume.</span>
                </span>
              </label>
            </>
          ) : null}

          {formError ? <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{formError}</p> : null}
          <div>
            <Button type="submit" loading={saving}>{store ? "Save changes" : "Create my store"}</Button>
          </div>
        </form>
      </Card>

      {store ? (
        <Card className="flex flex-col gap-3">
          <CardHeader title="Recent sales" description="Profit is credited automatically once delivery is confirmed." />
          {sales === null ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-12 rounded-lg" />)}
            </div>
          ) : sales.length ? (
            <ul className="divide-y divide-border">
              {sales.map((sale) => (
                <li key={sale.reference} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink">
                      {sale.label || "Bundle"} {sale.network ? `· ${NETWORKS.find((n) => n.value === sale.network)?.label || sale.network}` : ""}
                    </span>
                    <span className="block font-mono text-xs text-muted">{shortRef(sale.reference, 22)} · {formatDate(sale.createdAt)}</span>
                  </span>
                  <Badge tone={sale.status === "initialized" ? "neutral" : statusTone(sale.status)}>
                    {sale.status === "initialized" ? "Awaiting payment" : statusLabel(sale.status)}
                  </Badge>
                  <span className="w-32 text-right tabular">
                    <span className="block font-medium text-ink">{formatMoney(sale.amount)}</span>
                    <span className={cn("block text-xs", sale.creditedAt ? "text-success" : "text-muted")}>
                      {sale.creditedAt ? "+" : ""}{formatMoney(sale.profit)} profit
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted">No sales yet. Share your store link to get started.</p>
          )}
        </Card>
      ) : null}
    </div>
  );
}
