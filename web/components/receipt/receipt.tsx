"use client";

import type { ReactNode } from "react";
import {
  CheckCircle2,
  Clock,
  Download,
  MessageCircle,
  Printer,
  RotateCcw,
  Share2,
  XCircle,
} from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatDate, formatMoney } from "@/lib/format";
import { SUPPORT_WHATSAPP } from "@/constants/config";
import { useToast } from "@/contexts/toast-context";

export type ReceiptStatus = "success" | "pending" | "failed";

export interface ReceiptLine {
  label: string;
  value: ReactNode;
  /** Plain-text value for share/print/download (defaults to String(value)). */
  text?: string;
  mono?: boolean;
}

export interface ReceiptData {
  kind: "purchase" | "deposit";
  status: ReceiptStatus;
  title: string;
  reference: string;
  date: number;
  /** Descriptive rows (beneficiary, network, package, …). */
  lines: ReceiptLine[];
  amount: number;
  charges?: number;
  total?: number;
  method: string;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  estimatedDelivery?: string;
  /** Extra context appended to the support message. */
  note?: string;
}

const STATUS_META: Record<
  ReceiptStatus,
  { tone: BadgeTone; label: string; Icon: typeof CheckCircle2; ring: string; fg: string }
> = {
  success: { tone: "success", label: "Successful", Icon: CheckCircle2, ring: "bg-success-soft", fg: "text-success" },
  pending: { tone: "warning", label: "Pending", Icon: Clock, ring: "bg-warning-soft", fg: "text-warning" },
  failed: { tone: "danger", label: "Failed", Icon: XCircle, ring: "bg-danger-soft", fg: "text-danger" },
};

function buildReceiptText(data: ReceiptData): string {
  const rows: string[] = [
    "NityHub Receipt",
    "====================",
    data.title,
    `Status:      ${STATUS_META[data.status].label}`,
    `Reference:   ${data.reference}`,
    `Date:        ${formatDate(data.date)}`,
    "--------------------",
    ...data.lines.map((l) => `${(l.label + ":").padEnd(12)} ${l.text ?? String(l.value)}`),
    "--------------------",
    `Amount:      ${formatMoney(data.amount)}`,
  ];
  if (data.charges != null) rows.push(`Charges:     ${formatMoney(data.charges)}`);
  if (data.total != null) rows.push(`Total:       ${formatMoney(data.total)}`);
  rows.push(`Method:      ${data.method}`);
  if (data.balanceBefore != null) rows.push(`Bal. before: ${formatMoney(data.balanceBefore)}`);
  if (data.balanceAfter != null) rows.push(`Bal. after:  ${formatMoney(data.balanceAfter)}`);
  if (data.estimatedDelivery) rows.push(`Delivery:    ${data.estimatedDelivery}`);
  rows.push("====================", "Thank you for using NityHub.");
  return rows.join("\n");
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className={cn("min-w-0 truncate text-right text-sm text-ink", mono && "font-mono text-[0.8125rem]")}>
        {value}
      </dd>
    </div>
  );
}

/**
 * A professional, self-contained transaction receipt used for both bundle
 * purchases and wallet deposits. Presentational + a few share/export actions;
 * the parent supplies the fully-computed {@link ReceiptData}.
 */
export function Receipt({ data, onRetry }: { data: ReceiptData; onRetry?: () => void }) {
  const toast = useToast();
  const meta = STATUS_META[data.status];
  const supportText = [
    `Hello, I need help with my ${data.kind}.`,
    `Reference: ${data.reference}`,
    `Status: ${meta.label}`,
    data.note || "",
  ]
    .filter(Boolean)
    .join("\n");
  const supportLink = `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(supportText)}`;

  const share = async () => {
    const text = buildReceiptText(data);
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: data.title, text });
        return;
      } catch {
        return; // user cancelled — do nothing
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Receipt copied to clipboard");
    } catch {
      toast.error("Sharing isn't supported on this device");
    }
  };

  const download = () => {
    const blob = new Blob([buildReceiptText(data)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nityhub-receipt-${data.reference}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const print = () => {
    const win = window.open("", "_blank", "width=420,height=640");
    if (!win) {
      toast.error("Enable pop-ups to print the receipt");
      return;
    }
    const safe = buildReceiptText(data)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    win.document.write(
      `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;padding:24px;white-space:pre-wrap">${safe}</pre>`,
    );
    win.document.close();
    win.focus();
    win.print();
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Status header */}
      <div className="flex flex-col items-center gap-2 text-center">
        <span className={cn("flex size-14 items-center justify-center rounded-full", meta.ring)}>
          <meta.Icon className={cn("size-7", meta.fg)} />
        </span>
        <div>
          <p className="text-lg font-semibold text-ink">
            {data.status === "success"
              ? data.kind === "deposit"
                ? "Deposit successful"
                : "Order placed"
              : data.status === "pending"
                ? "Processing"
                : data.kind === "deposit"
                  ? "Deposit failed"
                  : "Order failed"}
          </p>
          <p className="mt-0.5 text-2xl font-semibold tabular text-ink">{formatMoney(data.total ?? data.amount)}</p>
        </div>
        <Badge tone={meta.tone} dot>
          {meta.label}
        </Badge>
      </div>

      {/* Reference + date */}
      <dl className="rounded-lg border border-border bg-surface-soft px-4 py-2">
        <Row label="Reference" value={data.reference} mono />
        <Row label="Date" value={formatDate(data.date)} />
      </dl>

      {/* Details */}
      <dl className="rounded-lg border border-dashed border-border px-4 py-2">
        {data.lines.map((line) => (
          <Row key={line.label} label={line.label} value={line.value} mono={line.mono} />
        ))}
      </dl>

      {/* Amounts */}
      <dl className="rounded-lg border border-border px-4 py-2">
        <Row label="Amount" value={formatMoney(data.amount)} />
        {data.charges != null ? <Row label="Charges" value={formatMoney(data.charges)} /> : null}
        {data.total != null ? (
          <div className="flex items-baseline justify-between gap-4 border-t border-border py-2">
            <dt className="text-sm font-semibold text-ink">Total</dt>
            <dd className="text-sm font-semibold tabular text-ink">{formatMoney(data.total)}</dd>
          </div>
        ) : null}
        <Row label="Payment method" value={data.method} />
        {data.balanceBefore != null ? <Row label="Balance before" value={formatMoney(data.balanceBefore)} /> : null}
        {data.balanceAfter != null ? <Row label="Balance after" value={formatMoney(data.balanceAfter)} /> : null}
        {data.estimatedDelivery ? <Row label="Est. delivery" value={data.estimatedDelivery} /> : null}
      </dl>

      {/* Actions */}
      <div className="grid grid-cols-2 gap-2">
        {data.status === "failed" && onRetry ? (
          <Button variant="primary" size="sm" onClick={onRetry} className="col-span-2">
            <RotateCcw className="size-4" />
            Retry
          </Button>
        ) : null}
        <a
          href={supportLink}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants("secondary", "sm"), "col-span-2 w-full")}
        >
          <MessageCircle className="size-4" />
          Contact support
        </a>
        <Button variant="subtle" size="sm" onClick={share}>
          <Share2 className="size-4" />
          Share
        </Button>
        <Button variant="subtle" size="sm" onClick={download}>
          <Download className="size-4" />
          Download
        </Button>
        <Button variant="subtle" size="sm" onClick={print} className="col-span-2">
          <Printer className="size-4" />
          Print
        </Button>
      </div>
    </div>
  );
}
