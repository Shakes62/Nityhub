/** Data networks supported on the Buy page (matches the original buy.html). */
export interface NetworkOption {
  value: string;
  label: string;
}

export const NETWORKS: NetworkOption[] = [
  { value: "mtn", label: "MTN" },
  { value: "at", label: "AirtelTigo" },
  { value: "telecel", label: "Telecel" },
];

/**
 * Telco brand identity. These are third-party brand colors, deliberately kept
 * out of the jade design tokens.
 *
 * `tint`/`ring` are pre-mixed rgba so they can be used inline without relying
 * on Tailwind's arbitrary-value JIT for dynamic values (which does not work
 * with runtime strings).
 */
export interface NetworkTheme {
  /** Solid brand color. */
  color: string;
  /** Readable text color when placed on `color`. */
  onColor: string;
  /** Soft background wash. */
  tint: string;
  /** Border/ring color at low opacity. */
  ring: string;
}

export const NETWORK_THEME: Record<string, NetworkTheme> = {
  mtn: {
    color: "#FFCB05",
    onColor: "#1A1A00",
    tint: "rgba(255, 203, 5, 0.12)",
    ring: "rgba(255, 203, 5, 0.45)",
  },
  at: {
    color: "#1D4ED8",
    onColor: "#FFFFFF",
    tint: "rgba(29, 78, 216, 0.10)",
    ring: "rgba(29, 78, 216, 0.40)",
  },
  telecel: {
    color: "#E60000",
    onColor: "#FFFFFF",
    tint: "rgba(230, 0, 0, 0.10)",
    ring: "rgba(230, 0, 0, 0.40)",
  },
};

const FALLBACK_THEME: NetworkTheme = {
  color: "var(--color-muted)",
  onColor: "#FFFFFF",
  tint: "var(--color-surface-muted)",
  ring: "var(--color-border)",
};

export function networkTheme(network: string | null | undefined): NetworkTheme {
  return NETWORK_THEME[String(network || "").toLowerCase()] ?? FALLBACK_THEME;
}
