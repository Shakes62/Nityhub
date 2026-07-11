import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "success" | "info" | "warning" | "danger";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-muted text-ink-soft",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Map an order/transaction status string to a badge tone (from orders.js). */
export function statusTone(status: string | null | undefined): BadgeTone {
  const value = String(status || "").toLowerCase();
  if (value === "completed" || value === "delivered") return "success";
  if (value === "accepted") return "info";
  if (value === "pending" || value === "processing") return "warning";
  return "danger";
}

/** Humanize a status: "in_progress" -> "In progress". */
export function statusLabel(status: string | null | undefined): string {
  const value = String(status || "").trim().replace(/_/g, " ");
  if (!value) return "Unknown";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
