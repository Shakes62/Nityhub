"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, ReceiptText } from "lucide-react";
import { formatMoney } from "@/lib/format";
import type { WalletData } from "@/types/models";
import { creditDeposit, getWalletBalance, getWalletData, initiatePayment } from "@/services/api";
import { Modal } from "@/components/ui/modal";
import { Receipt, type ReceiptData } from "@/components/receipt/receipt";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/contexts/toast-context";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { PageHero } from "@/components/layout/page-hero";
import { LedgerPanel } from "@/components/ui/ledger-panel";

const QUICK_AMOUNTS = ["10", "20", "50", "100"];

function WalletInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const toast = useToast();

  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [amount, setAmount] = useState("");
  const [depositing, setDepositing] = useState(false);
  const [depositReceipt, setDepositReceipt] = useState<ReceiptData | null>(null);
  const callbackHandled = useRef(false);

  // The balance panel derives its own loading state from `wallet === null`,
  // so no separate loading flag is needed here.
  const refresh = useCallback(async () => {
    try {
      setWallet(await getWalletData(50));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load wallet.");
    }
  }, [toast]);

  // Initial load + confirm a returning Paystack deposit (reference/trxref),
  // then present a professional deposit receipt.
  useEffect(() => {
    let active = true;
    (async () => {
      const reference = searchParams.get("reference") || searchParams.get("trxref");
      if (!reference || callbackHandled.current) {
        await refresh();
        return;
      }
      callbackHandled.current = true;
      toast.info("Confirming payment...");
      let before: number | null = null;
      try {
        before = await getWalletBalance();
      } catch {
        /* balance-before is best-effort */
      }
      try {
        await creditDeposit(reference);
        let after: number | null = null;
        try {
          after = await getWalletBalance();
        } catch {
          /* balance-after is best-effort */
        }
        if (!active) return;
        const credited = before != null && after != null ? Math.max(0, after - before) : 0;
        setDepositReceipt({
          kind: "deposit",
          status: "success",
          title: "Deposit receipt",
          reference,
          date: Date.now(),
          lines: [{ label: "Channel", value: "Paystack" }],
          amount: credited,
          method: "Paystack",
          balanceBefore: before,
          balanceAfter: after,
          estimatedDelivery: "Reflected immediately",
          note: `Wallet deposit ${formatMoney(credited)}`,
        });
        router.replace("/wallet");
        await refresh();
      } catch (error) {
        if (!active) return;
        setDepositReceipt({
          kind: "deposit",
          status: "failed",
          title: "Deposit receipt",
          reference,
          date: Date.now(),
          lines: [
            { label: "Reason", value: error instanceof Error ? error.message : "Confirmation failed" },
          ],
          amount: 0,
          method: "Paystack",
          balanceBefore: before,
          balanceAfter: before,
        });
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startDeposit() {
    const value = Number(amount || 0);
    if (!value || value < 1) {
      toast.error("Enter a valid amount (minimum 1).");
      return;
    }
    setDepositing(true);
    try {
      const result = await initiatePayment({
        paymentType: "wallet",
        amount: value,
        reference: `WALLET_${Date.now()}_${(user?.uid || "").slice(0, 6)}`,
      });
      if (!result.authorization_url) {
        throw new Error("Could not start payment.");
      }
      window.location.href = result.authorization_url;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start deposit.");
      setDepositing(false);
    }
  }

  return (
    <>
      <PageHero title="Wallet" description="Fund your balance and review activity." />

      <LedgerPanel
        label="Wallet Balance"
        value={wallet ? formatMoney(wallet.balance) : ""}
        meta="Available now"
        loading={wallet === null}
      />

      <Card className="flex flex-col gap-4">
        <CardHeader title="Deposit" description="Top up securely with Paystack." />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Deposit Amount" htmlFor="deposit-amount" className="sm:max-w-xs">
            <div className="relative">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-medium text-muted">
                GHS
              </span>
              <Input
                id="deposit-amount"
                type="number"
                min={1}
                step="0.01"
                placeholder="50.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="pl-12 tabular"
              />
            </div>
          </Field>
          <Button onClick={startDeposit} loading={depositing}>
            Deposit with Paystack
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {QUICK_AMOUNTS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setAmount(value)}
              className="rounded-full border border-transparent bg-surface-muted px-3.5 py-1.5 text-sm font-medium tabular text-ink-soft transition-colors hover:border-border-strong"
            >
              {value}
            </button>
          ))}
        </div>
      </Card>

      <Link
        href="/transactions"
        className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 transition-colors hover:bg-surface-soft"
      >
        <span className="flex items-center gap-2.5">
          <ReceiptText className="size-4 text-muted" aria-hidden />
          <span className="text-sm font-medium text-ink">Transaction history</span>
        </span>
        <ChevronRight className="size-4 text-muted" aria-hidden />
      </Link>

      {/* Deposit receipt (Paystack return) */}
      <Modal
        open={Boolean(depositReceipt)}
        onClose={() => setDepositReceipt(null)}
        title="Deposit"
        size="sm"
        footer={
          <Button variant="primary" size="sm" onClick={() => setDepositReceipt(null)}>
            Done
          </Button>
        }
      >
        {depositReceipt ? <Receipt data={depositReceipt} /> : null}
      </Modal>
    </>
  );
}

export default function WalletPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center py-20">
          <Loader2 className="size-6 animate-spin text-brand" aria-label="Loading" />
        </div>
      }
    >
      <WalletInner />
    </Suspense>
  );
}
