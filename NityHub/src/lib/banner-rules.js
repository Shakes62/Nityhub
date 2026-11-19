/**
 * Pure rules and validation for dynamic promotional, operational, and
 * announcement banners.
 */

export const BANNER_VARIANTS = ["promotion", "operational", "announcement"]
const BANNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Seeded once on a fresh install so the shop is not bare. Each one describes
 * a real feature - no invented prices, promotions or uptime claims.
 */
export function getDefaultBanners() {
  return [
    {
      id: "banner-default-estore",
      variant: "promotion",
      title: "Open your own data eStore",
      message: "Resellers can launch a branded store in a minute, set their own margins, and earn on every sale.",
      actionLabel: "Set up your store",
      actionUrl: "/store",
      enabled: true,
      priority: 10,
      startsAt: null,
      endsAt: null,
      createdAt: 1729200000000,
      updatedAt: 1729200000000,
    },
    {
      id: "banner-default-announcement",
      variant: "announcement",
      title: "Self-service order repair",
      message: "Order delayed or interrupted? Check it with your reference and we will safely finish delivery without charging you again.",
      actionLabel: "Repair an order",
      actionUrl: "/repair",
      enabled: true,
      priority: 1,
      startsAt: null,
      endsAt: null,
      createdAt: 1729200000000,
      updatedAt: 1729200000000,
    },
  ]
}

export function isValidBannerId(value) {
  return BANNER_ID_PATTERN.test(String(value || ""))
}

/**
 * Call-to-action links are rendered as <a href>, so only an in-app path or an
 * https URL is accepted. Anything else (javascript:, data:, protocol-relative
 * //evil.example) is refused rather than silently dropped.
 */
export function normalizeBannerActionUrl(value) {
  const url = String(value || "").trim()
  if (!url) return null
  if (url.length > 200) throw new Error("Banner link must be 200 characters or fewer")
  if (/^\/(?!\/)[^\s]*$/.test(url)) return url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "https:" && parsed.hostname) return parsed.toString()
  } catch {
    // fall through
  }
  throw new Error("Banner link must be an in-app path like /buy or an https:// URL")
}

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") return null
  const numeric = typeof value === "number" ? value : Date.parse(String(value))
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

export function normalizeBanner(input, existingId = null, existing = null) {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid banner payload")
  }

  const rawVariant = String(input.variant || "announcement").toLowerCase().trim()
  const variant = BANNER_VARIANTS.includes(rawVariant) ? rawVariant : "announcement"

  const title = String(input.title || "").trim()
  if (!title) {
    throw new Error("Banner title is required")
  }
  if (title.length > 120) {
    throw new Error("Banner title must be 120 characters or fewer")
  }

  const message = String(input.message || "").trim()
  if (!message) {
    throw new Error("Banner message is required")
  }
  if (message.length > 300) {
    throw new Error("Banner message must be 300 characters or fewer")
  }

  const actionUrl = normalizeBannerActionUrl(input.actionUrl)
  const actionLabel = actionUrl && input.actionLabel ? String(input.actionLabel).trim().slice(0, 40) || null : null
  if (actionUrl && !actionLabel) {
    throw new Error("Add button text for the banner link")
  }

  const startsAt = toTimestamp(input.startsAt)
  const endsAt = toTimestamp(input.endsAt)
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new Error("Banner end time must be after its start time")
  }

  const candidateId = String(existingId || input.id || "").trim()
  if (candidateId && !isValidBannerId(candidateId)) {
    throw new Error("Invalid banner id")
  }
  const id = candidateId || `banner-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const enabled = input.enabled !== false
  const priority = Number.isFinite(Number(input.priority)) ? Math.max(-100, Math.min(100, Math.round(Number(input.priority)))) : 0
  const now = Date.now()

  return {
    id,
    variant,
    title,
    message,
    actionLabel,
    actionUrl,
    enabled,
    priority,
    startsAt,
    endsAt,
    // createdAt is owned by the server: kept from the stored record on edit.
    createdAt: Number(existing?.createdAt || now),
    updatedAt: now,
  }
}

export function isBannerLive(banner, now = Date.now()) {
  if (!banner || banner.enabled !== true) return false
  if (banner.startsAt && Number(banner.startsAt) > now) return false
  if (banner.endsAt && Number(banner.endsAt) <= now) return false
  return true
}

export function sortBanners(banners, activeOnly = true, now = Date.now()) {
  const list = Array.isArray(banners) ? banners : Object.values(banners || {})
  const filtered = activeOnly ? list.filter((b) => isBannerLive(b, now)) : list.filter(Boolean)

  return filtered.sort((a, b) => {
    const priorityDiff = Number(b.priority || 0) - Number(a.priority || 0)
    if (priorityDiff !== 0) return priorityDiff
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
  })
}
