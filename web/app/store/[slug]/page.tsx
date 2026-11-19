"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  Loader2,
  Lock,
  MessageCircle,
  Search,
  ShieldCheck,
  Smartphone,
  Store as StoreIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Field, Input } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { NetworkCard } from "@/components/buy/network-card";
import { DeliveryEstimate } from "@/components/buy/delivery-estimate";
import { DeliveryTicker } from "@/components/social-proof/delivery-ticker";
import { estimateFor, getStorefront, getStorePackages, startStoreCheckout, type Storefront } from "@/services/api";
import { useNetworkAvailability } from "@/hooks/use-network-availability";
import { NETWORKS, networkTheme } from "@/constants/networks";
import type { DataPackage } from "@/types/models";
import { formatMoney, normalizePhone } from "@/lib/format";
import { detectNetwork, isValidEmail, whatsAppLink } from "@/lib/phone";
import { errorMessage } from "@/lib/errors";

const STEPS = [
  { icon: Smartphone, title: "Pick a bundle", text: "Choose your network and data size." },
  { icon: CreditCard, title: "Pay securely", text: "Mobile Money or card via Paystack." },
  { icon: CheckCircle2, title: "Get your data", text: "Delivered to the number you enter." },
];

/**
 * A reseller's public eStore (blueprint 6.x). Zero-login: a buyer picks a
 * bundle, enters the recipient and a receipt email, and pays. Prices come from
 * the server only; the page never computes or sends one.
 */
