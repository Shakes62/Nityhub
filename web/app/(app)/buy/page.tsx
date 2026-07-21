"use client";

import { useCallback, useEffect, useState } from "react";
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
import { Card } from "@/components/ui/card";
import { PageHero } from "@/components/layout/page-hero";
import { BuyFlow, type PurchaseResult } from "@/components/buy/buy-flow";
import { NetworkCard } from "@/components/buy/network-card";

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
  const [initialNetwork, setInitialNetwork] = useState("");

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

  /** Opening from a network tile jumps straight to that network's packages. */
  const openFlow = (network: string) => {
    setInitialNetwork(network);
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

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-semibold text-ink">Choose a network</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {NETWORKS.map((n) => (
            <NetworkCard key={n.value} network={n} onSelect={openFlow} />
          ))}
        </div>
      </Card>

      <BuyFlow
        key={flowKey}
        open={flowOpen}
        onClose={() => setFlowOpen(false)}
        networks={NETWORKS}
        initialNetwork={initialNetwork}
        agentPricing={agentPricing}
        walletBalance={wallet}
        loadPackages={loadFlowPackages}
        purchase={purchase}
        onCompleted={refreshWallet}
      />
    </>
  );
}
