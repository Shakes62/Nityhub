import { normalizePhone } from "@/lib/format";

/** Ghana local-number prefixes per network, used for a soft mismatch hint. */
export const NETWORK_PREFIXES: Record<string, string[]> = {
  mtn: ["024", "025", "053", "054", "055", "059"],
  telecel: ["020", "050"],
  at: ["026", "027", "056", "057"],
};

/** The network a 10-digit local number most likely belongs to, or null. */
export function detectNetwork(phone: string): string | null {
  const p = normalizePhone(phone);
  if (p.length !== 10) return null;
  const prefix = p.slice(0, 3);
  for (const [network, list] of Object.entries(NETWORK_PREFIXES)) {
    if (list.includes(prefix)) return network;
  }
  return null;
}

/** wa.me wants the international form without "+": 0241234567 -> 233241234567. */
export function toWhatsAppNumber(value: string | null | undefined): string {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
  if (/^233\d{9}$/.test(digits)) return digits;
  return "";
}

export function whatsAppLink(number: string | null | undefined, message: string): string {
  const target = toWhatsAppNumber(number);
  return target ? `https://wa.me/${target}?text=${encodeURIComponent(message)}` : "";
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.trim().length <= 254;
}
