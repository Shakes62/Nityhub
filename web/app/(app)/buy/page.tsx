"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/format";
import { NETWORKS } from "@/constants/networks";
import type { DataPackage } from "@/types/models";
import { estimateFor, getPackages, getWalletBalance, walletPurchase } from "@/services/api";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHero } from "@/components/layout/page-hero";
import { BuyFlow, type PurchaseResult } from "@/components/buy/buy-flow";
import { NetworkCard } from "@/components/buy/network-card";
import { BannerCarousel } from "@/components/banners/banner-carousel";
import { DeliveryTicker } from "@/components/social-proof/delivery-ticker";
import { useNetworkAvailability } from "@/hooks/use-network-availability";
import { useLiveEvents } from "@/contexts/live-events-context";

export default function BuyPage() {
  const [fetchedWallet, setFetchedWallet] = useState<number | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);
  const [flowKey, setFlowKey] = useState(0);
  const [initialNetwork, setInitialNetwork] = useState("");
  const { availability, loading: availabilityLoading, isOpen } = useNetworkAvailability();
  const live = useLiveEvents();
  // Spendable balance: the live stream wins once it has spoken, so a deposit
  // credited by webhook shows up here without a refresh.
  const wallet = live.wallet ? live.wallet.availableBalance : fetchedWallet;

  const refreshWallet = useCallback(async () => {
    try {
      setFetchedWallet(await getWalletBalance());
    } catch {
      /* non-fatal for the buy screen */
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const balance = await getWalletBalance();
        if (active) setFetchedWallet(balance);
      } catch {
        /* non-fatal for the buy screen */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  /**
   * No pricing decision happens here. `price` arrives already resolved for this
   * user by the backend, which is the only place that knows their tier — so the
   * amount shown is by construction the amount that will be debited, and agent
   * pricing (if any) applies silently.
   */
  const loadFlowPackages = useCallback(
    async (network: string): Promise<DataPackage[]> => {
      const rows = await getPackages(network);
      return rows
        .filter((item) => item.enabled !== false && Number(item.price) > 0)
        .sort(
          (a, b) =>
            Number(a.sortOrder || a.volume || 0) - Number(b.sortOrder || b.volume || 0),
        );
    },
    [],
  );

  const purchase = useCallback(
    async (input: {
      network: string;
      phone: string;
      packageId: string;
      volume?: number;
    }): Promise<PurchaseResult> => {
      const res = await walletPurchase(input);
      if (!res.data?.reference) {
        throw new Error("We could not confirm this purchase. Check your orders before trying again.");
      }
      return {
        reference: res.data.reference,
        message: res?.message,
        orderStatus: res.data.orderStatus,
        balance: res.data.balance,
        amount: res.data.amount,
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
          {/* No pricing-tier badge: agent pricing must not be visible to the
              customer. Prices already reflect their tier. */}
          <Badge tone="success">Wallet · {wallet === null ? "…" : formatMoney(wallet)}</Badge>
        </div>
      </PageHero>

      <BannerCarousel />

      <DeliveryTicker />

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-semibold text-ink">Choose a network</h2>
        {availability && !availability.enabled ? (
          <p role="status" className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
            Purchases are paused for a short maintenance. Please check back shortly.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {NETWORKS.map((n) => (
            <NetworkCard
              key={n.value}
              network={n}
              onSelect={openFlow}
              loading={availabilityLoading}
              paused={!availabilityLoading && !isOpen(n.value)}
              estimate={estimateFor(availability, n.value)}
            />
          ))}
        </div>
      </Card>

      <BuyFlow
        key={flowKey}
        open={flowOpen}
        onClose={() => setFlowOpen(false)}
        networks={NETWORKS.filter((n) => isOpen(n.value))}
        estimates={availability?.estimates}
        initialNetwork={initialNetwork}
        walletBalance={wallet}
        loadPackages={loadFlowPackages}
        purchase={purchase}
        onCompleted={refreshWallet}
      />
    </>
  );
}
