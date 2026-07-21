"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, Wallet } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatMoney, normalizePhone } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { NetworkDot } from "@/components/ui/network-dot";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Receipt, type ReceiptData } from "@/components/receipt/receipt";
import { NetworkCard } from "@/components/buy/network-card";
import { networkTheme, type NetworkOption } from "@/constants/networks";
import type { DataPackage } from "@/types/models";

type Step = "network" | "package" | "phone" | "confirm" | "receipt";

export interface PurchaseResult {
  reference: string;
  message?: string;
}

interface BuyFlowProps {
  open: boolean;
  onClose: () => void;
  networks: NetworkOption[];
  /** When set, the flow opens straight at that network's packages. */
  initialNetwork?: string;
  agentPricing: boolean;
  walletBalance: number | null;
  loadPackages: (network: string) => Promise<DataPackage[]>;
  purchase: (input: {
    network: string;
    phone: string;
    packageId: string;
    volume?: number;
  }) => Promise<PurchaseResult>;
  /** Called after the user finishes so the page can refresh wallet/catalog. */
  onCompleted: () => void;
}

/** Ghana local-number prefixes per network, for a soft mismatch warning. */
const PREFIXES: Record<string, string[]> = {
  mtn: ["024", "025", "054", "055", "059"],
  telecel: ["020", "050"],
  at: ["026", "027", "056", "057"],
};

function detectNetwork(phone: string): string | null {
  const p = normalizePhone(phone);
  if (p.length !== 10) return null;
  const prefix = p.slice(0, 3);
  for (const [net, list] of Object.entries(PREFIXES)) {
    if (list.includes(prefix)) return net;
  }
  return null;
}

const STEP_ORDER: Step[] = ["network", "package", "phone", "confirm"];

