"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  AlertCircle,
  ArrowRight,
  MessageCircle,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { PageHero } from "@/components/layout/page-hero";
import { Badge } from "@/components/ui/badge";
import { repairOrder } from "@/services/api";
import { SUPPORT_WHATSAPP } from "@/constants/config";
import { cn } from "@/lib/cn";
import { ApiError } from "@/types/api";
import { errorMessage } from "@/lib/errors";

export default function RepairPage() {
  const [reference, setReference] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{
    status: string;
    message: string;
    reference?: string;
  } | null>(null);

  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("reference");
    if (param) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReference(param.trim());
    }
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = reference.trim();
    if (!value) return;
    setWorking(true);
    setResult(null);
    try {
      const response = await repairOrder(value);
      setResult({
        status: response.status,
        message: response.message,
        reference: response.data?.reference || value,
      });
    } catch (error) {
      // 409/503 with status "pending" means "still in progress", not a failure.
      const payloadStatus = error instanceof ApiError ? String(error.payload?.status || "") : "";
      setResult({
        status: payloadStatus === "pending" ? "pending" : "error",
        message: errorMessage(error, "Could not check this order. Please verify the reference."),
        reference: payloadStatus === "pending" ? value : undefined,
      });
    } finally {
      setWorking(false);
    }
  };

  const supportMessage = result
    ? `Hello, I tried the self-service order repair for reference ${result.reference || reference}.\nStatus: ${result.status}\nMessage: ${result.message}`
    : `Hello, I need help repairing my data order. Reference: ${reference}`;
  const whatsappUrl = `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(supportMessage)}`;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:py-12">
      <PageHero
        title="Track & repair an order"
        description="Delayed or interrupted delivery? Enter your order or payment reference and we'll finish it safely."
      />

      <Card className="flex flex-col gap-5">
        <CardHeader
          title="Check an order"
          description="We confirm your payment and the network's delivery status before doing anything. You are never charged twice."
        />

        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field
            label="Order or payment reference"
            htmlFor="repair-reference"
            hint="Enter your internal order reference (DATA_...) or Paystack payment reference (e.g. T... or trx_...)."
          >
            <Input
              id="repair-reference"
              autoComplete="off"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="e.g. DATA_1729... or T123456789"
              required
            />
          </Field>

          <Button type="submit" loading={working} className="w-full sm:w-auto">
            <Wrench className="size-4" />
            Check and repair order
          </Button>
        </form>

        {result ? (
          <div
            role="status"
            className={cn(
              "flex flex-col gap-3 rounded-lg border p-4 text-sm transition-all",
              result.status === "success"
                ? "border-success/30 bg-success-soft/30"
                : result.status === "error"
                  ? "border-danger/30 bg-danger-soft/30"
                  : "border-warning/30 bg-warning-soft/30",
            )}
          >
            <div className="flex items-center gap-2">
              {result.status === "success" ? (
                <CheckCircle2 className="size-5 text-success" />
              ) : result.status === "error" ? (
                <AlertCircle className="size-5 text-danger" />
              ) : (
                <Clock className="size-5 text-warning" />
              )}
              <Badge
                tone={
                  result.status === "success"
                    ? "success"
                    : result.status === "error"
                      ? "danger"
                      : "warning"
                }
              >
                {result.status === "success"
                  ? "Delivery Confirmed"
                  : result.status === "error"
                    ? "Needs Attention"
                    : "Processing Delivery"}
              </Badge>
            </div>

            <p className="text-sm font-medium text-ink">{result.message}</p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {result.reference ? (
                <Link
                  href={`/receipt/${encodeURIComponent(result.reference)}`}
                  className={cn(buttonVariants("primary", "sm"))}
                >
                  View full receipt <ArrowRight className="size-3.5" />
                </Link>
              ) : null}

              {result.status === "error" || result.status === "pending" ? (
                <a
                  href={whatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants("secondary", "sm"))}
                >
                  <MessageCircle className="size-3.5" />
                  Chat on WhatsApp
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </Card>

      {/* Helpful information card */}
      <Card className="flex flex-col gap-4 bg-surface-soft/40 text-sm">
        <div className="flex items-center gap-2 text-ink">
          <ShieldCheck className="size-5 text-brand" />
          <h2 className="font-semibold">How repair protects you</h2>
        </div>

        <ul className="flex flex-col gap-2 text-xs text-muted">
          <li className="flex items-start gap-2">
            <span className="text-brand">•</span>
            <span>
              <strong>Where to find your reference:</strong> Logged-in users can find their reference in{" "}
              <Link href="/orders" className="text-brand underline">Order History</Link>. Guest storefront buyers can find it on their SMS receipt, mobile banking debit alert, or Paystack email.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-brand">•</span>
            <span>
              <strong>Double-benefit defense:</strong> Orders that were already refunded to your wallet cannot be re-dispatched.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-brand">•</span>
            <span>
              <strong>No double billing:</strong> The repair engine verifies your captured payment and reconciles with upstream telcos before dispatching to an alternate healthy carrier.
            </span>
          </li>
        </ul>
      </Card>
    </main>
  );
}