export default function StorePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [store, setStore] = useState<Storefront | null>(null);
  const [storeError, setStoreError] = useState("");
  const [loadingStore, setLoadingStore] = useState(true);
  const { availability, loading: availabilityLoading, isOpen } = useNetworkAvailability();

  const [network, setNetwork] = useState("");
  const [packages, setPackages] = useState<DataPackage[]>([]);
  const [loadingPackages, setLoadingPackages] = useState(false);
  const [packagesError, setPackagesError] = useState("");
  const [selected, setSelected] = useState<DataPackage | null>(null);

  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    let active = true;
    getStorefront(slug)
      .then((value) => {
        if (active) setStore(value);
      })
      .catch(() => {
        if (active) setStoreError("This store is not available right now.");
      })
      .finally(() => {
        if (active) setLoadingStore(false);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  // Remember the buyer's receipt email on this device only.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("nityhub:receipt-email");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setEmail(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const networkLabel = NETWORKS.find((item) => item.value === network)?.label || "";
  const theme = networkTheme(network);
  const estimate = estimateFor(availability, network);
  const normalizedPhone = normalizePhone(phone);
  const detected = detectNetwork(phone);
  const mismatch = Boolean(detected && network && detected !== network);

  const openNetwork = async (key: string) => {
    setNetwork(key);
    setSelected(null);
    setPackages([]);
    setPackagesError("");
    setLoadingPackages(true);
    try {
      setPackages(await getStorePackages(slug, key));
    } catch (error) {
      setPackagesError(errorMessage(error, "Bundles could not be loaded. Please try again."));
    } finally {
      setLoadingPackages(false);
    }
  };

  const closeSheets = () => {
    if (paying) return;
    setSelected(null);
    setNetwork("");
    setCheckoutError("");
  };

  const pay = async () => {
    if (!selected || !network || paying) return;
    setCheckoutError("");
    if (normalizedPhone.length !== 10) {
      setCheckoutError("Enter the 10-digit number that should receive the bundle.");
      return;
    }
    if (!isValidEmail(email)) {
      setCheckoutError("Enter a valid email so we can send your receipt.");
      return;
    }
    setPaying(true);
    try {
      try {
        window.localStorage.setItem("nityhub:receipt-email", email.trim());
      } catch {
        /* storage unavailable */
      }
      const payment = await startStoreCheckout(slug, {
        network,
        packageId: String(selected.id),
        phone: normalizedPhone,
        email: email.trim(),
      });
      window.location.assign(payment.authorization_url);
    } catch (error) {
      setCheckoutError(errorMessage(error, "Payment could not be started. Please try again."));
      setPaying(false);
    }
  };

  const supportLink = useMemo(
    () => (store ? whatsAppLink(store.whatsapp, `Hello, I need help with an order on ${store.name}.`) : ""),
    [store],
  );

  const initials = (store?.name || "Store")
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-28 pt-6 sm:pt-10">
      {/* Store header */}
      <section className="relative overflow-hidden rounded-card bg-ledger px-5 py-7 text-ledger-ink shadow-ledger sm:px-8 sm:py-9">
        <div
          className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-brand/25 blur-3xl"
          aria-hidden
        />
        {loadingStore ? (
          <div className="flex items-center gap-4">
            <Skeleton className="size-14 rounded-2xl opacity-30" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-48 opacity-30" />
              <Skeleton className="h-4 w-64 opacity-20" />
            </div>
          </div>
        ) : store ? (
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-white/12 text-lg font-bold ring-1 ring-white/20">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{store.name}</h1>
              <p className="mt-1 text-sm text-ledger-muted">
                {store.tagline || "Affordable data bundles for MTN, Telecel and AirtelTigo."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5">
                <Lock className="size-3.5" aria-hidden /> Secure checkout
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5">
                <ShieldCheck className="size-3.5" aria-hidden /> No account needed
              </span>
            </div>
          </div>
        ) : (
          <div className="relative flex items-center gap-4">
            <StoreIcon className="size-8 text-ledger-muted" aria-hidden />
            <div>
              <h1 className="text-xl font-semibold">Store unavailable</h1>
              <p className="mt-1 text-sm text-ledger-muted">{storeError || "This store could not be found."}</p>
            </div>
          </div>
        )}
      </section>

      {store ? (
        <>
          <DeliveryTicker />

          <Card className="flex flex-col gap-4 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-ink">Choose a network</h2>
              <span className="text-xs text-muted">Prices include all fees</span>
            </div>
            {availability && !availability.enabled ? (
              <p role="status" className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
                Sales are paused for a short maintenance. Please check back shortly.
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              {NETWORKS.map((item) => (
                <NetworkCard
                  key={item.value}
                  network={item}
                  onSelect={(value) => void openNetwork(value)}
                  loading={availabilityLoading}
                  paused={!availabilityLoading && !isOpen(item.value)}
                  estimate={estimateFor(availability, item.value)}
                />
              ))}
            </div>
          </Card>

          <section aria-label="How it works" className="grid gap-2.5 sm:grid-cols-3">
            {STEPS.map(({ icon: Icon, title, text }, index) => (
              <div key={title} className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">
                    <span className="mr-1 text-muted tabular">{index + 1}.</span>
                    {title}
                  </span>
                  <span className="block text-xs text-muted">{text}</span>
                </span>
              </div>
            ))}
          </section>

          <Link
            href="/repair"
            className="group flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3.5 transition-colors hover:border-border-strong"
          >
            <Search className="size-4 text-brand" aria-hidden />
            <span className="flex-1 text-sm">
              <span className="font-semibold text-ink">Track or fix an order</span>
              <span className="block text-xs text-muted">Use the reference from your receipt or Paystack email.</span>
            </span>
            <ArrowRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
          </Link>

          <p className="text-center text-xs text-muted">
            Payments are processed securely by Paystack. Powered by NityHub.
          </p>

          {supportLink ? (
            <a
              href={supportLink}
              target="_blank"
              rel="noopener noreferrer"
              className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-4 z-40 inline-flex min-h-12 items-center gap-2 rounded-full bg-[#25D366] px-4 text-sm font-semibold text-[#0b3d20] shadow-lg transition-transform hover:-translate-y-0.5"
            >
              <MessageCircle className="size-5" aria-hidden />
              <span>Chat with us</span>
            </a>
          ) : null}
        </>
      ) : null}

      {/* Package picker (bottom sheet on phones) */}
      <Modal
        open={Boolean(network) && !selected}
        onClose={closeSheets}
        title={`${networkLabel} data bundles`}
        description={
          <span className="inline-flex items-center gap-2">
            Tap a bundle to continue <DeliveryEstimate estimate={estimate} />
          </span>
        }
      >
        {loadingPackages ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-14 rounded-xl" />
            ))}
          </div>
        ) : packagesError ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-danger">{packagesError}</p>
            <Button size="sm" variant="secondary" onClick={() => void openNetwork(network)}>
              Try again
            </Button>
          </div>
        ) : packages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            No bundles on this network right now. Please try another network.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {packages.map((item) => (
              <li key={String(item.id)}>
                <button
                  type="button"
                  onClick={() => setSelected(item)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-left transition-all hover:-translate-y-px hover:border-border-strong hover:shadow-sm active:scale-[0.99] motion-reduce:transition-none"
                >
                  <span
                    className="flex h-9 min-w-12 items-center justify-center rounded-lg px-2 text-xs font-bold tabular"
                    style={{ backgroundColor: theme.color, color: theme.onColor }}
                    aria-hidden
                  >
                    {item.label.replace(/\s+/g, "")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold text-ink">{item.label}</span>
                    <span className="block text-xs text-muted">{networkLabel} data</span>
                  </span>
                  <span className="text-sm font-semibold tabular text-ink">{formatMoney(Number(item.price || 0))}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      {/* Checkout sheet */}
      <Modal
        open={Boolean(selected)}
        onClose={() => (paying ? undefined : setSelected(null))}
        title="Complete your order"
        description={selected ? `${networkLabel} ${selected.label}` : undefined}
        footer={
          <Button onClick={() => void pay()} loading={paying} fullWidth size="lg">
            {paying ? "Opening secure checkout…" : `Pay ${formatMoney(Number(selected?.price || 0))}`}
          </Button>
        }
      >
        {selected ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: theme.ring, backgroundColor: theme.tint }}>
              <span className="flex-1">
                <span className="block text-sm font-semibold text-ink">{selected.label} · {networkLabel}</span>
                <DeliveryEstimate estimate={estimate} className="mt-1" />
              </span>
              <span className="text-lg font-semibold tabular text-ink">{formatMoney(Number(selected.price || 0))}</span>
            </div>
            <Field
              label="Recipient number"
              htmlFor="store-phone"
              hint={
                mismatch
                  ? `Heads up: this looks like a ${NETWORKS.find((item) => item.value === detected)?.label} number, not ${networkLabel}.`
                  : "The number that receives the data."
              }
            >
              <Input
                id="store-phone"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                autoFocus
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                onBlur={() => setPhone(normalizePhone(phone))}
                placeholder="0XXXXXXXXX"
                aria-invalid={mismatch || undefined}
              />
            </Field>
            <Field label="Email for your receipt" htmlFor="store-email" hint="We send your payment reference and live tracking link here.">
              <Input
                id="store-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            {checkoutError ? (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                {checkoutError}
              </p>
            ) : null}
            <p className="flex items-center gap-1.5 text-xs text-muted">
              {paying ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Lock className="size-3.5" aria-hidden />}
              You will pay on Paystack&apos;s secure page, then return here to a live receipt.
            </p>
          </div>
        ) : null}
      </Modal>
    </main>
  );
}
