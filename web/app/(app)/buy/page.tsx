"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { formatMoney, normalizePhone } from "@/lib/format";
import { NETWORKS } from "@/constants/networks";
import { ApiError } from "@/types/api";
import type { DataPackage } from "@/types/models";
import {
  getMyRole,
  getPackages,
  getWalletBalance,
  walletPurchase,
} from "@/services/api";
import { useToast } from "@/contexts/toast-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/field";
import { Input } from "@/components/ui/field";
import { PageHero } from "@/components/layout/page-hero";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";

function resolvePrice(item: DataPackage, agentPricing: boolean): number {
  return agentPricing
    ? Number(item.agentPrice || item.userPrice || 0)
    : Number(item.userPrice || 0);
}

export default function BuyPage() {
  const toast = useToast();

  const [network, setNetwork] = useState(NETWORKS[0].value);
  const [phone, setPhone] = useState("");
  const [agentPricing, setAgentPricing] = useState(false);
  const [wallet, setWallet] = useState<number | null>(null);

  const [packages, setPackages] = useState<DataPackage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingPackages, setLoadingPackages] = useState(true);
  const [packagesError, setPackagesError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refreshWallet = useCallback(async () => {
    try {
      setWallet(await getWalletBalance());
    } catch {
      /* non-fatal for the buy screen */
    }
  }, []);

  const loadPackages = useCallback(
    async (targetNetwork: string, agent: boolean) => {
      setLoadingPackages(true);
      setPackagesError(null);
      setSelectedId(null);
      try {
        const rows = await getPackages(targetNetwork);
        const priced = rows
          .filter((item) => item.enabled !== false)
          .map((item) => ({ ...item, price: resolvePrice(item, agent) }))
          .filter((item) => Number(item.price) > 0)
          .sort(
            (a, b) =>
              Number(a.sortOrder || a.volume || 0) -
              Number(b.sortOrder || b.volume || 0),
          );
        setPackages(priced);
      } catch (error) {
        setPackages([]);
        setPackagesError(
          error instanceof Error ? error.message : "Failed to load packages.",
        );
      } finally {
        setLoadingPackages(false);
      }
    },
    [],
  );

  // Initial load: resolve pricing tier, wallet, then packages for it.
  useEffect(() => {
    let active = true;
    (async () => {
      let agent = false;
      try {
        const role = await getMyRole();
        agent = role.pricingTier === "agent" || role.privileged === true;
      } catch {
        /* default to regular pricing */
      }
      if (!active) return;
      setAgentPricing(agent);
      await refreshWallet();
      await loadPackages(NETWORKS[0].value, agent);
    })();
    return () => {
      active = false;
    };
  }, [refreshWallet, loadPackages]);

  function handleNetworkChange(value: string) {
    setNetwork(value);
    void loadPackages(value, agentPricing);
  }

  const selected = packages.find((item) => item.id === selectedId) || null;

  async function handlePurchase() {
    if (submitting) return;
    if (!selected) {
      toast.error("Select a package first.");
      return;
    }
    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone.length !== 10) {
      toast.error("Enter a valid 10-digit number.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await walletPurchase({
        network,
        phone: normalizedPhone,
        packageId: selected.id,
        volume: selected.volume,
      });
      const reference = response?.data?.reference || `REF_${Date.now()}`;
      const message =
        response?.message ||
        "Order accepted. We will update the final status shortly.";
      toast.success(`${message} Ref: ${reference}`);
      setPhone("");
      await Promise.all([refreshWallet(), loadPackages(network, agentPricing)]);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.errorCode === "INSUFFICIENT_WALLET_BALANCE"
      ) {
        const available = Number(error.payload?.availableBalance);
        const required = Number(error.payload?.requiredAmount);
        if (Number.isFinite(available) && Number.isFinite(required)) {
          toast.error(
            `Insufficient wallet balance. Available ${formatMoney(available)}, required ${formatMoney(required)}.`,
          );
          await refreshWallet();
          return;
        }
      }
      toast.error(error instanceof Error ? error.message : "Purchase failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHero title="Buy Data" description="Select a bundle and deliver instantly.">
        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral">
            Mode · {agentPricing ? "Agent Pricing" : "Regular Pricing"}
          </Badge>
          <Badge tone="success">
            Wallet · {wallet === null ? "…" : formatMoney(wallet)}
          </Badge>
        </div>
      </PageHero>

      <Card className="flex flex-col gap-4">
        <CardHeader title="Details" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Network" htmlFor="network-picker">
            <Select
              id="network-picker"
              value={network}
              onChange={(event) => handleNetworkChange(event.target.value)}
            >
              {NETWORKS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Beneficiary Number" htmlFor="beneficiary-phone">
            <Input
              id="beneficiary-phone"
              type="tel"
              inputMode="numeric"
              placeholder="0XXXXXXXXX"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              onBlur={() => setPhone(normalizePhone(phone))}
            />
          </Field>
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardHeader title="Packages" />

        {loadingPackages ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-20 rounded-lg" />
            ))}
          </div>
        ) : packagesError ? (
          <ErrorState
            message={packagesError}
            onRetry={() => loadPackages(network, agentPricing)}
          />
        ) : packages.length === 0 ? (
          <EmptyState
            title="No packages found"
            description="There are no bundles available for this network right now."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {packages.map((item) => {
              const active = item.id === selectedId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  aria-pressed={active}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-all",
                    active
                      ? "border-brand bg-brand-soft ring-2 ring-brand/30"
                      : "border-border bg-surface hover:border-border-strong hover:bg-surface-soft",
                  )}
                >
                  <span className="text-base font-semibold text-ink">
                    {item.label}
                  </span>
                  <span
                    className={cn(
                      "text-sm font-medium",
                      active ? "text-brand-strong" : "text-muted",
                    )}
                  >
                    {formatMoney(item.price)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button onClick={handlePurchase} loading={submitting} disabled={!selected}>
            Buy Bundle
          </Button>
          {selected ? (
            <span className="text-sm text-muted">
              {selected.label} · {formatMoney(selected.price)} to{" "}
              {phone ? normalizePhone(phone) : "—"}
            </span>
          ) : null}
        </div>
      </Card>
    </>
  );
}
