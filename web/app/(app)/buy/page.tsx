"use client";

import { useCallback, useEffect, useState } from "react";
import { ShoppingCart, Zap } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { NETWORKS } from "@/constants/networks";
import type { DataPackage } from "@/types/models";
import {
  getMyRole,
  getPackages,
  getWalletBalance,
  walletPurchase,
} from "@/services/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHero } from "@/components/layout/page-hero";
import { NetworkDot } from "@/components/ui/network-dot";
import { BuyFlow, type PurchaseResult } from "@/components/buy/buy-flow";

function resolvePrice(item: DataPackage, agentPricing: boolean): number {
  return agentPricing
    ? Number(item.agentPrice || item.userPrice || 0)
    : Number(item.userPrice || 0);
}

export default function BuyPage() {
  const [agentPricing, setAgentPricing] = useState(false);
  const [wallet, setWallet] = useState<number | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);
  const [flowKey, setFlowKey] = useState(0);

  const refreshWallet = useCallback(async () => {
    try {
      setWallet(await getWalletBalance());
    } catch {
      /* non-fatal for the buy screen */
    }
  }, []);

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
    })();
    return () => {
      active = false;
    };
  }, [refreshWallet]);

  const loadFlowPackages = useCallback(
    async (network: string): Promise<DataPackage[]> => {
      const rows = await getPackages(network);
      return rows
        .filter((item) => item.enabled !== false)
        .map((item) => ({ ...item, price: resolvePrice(item, agentPricing) }))
        .filter((item) => Number(item.price) > 0)
        .sort(
          (a, b) =>
            Number(a.sortOrder || a.volume || 0) - Number(b.sortOrder || b.volume || 0),
        );
    },
    [agentPricing],
  );

  const purchase = useCallback(
    async (input: {
      network: string;
      phone: string;
      packageId: string;
      volume?: number;
    }): Promise<PurchaseResult> => {
      const res = await walletPurchase(input);
      return {
        reference: res?.data?.reference || `REF_${Date.now()}`,
        message: res?.message,
      };
    },
    [],
  );

  const openFlow = () => {
    setFlowKey((k) => k + 1);
    setFlowOpen(true);
  };

  return (
    <>
      <PageHero title="Buy Data" description="Pick a network, choose a bundle, and deliver instantly.">
        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral">Mode · {agentPricing ? "Agent pricing" : "Regular pricing"}</Badge>
          <Badge tone="success">Wallet · {wallet === null ? "…" : formatMoney(wallet)}</Badge>
        </div>
      </PageHero>

      <Card className="flex flex-col items-center gap-5 py-10 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-brand-soft text-brand-strong">
          <Zap className="size-7" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-ink">Instant data bundles</h2>
          <p className="mt-1 max-w-sm text-sm text-muted">
            MTN, Telecel and AirtelTigo — paid straight from your wallet with a receipt for every order.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {NETWORKS.map((n) => (
            <span key={n.value} className="inline-flex items-center gap-1.5 text-sm text-ink-soft">
              <NetworkDot network={n.value} />
              {n.label}
            </span>
          ))}
        </div>
        <Button size="lg" onClick={openFlow} className="w-full sm:w-auto">
          <ShoppingCart className="size-4" />
          Buy Bundle
        </Button>
      </Card>

      <BuyFlow
        key={flowKey}
        open={flowOpen}
        onClose={() => setFlowOpen(false)}
        networks={NETWORKS}
        agentPricing={agentPricing}
        walletBalance={wallet}
        loadPackages={loadFlowPackages}
        purchase={purchase}
        onCompleted={refreshWallet}
      />
    </>
  );
}
