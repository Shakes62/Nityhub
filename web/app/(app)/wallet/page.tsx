"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowDownLeft, ArrowUpRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDate, formatMoney, shortRef } from "@/lib/format";
import type { WalletData } from "@/types/models";
import { creditDeposit, getWalletData, initiatePayment } from "@/services/api";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/contexts/toast-context";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { PageHero } from "@/components/layout/page-hero";
import { LedgerPanel } from "@/components/ui/ledger-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";

const QUICK_AMOUNTS = ["10", "20", "50", "100"];

function WalletInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const toast = useToast();

  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState("");
  const [depositing, setDepositing] = useState(false);
  const callbackHandled = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setWallet(await getWalletData(50));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load wallet.");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // Initial load + confirm a returning Paystack deposit (reference/trxref).
  useEffect(() => {
    let active = true;
    (async () => {
      await refresh();
      const reference =
        searchParams.get("reference") || searchParams.get("trxref");
      if (!active || !reference || callbackHandled.current) {
        return;
      }
      callbackHandled.current = true;
      toast.info("Confirming payment...");
      try {
        await creditDeposit(reference);
        toast.success("Deposit confirmed and added to wallet.");
        router.replace("/wallet");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to confirm deposit.",
        );
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

  const transactions = wallet?.transactions ?? [];

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

      <Card className="flex flex-col gap-4">
        <CardHeader title="Transactions" />
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : transactions.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            description="Deposits and purchases will show up here."
          />
        ) : (
          <>
            {/* Desktop table */}
            <TableWrap className="hidden md:block">
              <Table>
                <thead>
                  <tr>
                    <Th>Reference</Th>
                    <Th>Type</Th>
                    <Th>Amount</Th>
                    <Th>Balance After</Th>
                    <Th>Date</Th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx, index) => {
                    const value = Number(tx.amount || 0);
                    const credit = value >= 0;
                    const reference = tx.reference || tx.details?.reference || "-";
                    const DirIcon = credit ? ArrowDownLeft : ArrowUpRight;
                    return (
                      <tr key={index} className="transition-colors duration-100 hover:bg-surface-soft/60">
                        <Td
                          className="font-mono text-[0.8125rem] font-medium text-ink"
                          title={reference}
                        >
                          {shortRef(reference)}
                        </Td>
                        <Td>
                          <span className="inline-flex items-center gap-1.5">
                            <DirIcon
                              className={cn(
                                "size-3.5",
                                credit ? "text-success" : "text-muted",
                              )}
                              aria-hidden
                            />
                            {tx.type || "transaction"}
                          </span>
                        </Td>
                        <Td>
                          <span
                            className={cn(
                              "font-medium tabular",
                              credit ? "text-success" : "text-ink",
                            )}
                          >
                            {credit
                              ? `+${formatMoney(value)}`
                              : `−${formatMoney(Math.abs(value))}`}
                          </span>
                        </Td>
                        <Td className="tabular">{formatMoney(tx.balance || 0)}</Td>
                        <Td>{formatDate(tx.timestamp)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>

            {/* Mobile stacked cards */}
            <div className="flex flex-col gap-2 md:hidden">
              {transactions.map((tx, index) => {
                const value = Number(tx.amount || 0);
                const credit = value >= 0;
                const reference = tx.reference || tx.details?.reference || "-";
                const DirIcon = credit ? ArrowDownLeft : ArrowUpRight;
                return (
                  <div
                    key={index}
                    className="rounded-lg border border-border bg-surface-soft p-3.5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 text-sm text-ink-soft">
                        <DirIcon
                          className={cn(
                            "size-3.5",
                            credit ? "text-success" : "text-muted",
                          )}
                          aria-hidden
                        />
                        {tx.type || "transaction"}
                      </span>
                      <span
                        className={cn(
                          "text-sm font-semibold tabular",
                          credit ? "text-success" : "text-ink",
                        )}
                      >
                        {credit
                          ? `+${formatMoney(value)}`
                          : `−${formatMoney(Math.abs(value))}`}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted">
                      <span className="truncate font-mono" title={reference}>
                        {shortRef(reference)}
                      </span>
                      <span className="tabular">{formatDate(tx.timestamp)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>
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