export function BuyFlow({
  open,
  onClose,
  networks,
  initialNetwork = "",
  agentPricing,
  walletBalance,
  loadPackages,
  purchase,
  onCompleted,
}: BuyFlowProps) {
  const [step, setStep] = useState<Step>(initialNetwork ? "package" : "network");
  const [network, setNetwork] = useState(initialNetwork);
  const [packages, setPackages] = useState<DataPackage[]>([]);
  const [loadingPkgs, setLoadingPkgs] = useState(Boolean(initialNetwork));
  const [pkgError, setPkgError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DataPackage | null>(null);
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);

  const networkLabel = networks.find((n) => n.value === network)?.label || network.toUpperCase();
  const theme = networkTheme(network);
  const price = Number(selected?.price ?? selected?.userPrice ?? 0);
  const total = price; // data bundles carry no extra charge
  const normalized = normalizePhone(phone);
  const detected = detectNetwork(phone);
  const mismatch = detected && detected !== network;
  const insufficient = walletBalance != null && walletBalance < total;

  const openPackages = useCallback(
    async (net: string) => {
      setNetwork(net);
      setSelected(null);
      setStep("package");
      setLoadingPkgs(true);
      setPkgError(null);
      try {
        setPackages(await loadPackages(net));
      } catch (err) {
        setPackages([]);
        setPkgError(err instanceof Error ? err.message : "Failed to load packages.");
      } finally {
        setLoadingPkgs(false);
      }
    },
    [loadPackages],
  );

  // Opened from a network tile: fetch that network's bundles immediately.
  // The parent remounts this component per open (key={flowKey}), so this runs
  // once per flow rather than on every render. State starts already in the
  // "package" step with loadingPkgs true, so nothing is set before the await.
  useEffect(() => {
    if (!initialNetwork) return;
    let active = true;
    (async () => {
      try {
        const rows = await loadPackages(initialNetwork);
        if (active) setPackages(rows);
      } catch (err) {
        if (!active) return;
        setPackages([]);
        setPkgError(err instanceof Error ? err.message : "Failed to load packages.");
      } finally {
        if (active) setLoadingPkgs(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goPhone = () => {
    if (normalized.length !== 10) {
      setPhoneError("Enter a valid 10-digit number.");
      return;
    }
    setPhoneError(null);
    setStep("confirm");
  };

  const doPurchase = async () => {
    if (submitting || !selected) return;
    setSubmitting(true);
    const before = walletBalance;
    const baseLines = [
      { label: "Network", value: networkLabel },
      { label: "Bundle", value: selected.label },
      { label: "Beneficiary", value: normalized, mono: true },
    ];
    try {
      const result = await purchase({
        network,
        phone: normalized,
        packageId: selected.id,
        volume: selected.volume,
      });
      setReceipt({
        kind: "purchase",
        status: "success",
        title: "Purchase receipt",
        reference: result.reference,
        date: Date.now(),
        lines: baseLines,
        amount: price,
        charges: 0,
        total,
        method: "Wallet",
        balanceBefore: before,
        balanceAfter: before != null ? Math.max(0, before - total) : null,
        estimatedDelivery: "Usually within a few minutes",
        note: `${selected.label} to ${normalized} (${networkLabel})`,
      });
      setStep("receipt");
      onCompleted();
    } catch (err) {
      setReceipt({
        kind: "purchase",
        status: "failed",
        title: "Purchase receipt",
        reference: `FAILED-${Date.now()}`,
        date: Date.now(),
        lines: [
          ...baseLines,
          { label: "Reason", value: err instanceof Error ? err.message : "Purchase failed" },
        ],
        amount: price,
        charges: 0,
        total,
        method: "Wallet",
        balanceBefore: before,
        balanceAfter: before,
        note: `${selected.label} to ${normalized} (${networkLabel})`,
      });
      setStep("receipt");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setStep("network");
    setNetwork("");
    setPackages([]);
    setSelected(null);
    setPhone("");
    setPhoneError(null);
    setReceipt(null);
  };

  const stepIndex = STEP_ORDER.indexOf(step);
  const title =
    step === "network"
      ? "Choose network"
      : step === "package"
        ? "Choose a package"
        : step === "phone"
          ? "Beneficiary number"
          : step === "confirm"
            ? "Confirm purchase"
            : "Receipt";

  const footer =
    step === "receipt" ? (
      <>
        <Button variant="ghost" size="sm" onClick={reset}>
          Buy another
        </Button>
        <Button variant="primary" size="sm" onClick={onClose}>
          Done
        </Button>
      </>
    ) : step === "network" ? (
      <Button variant="ghost" size="sm" onClick={onClose}>
        Cancel
      </Button>
    ) : step === "phone" ? (
      <>
        <Button variant="ghost" size="sm" onClick={() => setStep("package")}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <Button variant="primary" size="sm" onClick={goPhone} disabled={normalized.length !== 10}>
          Continue
          <ArrowRight className="size-4" />
        </Button>
      </>
    ) : step === "confirm" ? (
      <>
        <Button variant="ghost" size="sm" onClick={() => setStep("phone")} disabled={submitting}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={doPurchase}
          loading={submitting}
          disabled={insufficient}
          style={
            insufficient ? undefined : { backgroundColor: theme.color, color: theme.onColor, borderColor: theme.color }
          }
        >
          Confirm &amp; pay {formatMoney(total)}
        </Button>
      </>
    ) : (
      <Button variant="ghost" size="sm" onClick={() => setStep("network")}>
        <ArrowLeft className="size-4" />
        Back
      </Button>
    );

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title={title}
      description={
        step !== "receipt" ? `Step ${stepIndex + 1} of ${STEP_ORDER.length}` : undefined
      }
      size="md"
      footer={footer}
    >
      {/* Progress bar — tinted with the chosen network once one is picked. */}
      {step !== "receipt" ? (
        <div className="mb-4 flex gap-1.5">
          {STEP_ORDER.map((s, i) => (
            <span
              key={s}
              className={cn("h-1 flex-1 rounded-full transition-colors", !network && "bg-surface-muted")}
              style={
                network
                  ? { backgroundColor: i <= stepIndex ? theme.color : "var(--color-surface-muted)" }
                  : undefined
              }
            />
          ))}
        </div>
      ) : null}

      {/* Network banner — keeps the active network visible on every step. */}
      {network && step !== "network" && step !== "receipt" ? (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-lg border px-3 py-2"
          style={{ borderColor: theme.ring, backgroundColor: theme.tint }}
        >
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-[11px] font-bold"
            style={{ backgroundColor: theme.color, color: theme.onColor }}
            aria-hidden
          >
            {networkLabel.slice(0, 2).toUpperCase()}
          </span>
          <span className="text-sm font-semibold text-ink">{networkLabel}</span>
          {selected ? (
            <span className="ml-auto text-sm font-semibold tabular text-ink">{selected.label}</span>
          ) : null}
        </div>
      ) : null}

      {/* Step: network */}
      {step === "network" ? (
        <div className="grid grid-cols-1 gap-2">
          {networks.map((n) => (
            <NetworkCard key={n.value} network={n} onSelect={openPackages} />
          ))}
        </div>
      ) : null}

      {/* Step: package */}
      {step === "package" ? (
        loadingPkgs ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : pkgError ? (
          <ErrorState message={pkgError} onRetry={() => openPackages(network)} />
        ) : packages.length === 0 ? (
          <EmptyState title="No packages" description="No bundles available for this network right now." />
        ) : (
          /* One bundle per row: a single scannable column of size -> price. */
          <div className="flex max-h-[22rem] flex-col gap-2 overflow-y-auto pr-0.5">
            {packages.map((p) => {
              const active = selected?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setSelected(p);
                    setStep("phone");
                  }}
                  className={cn(
                    "relative flex w-full items-center gap-3 rounded-lg border p-3 text-left",
                    "transition-all hover:-translate-y-px hover:shadow-sm active:translate-y-0 active:scale-[0.99]",
                    !active && "border-border bg-surface hover:border-border-strong",
                  )}
                  style={active ? { borderColor: theme.color, backgroundColor: theme.tint } : undefined}
                >
                  <span
                    className="flex size-9 shrink-0 items-center justify-center rounded-md text-[11px] font-bold"
                    style={{ backgroundColor: theme.color, color: theme.onColor }}
                    aria-hidden
                  >
                    {p.label.replace(/\s+/g, "").slice(0, 4)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink">{p.label}</span>
                    <span className="block text-xs text-muted">{networkLabel} data bundle</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular text-ink">
                    {formatMoney(p.price)}
                  </span>
                  {active ? (
                    <CheckCircle2 className="size-4 shrink-0" style={{ color: theme.color }} />
                  ) : null}
                </button>
              );
            })}
          </div>
        )
      ) : null}

      {/* Step: phone */}
      {step === "phone" ? (
        <div className="flex flex-col gap-3">
          <Field
            label="Beneficiary number"
            htmlFor="buy-phone"
            error={phoneError}
            hint={mismatch ? `Heads up: this looks like a ${detected?.toUpperCase()} number, not ${networkLabel}.` : "Enter the 10-digit number to receive the bundle."}
          >
            <Input
              id="buy-phone"
              type="tel"
              inputMode="numeric"
              autoFocus
              placeholder="0XXXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => setPhone(normalizePhone(phone))}
              onKeyDown={(e) => {
                if (e.key === "Enter") goPhone();
              }}
            />
          </Field>
          {selected ? (
            <p className="text-sm text-muted">
              {selected.label} · <span className="font-semibold text-ink">{formatMoney(price)}</span> · {networkLabel}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Step: confirm */}
      {step === "confirm" && selected ? (
        <div className="flex flex-col gap-4">
          <dl className="rounded-lg border border-border bg-surface-soft px-4 py-2">
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-xs text-muted">Network</dt>
              <dd className="inline-flex items-center gap-1.5 text-sm text-ink">
                <NetworkDot network={network} />
                {networkLabel}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-xs text-muted">Package</dt>
              <dd className="text-sm text-ink">{selected.label}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-xs text-muted">Beneficiary</dt>
              <dd className="font-mono text-sm text-ink">{normalized}</dd>
            </div>
          </dl>
          <dl className="rounded-lg border border-border px-4 py-2">
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-xs text-muted">Price</dt>
              <dd className="text-sm tabular text-ink">{formatMoney(price)}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-xs text-muted">Fees</dt>
              <dd className="text-sm tabular text-ink">{formatMoney(0)}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border py-2">
              <dt className="text-sm font-semibold text-ink">Total</dt>
              <dd className="text-sm font-semibold tabular text-ink">{formatMoney(total)}</dd>
            </div>
          </dl>
          <div
            className={cn(
              "flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm",
              insufficient ? "border-danger/30 bg-danger-soft/50 text-danger" : "border-border bg-surface-soft text-ink-soft",
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              <Wallet className="size-4" />
              Wallet balance
            </span>
            <span className="font-semibold tabular">{walletBalance == null ? "—" : formatMoney(walletBalance)}</span>
          </div>
          {insufficient ? (
            <p className="text-sm text-danger">Insufficient balance. Fund your wallet to continue.</p>
          ) : null}
          {agentPricing ? <p className="text-xs text-muted">Agent pricing applied.</p> : null}
        </div>
      ) : null}

      {/* Step: receipt */}
      {step === "receipt" && receipt ? <Receipt data={receipt} onRetry={doPurchase} /> : null}
    </Modal>
  );
}
