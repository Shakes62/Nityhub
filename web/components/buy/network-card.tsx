"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { networkTheme, type NetworkOption } from "@/constants/networks";
import { DeliveryEstimate } from "@/components/buy/delivery-estimate";
import type { DeliveryEstimate as Estimate } from "@/types/engagement";

/**
 * A tappable network tile carrying the telco's own brand color, so the user can
 * tell at a glance which network they are buying for. Shared by the Buy page,
 * step 1 of the buy flow, and reseller storefronts so all read identically.
 */
export function NetworkCard({
  network,
  onSelect,
  className,
  paused = false,
  loading = false,
  estimate,
}: {
  network: NetworkOption;
  onSelect: (value: string) => void;
  className?: string;
  /** Carrier/admin maintenance: the card stays visible but cannot be opened. */
  paused?: boolean;
  /** Availability not known yet. */
  loading?: boolean;
  estimate?: Estimate;
}) {
  const theme = networkTheme(network.value);
  const disabled = paused || loading;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(network.value)}
      aria-label={paused ? `${network.label} is temporarily paused` : `Buy ${network.label} data`}
      className={cn(
        "group flex min-h-[4.5rem] items-center gap-3 rounded-xl border p-3.5 text-left",
        "transition-all hover:-translate-y-0.5 hover:shadow-sm active:translate-y-0 active:scale-[0.99]",
        "focus:outline-none focus:ring-2 motion-reduce:transition-none",
        paused && "cursor-not-allowed opacity-60 hover:translate-y-0 hover:shadow-none",
        loading && "cursor-progress",
        className,
      )}
      style={{
        borderColor: theme.ring,
        backgroundColor: theme.tint,
        // @ts-expect-error -- custom property consumed by focus:ring via Tailwind ring color
        "--tw-ring-color": theme.ring,
      }}
    >
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold"
        style={{ backgroundColor: theme.color, color: theme.onColor }}
        aria-hidden
      >
        {network.label.slice(0, 2).toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="block truncate font-semibold text-ink">{network.label}</span>
        <span className="block text-xs text-muted">
          {paused ? "Network temporarily paused by carrier" : loading ? "Checking availability…" : "Tap to see bundles"}
        </span>
        {estimate && !loading ? <DeliveryEstimate estimate={estimate} className="self-start" /> : null}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
