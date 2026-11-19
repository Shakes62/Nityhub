"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Clock, Copy, Loader2, MessageCircle, RotateCcw, Wrench, XCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Receipt, type ReceiptData, type ReceiptLine } from "@/components/receipt/receipt";
import { DeliveryEstimate } from "@/components/buy/delivery-estimate";
import { estimateFor, getReceipt, getStorefront, repairOrder, type Storefront } from "@/services/api";
import { useNetworkAvailability } from "@/hooks/use-network-availability";
import { useToast } from "@/contexts/toast-context";
import { NETWORKS } from "@/constants/networks";
import { SUPPORT_WHATSAPP } from "@/constants/config";
import type { Order } from "@/types/models";
import { ApiError } from "@/types/api";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { whatsAppLink } from "@/lib/phone";

const POLL_MS = 8000;
const TERMINAL = new Set(["delivered", "failed", "cancelled"]);

type Phase = "loading" | "awaiting_payment" | "ready" | "missing";

function networkName(value?: string) {
  return NETWORKS.find((item) => item.value === value)?.label || String(value || "").toUpperCase();
}

/** Paid → Sent → Delivered, so a buyer can see where their order is. */
function Timeline({ status }: { status: string }) {
  const failed = status === "failed" || status === "cancelled";
  const delivered = status === "delivered";
  const sent = delivered || ["accepted", "processing", "pending"].includes(status);
  const steps = [
    { label: "Payment received", done: true },
    { label: "Sent to network", done: sent || failed },
    { label: failed ? "Needs attention" : "Delivered", done: delivered, failed },
  ];
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label="Order progress">
      {steps.map((step, index) => (
        <li key={step.label} className="flex flex-col items-center gap-2 text-center">
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-full border text-xs font-semibold",
              step.failed ? "border-danger/40 bg-danger-soft text-danger"
                : step.done ? "border-success/40 bg-success-soft text-success"
                : "border-border bg-surface-muted text-muted",
            )}
          >
            {step.failed ? <XCircle className="size-4" aria-hidden /> : step.done ? <Check className="size-4" aria-hidden />
              : index === 2 ? <Clock className="size-4" aria-hidden /> : index + 1}
          </span>
          <span className={cn("text-xs", step.done || step.failed ? "font-medium text-ink" : "text-muted")}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

export default function ReceiptPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = use(params);
  const toast = useToast();
  const { availability } = useNetworkAvailability();
  const [order, setOrder] = useState<Order | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [notice, setNotice] = useState("");
  const [store, setStore] = useState<Storefront | null>(null);
  const [repairing, setRepairing] = useState(false);
  const statusRef = useRef("");

  /** Read the receipt; if the order does not exist yet, ask the repair engine to build it. */
  const refresh = useCallback(async (allowRepair: boolean) => {
    try {
      const value = await getReceipt(reference);
      statusRef.current = String(value.status || "");
      setOrder(value);
      setPhase("ready");
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) {
        setNotice(errorMessage(error, "We couldn't refresh this receipt. Retrying shortly."));
        return;
      }
    }
    if (!allowRepair) return;
    // Paystack can redirect here before its webhook lands. The repair engine
    // verifies the payment itself and creates the order exactly once.
    try {
      const result = await repairOrder(reference);
      if (result.data?.reference) {
        const value = await getReceipt(reference).catch(() => null);
        if (value) {
          statusRef.current = String(value.status || "");
          setOrder(value);
          setPhase("ready");
          return;
        }
      }
      setPhase("awaiting_payment");
    } catch (error) {
      const pending = error instanceof ApiError && (String(error.payload?.status || "") === "pending" || error.status === 409 || error.status === 202);
      setPhase(pending ? "awaiting_payment" : "missing");
      setNotice(errorMessage(error, "We couldn't find this order yet."));
    }
  }, [reference]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polls = 0;
    const tick = async () => {
      if (!active) return;
      polls += 1;
      // Every few polls, let the repair engine retry building a missing order.
      await refresh(polls === 1 || polls % 4 === 0);
      if (active && !TERMINAL.has(statusRef.current) && polls < 150) {
        timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!order?.storefrontSlug) return;
    let active = true;
    getStorefront(order.storefrontSlug)
      .then((value) => {
        if (active) setStore(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [order?.storefrontSlug]);

  const handleRepair = async () => {
    setRepairing(true);
    try {
      const response = await repairOrder(reference);
      if (response.status === "success") toast.success(response.message || "Delivery confirmed.");
      else toast.info(response.message || "We're checking this order.");
      await refresh(false);
    } catch (error) {
      toast.info(errorMessage(error, "We're still checking this order. Please try again shortly."));
    } finally {
      setRepairing(false);
    }
  };

  const copyReference = async () => {
    try {
      await navigator.clipboard.writeText(reference);
      toast.success("Reference copied");
    } catch {
      toast.info(reference);
    }
  };

  const status = String(order?.status || "");
  const network = String(order?.network || "");
  const estimate = estimateFor(availability, network);
  const supportMessage = `Hello, I need help with my order${store ? ` on ${store.name}` : ""}. Reference: ${reference}`;
  const supportLink = whatsAppLink(store?.whatsapp, supportMessage) ||
    `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(supportMessage)}`;

  const lines: ReceiptLine[] = order
    ? [
        { label: "Network", value: networkName(network) },
        { label: "Recipient", value: order.phone || "—", mono: true },
        { label: "Bundle", value: order.label || `${order.volume || "—"}MB` },
        ...(store ? [{ label: "Seller", value: store.name }] : []),
      ]
    : [];

  const receiptData: ReceiptData | null = order
    ? {
        kind: "purchase",
        status: status === "delivered" ? "success" : TERMINAL.has(status) ? "failed" : "pending",
        title: order.label ? `${order.label} data bundle` : "Data bundle",
        reference: order.reference || reference,
        date: Number(order.createdAt || order.timestamp || 0),
        lines,
        amount: Number(order.amount || 0),
        charges: 0,
        total: Number(order.amount || 0),
        method: order.isGuest ? "Paystack" : order.paymentStatus === "success" ? "Paystack" : "Wallet",
        estimatedDelivery: status === "delivered" ? "Delivered" : estimate.label,
        note: `${order.label || "Bundle"} to ${order.phone} (${networkName(network)})`,
      }
    : null;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 py-8 sm:py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Order receipt</h1>
        <p className="text-sm text-muted">This page updates by itself. Keep the link to track your order any time.</p>
      </header>

      <button
        type="button"
        onClick={() => void copyReference()}
        className="flex items-center gap-2 self-start rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-border-strong"
      >
        <span className="max-w-[16rem] truncate font-mono">{reference}</span>
        <Copy className="size-3.5" aria-hidden />
        <span className="sr-only">Copy reference</span>
      </button>

      {phase === "loading" ? (
        <Card className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Checking your order…
        </Card>
      ) : phase === "awaiting_payment" || phase === "missing" ? (
        <Card className="flex flex-col items-center gap-4 py-8 text-center">
          {phase === "awaiting_payment" ? (
            <Loader2 className="size-7 animate-spin text-brand" aria-hidden />
          ) : (
            <XCircle className="size-7 text-warning" aria-hidden />
          )}
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold text-ink">
              {phase === "awaiting_payment" ? "Waiting for payment confirmation" : "We couldn't find this order yet"}
            </h2>
            <p className="max-w-sm text-sm text-muted">
              {phase === "awaiting_payment"
                ? "Mobile Money approvals can take a minute. Your data is sent as soon as the payment is confirmed."
                : notice || "If money left your account, use Repair with the reference from your Paystack email."}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void refresh(true)}>
              <RotateCcw className="size-4" aria-hidden /> Check again
            </Button>
            <Link href={`/repair?reference=${encodeURIComponent(reference)}`} className={buttonVariants("ghost", "sm")}>
              <Wrench className="size-4" aria-hidden /> Repair order
            </Link>
          </div>
        </Card>
      ) : order && receiptData ? (
        <>
          <Card className="flex flex-col gap-5">
            <Timeline status={status} />
            {!TERMINAL.has(status) ? (
              <p className="flex items-center justify-center gap-2 text-xs text-muted">
                Estimated delivery <DeliveryEstimate estimate={estimate} />
              </p>
            ) : null}
          </Card>
          <Card className="flex flex-col gap-5">
            <Receipt data={receiptData} onRetry={TERMINAL.has(status) && status !== "delivered" ? handleRepair : undefined} />
          </Card>
          {status !== "delivered" ? (
            <Card className="flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-ink-soft">Taking longer than expected?</p>
              <Button variant="secondary" onClick={() => void handleRepair()} loading={repairing}>
                <Wrench className="size-4" aria-hidden /> Check &amp; repair this order
              </Button>
              <p className="text-xs text-muted">We confirm with the network first and never charge you twice.</p>
            </Card>
          ) : null}
        </>
      ) : null}

      <a
        href={supportLink}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(buttonVariants("ghost", "md"), "self-center")}
      >
        <MessageCircle className="size-4" aria-hidden /> {store ? `Chat with ${store.name}` : "Chat with support"}
      </a>
    </main>
  );
}
