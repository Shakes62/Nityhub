"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { networkTheme, type NetworkOption } from "@/constants/networks";

/**
 * A tappable network tile carrying the telco's own brand color, so the user can
 * tell at a glance which network they are buying for. Shared by the Buy page
 * and step 1 of the buy flow so both read identically.
 */
export function NetworkCard({
  network,
  onSelect,
  className,
}: {
  network: NetworkOption;
  onSelect: (value: string) => void;
  className?: string;
}) {
  const theme = networkTheme(network.value);

  return (
    <button
      type="button"
      onClick={() => onSelect(network.value)}
      aria-label={`Buy ${network.label} data`}
      className={cn(
        "group flex items-center gap-3 rounded-xl border p-3.5 text-left",
        "transition-all hover:-translate-y-0.5 hover:shadow-sm active:translate-y-0 active:scale-[0.99]",
        "focus:outline-none focus:ring-2",
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
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-ink">{network.label}</span>
        <span className="block text-xs text-muted">Tap to see bundles</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
