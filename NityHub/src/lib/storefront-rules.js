// Pure rules for reseller eStores. No Firebase, so they are unit tested.

/**
 * Subdomains a store may not claim: they are, or could become, platform hosts
 * (www.<base>, api.<base>) or would read as official pages to a buyer.
 */
export const RESERVED_STORE_SLUGS = new Set([
  "www", "api", "app", "admin", "dashboard", "store", "stores", "shop", "buy", "pay", "payment", "payments",
  "checkout", "receipt", "receipts", "repair", "support", "help", "mail", "email", "static", "cdn", "assets",
  "auth", "login", "signup", "account", "wallet", "status", "blog", "docs", "dev", "staging", "test",
  "nityhub", "official", "secure",
])

export function normalizeStoreSlug(value) {
  const slug = String(value || "").trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) || /--/.test(slug)) return ""
  return slug
}

/** A slug that is well-formed AND free to claim. */
export function isClaimableStoreSlug(value) {
  const slug = normalizeStoreSlug(value)
  return Boolean(slug) && !RESERVED_STORE_SLUGS.has(slug)
}

export function normalizeStoreName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 60)
}

export function normalizeStoreTagline(value) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().replace(/\s+/g, " ").slice(0, 120)
}

/**
 * An optional custom domain (e.g. "data.example.com"). Lowercased, no scheme,
 * port or path, at least one dot, and never an IP or localhost. Returns "" for
 * blank input and null for an invalid one so callers can tell them apart.
 */
export function normalizeCustomDomain(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/\.$/, "")
  if (!raw) return ""
  if (raw.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(raw)) return null
  if (raw === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(raw)) return null
  return raw
}

/** Firebase keys cannot contain dots, so domains are stored under an encoded key. */
export function customDomainKey(domain) {
  return String(domain || "").replace(/\./g, ",")
}

export function storePrice(wholesale, margin) {
  const costUnits = Math.round(Number(wholesale) * 100)
  const marginUnits = Math.round(Number(margin) * 100)
  if (!Number.isSafeInteger(costUnits) || costUnits <= 0 || !Number.isSafeInteger(marginUnits) || marginUnits < 0 || marginUnits > 100_000) return null
  return (costUnits + marginUnits) / 100
}

export function calculateStoreProfit(retail, wholesale) {
  const units = Math.round(Number(retail) * 100) - Math.round(Number(wholesale) * 100)
  return Number.isSafeInteger(units) && units > 0 ? units / 100 : 0
}

export function isValidReceiptEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()) && String(value).length <= 254
}

/**
 * "024•••4567". A guest receipt link is a bearer capability that can be
 * forwarded, so it confirms the recipient without disclosing their number.
 */
export function maskPhoneNumber(value) {
  const digits = String(value || "").replace(/\D/g, "")
  if (digits.length < 7) return digits ? "•••" : ""
  return `${digits.slice(0, 3)}•••${digits.slice(-4)}`
}

/** wa.me wants the international form without "+": 0241234567 -> 233241234567. */
export function toWhatsAppNumber(value) {
  const digits = String(value || "").replace(/\D/g, "")
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`
  if (/^233\d{9}$/.test(digits)) return digits
  return ""
}
