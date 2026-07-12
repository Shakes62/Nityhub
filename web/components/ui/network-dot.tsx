import { cn } from "@/lib/cn";

/**
 * Telco brand colors — external network identifiers, intentionally kept outside
 * the jade design tokens (they are third-party brand data, not theme colors).
 */
const NETWORK_COLORS: Record<string, string> = {
  mtn: "#FFCB05",
  at: "#1D4ED8",
  telecel: "#E60000",
};

/** A small color dot identifying the mobile network. Presentational only. */
export function NetworkDot({
  network,
  className,
}: {
  network: string | null | undefined;
  className?: string;
}) {
  const color = NETWORK_COLORS[String(network || "").toLowerCase()] ?? "var(--color-muted)";
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}
