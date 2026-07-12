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
  dot = false,
  children,
  className,
}: {
  tone?: BadgeTone;
  /** Render a leading status dot (pulses while a "warning"/pending state is live). */
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium tabular",
        TONES[tone],
        className,
      )}
    >
      {dot ? (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-current opacity-80",
            tone === "warning" && "animate-pulse motion-reduce:animate-none",
          )}
          aria-hidden
        />
      ) : null}
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
