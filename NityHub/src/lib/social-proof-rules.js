/**
 * Social proof, proof-of-delivery, and delivery-estimate rules.
 *
 * Pure functions only (no Firebase), so the privacy and honesty guarantees are
 * unit tested:
 *   1. Privacy   - a proof never carries a phone number, uid, email or amount.
 *   2. Freshness - only deliveries from the last 12 hours are shown.
 *   3. Outliers  - only deliveries within the 15-minute SLA are showcased.
 *   4. Honesty   - nothing is invented. With no real deliveries the ticker is
 *                  simply hidden; estimates fall back to a stated baseline.
 */

export const MAX_DELIVERY_SLA_SECONDS = 15 * 60
export const FRESHNESS_WINDOW_MS = 12 * 60 * 60 * 1000
/** Fewer samples than this and a median says more about luck than the route. */
export const MIN_ESTIMATE_SAMPLES = 3
/** Ignore pathological durations when estimating (stuck orders fixed by hand). */
const MAX_ESTIMATE_SAMPLE_SECONDS = 6 * 60 * 60

const NETWORK_LABELS = {
  mtn: "MTN",
  telecel: "Telecel",
  at: "AirtelTigo",
}

export function normalizeProofNetwork(value) {
  const raw = String(value || "").toLowerCase().trim()
  if (raw === "at" || raw === "airteltigo" || raw === "airtel" || raw === "tigo") return "at"
  if (raw === "telecel" || raw === "vodafone") return "telecel"
  if (raw === "mtn" || raw === "mtnup2u") return "mtn"
  return ""
}

/** Format elapsed seconds into shorthand ("34s", "1m 12s", "4m"). */
export function formatDurationText(seconds) {
  const safeSeconds = Math.max(1, Math.round(Number(seconds) || 1))
  if (safeSeconds < 60) {
    return `${safeSeconds}s`
  }
  const minutes = Math.floor(safeSeconds / 60)
  const remainingSecs = safeSeconds % 60
  if (remainingSecs === 0) {
    return `${minutes}m`
  }
  return `${minutes}m ${remainingSecs}s`
}

/** Format relative elapsed time ("just now", "2 mins ago", "1 hour ago"). */
export function formatRelativeAgo(msAgo) {
  const seconds = Math.max(0, Math.floor(Number(msAgo || 0) / 1000))
  if (seconds < 60) {
    return "just now"
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes} min${minutes === 1 ? "" : "s"} ago`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours} hour${hours === 1 ? "" : "s"} ago`
}

/** "5GB", "1.5GB", "500MB" from a catalog volume in MB (1000 MB = 1 GB). */
export function formatVolumeLabel(volume) {
  const mb = Number(volume || 0)
  if (!Number.isFinite(mb) || mb <= 0) return ""
  if (mb < 1000) return `${Math.round(mb)}MB`
  const gb = mb / 1000
  return `${Number.isInteger(gb) ? gb : Number(gb.toFixed(1))}GB`
}

/**
 * The anonymous record written to the public delivery feed when an order is
 * delivered. Deliberately a whitelist: only network, package and timing.
 */
export function buildDeliveryFeedEntry(order, deliveredAt = Date.now()) {
  if (!order || typeof order !== "object") return null
  const network = normalizeProofNetwork(order.network)
  if (!network) return null
  const startedAt = Number(order.createdAt || order.timestamp || 0)
  const completedAt = Number(order.deliveredAt || deliveredAt || 0)
  if (!startedAt || !completedAt || completedAt < startedAt) return null
  const label = String(order.label || "").trim().slice(0, 24) || formatVolumeLabel(order.volume)
  return {
    network,
    packageLabel: label,
    startedAt,
    deliveredAt: completedAt,
    durationSeconds: Math.max(1, Math.round((completedAt - startedAt) / 1000)),
  }
}

/**
 * Sanitize a delivered order (or feed entry) into a public proof item.
 * Returns null unless it is delivered, fresh, timed, and within SLA.
 */
