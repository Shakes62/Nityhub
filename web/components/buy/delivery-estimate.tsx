import { Clock, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DeliveryEstimate as Estimate } from "@/types/engagement";

/**
 * Delivery-time chip (blueprint 7.3). Fast routes get a subtle green, every
 * other route a calm neutral. There is no "unavailable" state: with thin data
 * the server sends a stated baseline, and a paused network is shown by the
 * card itself, not by overwriting the time.
 */
export function DeliveryEstimate({ estimate, className }: { estimate: Estimate; className?: string }) {
  const fast = estimate.tone === "fast";
  const Icon = fast ? Zap : Clock;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular",
        fast ? "bg-success-soft text-success" : "bg-surface-muted text-ink-soft",
        className,
      )}
      title={estimate.measured ? `Median of ${estimate.samples} recent deliveries` : "Typical delivery time"}
    >
      <Icon className={cn("size-3", fast && "fill-current")} aria-hidden />
      {estimate.label}
    </span>
  );
}
