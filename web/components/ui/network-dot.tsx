import { cn } from "@/lib/cn";
import { networkTheme } from "@/constants/networks";

/** A small color dot identifying the mobile network. Presentational only. */
export function NetworkDot({
  network,
  className,
}: {
  network: string | null | undefined;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: networkTheme(network).color }}
      aria-hidden
    />
  );
}