export function sanitizeDeliveryProof(order, currentTime = Date.now()) {
  if (!order || typeof order !== "object") return null

  const status = String(order.status || "delivered").toLowerCase()
  if (status !== "delivered") return null

  const completedAt = Number(order.deliveredAt || order.statusUpdatedAt || order.updatedAt || 0)
  if (!completedAt || Number.isNaN(completedAt)) return null

  const ageMs = currentTime - completedAt
  if (ageMs < 0 || ageMs > FRESHNESS_WINDOW_MS) return null

  const startedAt = Number(order.startedAt || order.createdAt || order.timestamp || 0)
  if (!startedAt || startedAt > completedAt) return null
  const durationSeconds = Math.max(1, Math.round((completedAt - startedAt) / 1000))
  if (durationSeconds > MAX_DELIVERY_SLA_SECONDS) return null

  const network = normalizeProofNetwork(order.network)
  if (!network) return null
  const networkLabel = NETWORK_LABELS[network]
  const packageLabel = String(order.packageLabel || order.label || "").trim().slice(0, 24) ||
    formatVolumeLabel(order.volume) || `${networkLabel} data`

  return {
    id: `proof-${completedAt.toString(36)}-${durationSeconds}`,
    network,
    networkLabel,
    packageLabel,
    durationSeconds,
    durationText: formatDurationText(durationSeconds),
    completedAt,
    completedAgoText: formatRelativeAgo(ageMs),
  }
}

/** Real, sanitized, newest-first proofs. Never padded with invented entries. */
export function filterAndFormatDeliveries(orders, maxItems = 10, currentTime = Date.now()) {
  const items = Array.isArray(orders) ? orders : []
  const sanitized = []
  for (const order of items) {
    const proof = sanitizeDeliveryProof(order, currentTime)
    if (proof) sanitized.push(proof)
  }
  sanitized.sort((a, b) => b.completedAt - a.completedAt)
  return sanitized.slice(0, maxItems)
}

export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The baseline shown whenever measured data is too thin. Never "Unavailable". */
export const BASELINE_ESTIMATE = Object.freeze({ label: "Usually 5–15 min", tone: "standard", measured: false, samples: 0 })

/**
 * Turn a median delivery time into a customer-facing range.
 *   <= 5 min  -> "~1–5 min"  (fast, subtle green)
 *   <= 15 min -> "~5–15 min" (standard, neutral)
 *   slower    -> honest wider ranges, still never "Unavailable"
 */
export function describeEstimate(medianSeconds, samples) {
  if (!Number.isFinite(medianSeconds) || samples < MIN_ESTIMATE_SAMPLES) return { ...BASELINE_ESTIMATE, samples }
  const base = { measured: true, samples, medianSeconds: Math.round(medianSeconds) }
  if (medianSeconds <= 60) return { ...base, label: "Under 1 min", tone: "fast" }
  if (medianSeconds <= 5 * 60) return { ...base, label: "~1–5 min", tone: "fast" }
  if (medianSeconds <= 15 * 60) return { ...base, label: "~5–15 min", tone: "standard" }
  if (medianSeconds <= 30 * 60) return { ...base, label: "~15–30 min", tone: "standard" }
  return { ...base, label: "Within 1 hour", tone: "standard" }
}

/**
 * Per-network delivery estimates from the recent delivery feed. Unlike the
 * ticker, slow deliveries are included: an estimate that hid them would be
 * optimistic exactly when buyers most need it to be accurate.
 */
export function computeDeliveryEstimates(entries, currentTime = Date.now(), networks = ["mtn", "telecel", "at"]) {
  const byNetwork = Object.fromEntries(networks.map((network) => [network, []]))
  for (const entry of Array.isArray(entries) ? entries : []) {
    const network = normalizeProofNetwork(entry?.network)
    if (!byNetwork[network]) continue
    const deliveredAt = Number(entry?.deliveredAt || 0)
    if (!deliveredAt || currentTime - deliveredAt > FRESHNESS_WINDOW_MS || deliveredAt > currentTime) continue
    const seconds = Number(entry?.durationSeconds || 0)
    if (seconds > 0 && seconds <= MAX_ESTIMATE_SAMPLE_SECONDS) byNetwork[network].push(seconds)
  }
  return Object.fromEntries(Object.entries(byNetwork).map(([network, samples]) => [
    network, describeEstimate(median(samples), samples.length),
  ]))
}
