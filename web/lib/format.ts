/**
 * Formatting helpers shared across the app. These mirror the behavior of the
 * original public/js/common.js so displayed values stay identical after the
 * migration (GHS currency, en-GB dates, 10-digit local phone normalization).
 */

const moneyFormatter = new Intl.NumberFormat("en-GH", {
  style: "currency",
  currency: "GHS",
  minimumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Format a number as GHS currency, e.g. 12 -> "GHS 12.00". */
export function formatMoney(value: number | string | null | undefined): string {
  return moneyFormatter.format(Number(value || 0));
}

/** Format a millisecond timestamp; returns "-" for falsy/zero values. */
export function formatDate(value: number | string | null | undefined): string {
  const ts = Number(value || 0);
  if (!ts) {
    return "-";
  }
  return dateFormatter.format(new Date(ts));
}

/** Reduce any input to the last 10 digits (Ghana local phone format). */
export function normalizePhone(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\D/g, "")
    .slice(-10);
}

/** Truncate a long reference for compact table display. */
export function shortRef(value: string | null | undefined, max = 14): string {
  const ref = String(value || "");
  if (!ref) {
    return "-";
  }
  return ref.length <= max ? ref : `${ref.slice(0, max - 4)}...`;
}
