// Pure helpers for the PBM HUB Developer Platform provider.
//
// Free of Firebase imports so the two rules that decide whether a customer gets
// their money back - failure classification and status normalisation - are unit
// testable in isolation.
//
// PBM HUB wraps every response in `{ success, message, data }` and names its
// failures with a machine-readable `error_code`. That code is authoritative
// here; the free-text heuristics below are only a fallback for responses that
// predate a code or come from an edge (a proxy 502, say) that never reaches
// their application layer.

import { normalizeInternalOrderStatus } from "./order-status.js"

/** First non-empty trimmed string from a list of candidates. */
function firstText(values = []) {
  for (const value of values) {
    const safeValue = String(value || "").trim()
    if (safeValue) {
      return safeValue
    }
  }

  return ""
}

/**
 * Render one of our MB volumes as a PBM HUB `size` string.
 *
 * Their /packages endpoint returns sizes like "1GB" and requires the exact
 * string back on /purchase, while our catalog stores whole megabytes. Sub-GB
 * bundles stay in MB and fractional ones keep two decimals ("1.5GB"), because
 * rounding 1500 to "2GB" would silently deliver - and bill - the wrong bundle.
 *
 * A non-positive volume yields "", which the mapping completeness check then
 * reports as a gap rather than shipping an empty size upstream.
 */
export function formatPbmhubSizeFromVolume(volume) {
  const amount = Number(volume || 0)
  if (!Number.isFinite(amount) || amount <= 0) {
    return ""
  }

  if (amount % 1000 === 0) {
    return `${amount / 1000}GB`
  }

  if (amount < 1000) {
    return `${amount}MB`
  }

  return `${Math.round((amount / 1000 + Number.EPSILON) * 100) / 100}GB`
}

/** The machine-readable failure code PBM HUB returned, upper-cased. */
export function extractPbmhubErrorCode(data = {}) {
  return firstText([
    data?.error_code,
    data?.errorCode,
    data?.data?.error_code,
    data?.data?.errorCode,
    data?.code,
  ]).toUpperCase()
}

export function getPbmhubResponseSummary(data = {}, fallbackMessage = "") {
  return [data?.message, data?.error, extractPbmhubErrorCode(data), fallbackMessage]
    .filter(Boolean)
    .join(" | ")
}

/**
 * The order reference PBM HUB wants back on GET /orders/:reference.
 *
 * Their purchase response carries three identifiers and only `reference`
 * resolves on the status endpoint - `purchase_id` and `order_id` do not. Using
 * the wrong one 404s on every poll, which would leave orders open until the
 * reconciler gave up on them.
 */
export function extractPbmhubOrderReference(response = {}) {
  return firstText([
    response?.data?.reference,
    response?.reference,
    response?.data?.order_reference,
    response?.order_reference,
  ])
}

/**
 * Whether PBM HUB replayed an earlier result instead of charging again.
 *
 * Sending the same X-Idempotency-Key returns the original outcome flagged
 * "Duplicate request - no new charge". That is a success for our purposes: the
 * order exists upstream and must be polled, not resubmitted.
 */
export function isPbmhubDuplicateReplay(data = {}) {
  return /duplicate request/i.test(String(data?.message || ""))
}

/**
 * Whether a status lookup 404'd because PBM HUB has no record of the order yet.
 *
 * Status-path only. The same 404 means opposite things on the two endpoints:
 * on /purchase it is an unknown network or size (a mapping bug), but on
 * /orders/:reference it is almost always indexing lag on an order we just
 * placed. Reading it as a failure there would mark a live order failed and
 * refund a bundle that is still on its way.
 */
export function isPbmhubOrderNotFound(error = {}) {
  if (Number(error?.statusCode || 0) === 404) {
    return true
  }

  const summary = getPbmhubResponseSummary(error?.responseData, error?.message).toLowerCase()
  return summary.includes("order not found") || summary.includes("unknown reference")
}

/**
 * Map a PBM HUB failure onto one of our provider error codes.
 *
 * `statusCode` disambiguates the two documented 429s: DUPLICATE_PURCHASE_WINDOW
 * carries a code, a plain rate-limit rejection does not.
 */
export function classifyPbmhubFailure(data = {}, fallbackMessage = "", statusCode = 0) {
  const summary = getPbmhubResponseSummary(data, fallbackMessage)
  const errorCode = extractPbmhubErrorCode(data)
  const normalized = summary.toLowerCase()
  const httpStatus = Number(statusCode || 0)

  if (errorCode === "INSUFFICIENT_BALANCE") {
    return {
      code: "INSUFFICIENT_PBMHUB_BALANCE",
      message: "Service provider has insufficient balance",
    }
  }

  if (errorCode === "WALLET_FROZEN") {
    return {
      code: "PBMHUB_WALLET_FROZEN",
      message: "PBM HUB has frozen the account wallet. Contact PBM HUB support.",
    }
  }

  if (errorCode === "NETWORK_UNAVAILABLE") {
    return {
      code: "PBMHUB_NETWORK_UNAVAILABLE",
      message: "PBM HUB has temporarily disabled this network. Try again later or reroute the network.",
    }
  }

  if (errorCode === "DUPLICATE_PURCHASE_WINDOW") {
    return {
      code: "PBMHUB_DUPLICATE_WINDOW",
      message: "PBM HUB rejected a repeat purchase for this recipient. Please wait before retrying.",
    }
  }

  // Their own retry advice: the debit was auto-reversed upstream, so this is a
  // clean failure we can refund and let the customer retry.
  if (errorCode === "PROVIDER_PURCHASE_FAILED") {
    return {
      code: "PBMHUB_PURCHASE_FAILED",
      message: "PBM HUB's upstream provider failed. Please try again shortly.",
    }
  }

  // A replay of an earlier failure, not a fresh one. Same outcome for us, but
  // worth its own code so "why was this charged twice" is answerable from logs.
  if (errorCode === "CACHED_FAILURE") {
    return {
      code: "PBMHUB_CACHED_FAILURE",
      message: summary || "PBM HUB replayed a previously failed purchase",
    }
  }

  // We never send storefront_payment_reference. Seeing this means our request
  // builder regressed, so name it rather than burying it in a generic error.
  if (errorCode === "STOREFRONT_CHANNEL_REQUIRED") {
    return {
      code: "PBMHUB_API_ERROR",
      message: "PBM HUB rejected a storefront-only field. This is a request-builder bug, not a wallet problem.",
    }
  }

  if (
    httpStatus === 401 ||
    normalized.includes("invalid or inactive api key") ||
    normalized.includes("unauthorized") ||
    normalized.includes("api key") ||
    normalized.includes("invalid token")
  ) {
    return {
      code: "PBMHUB_AUTH_FAILED",
      message: "PBM HUB API authentication failed. Update PBMHUB_API_KEY.",
    }
  }

  if (httpStatus === 429 || normalized.includes("rate limit") || normalized.includes("too many")) {
    return {
      code: "PBMHUB_RATE_LIMITED",
      message: "PBM HUB API rate limit reached. Please try again shortly.",
    }
  }

  if (normalized.includes("insufficient balance")) {
    return {
      code: "INSUFFICIENT_PBMHUB_BALANCE",
      message: "Service provider has insufficient balance",
    }
  }

  // 404 on /packages/:network and /purchase both mean the mapping is wrong -
  // an unknown network id or a size string that is not in their catalog.
  if (
    httpStatus === 404 ||
    normalized.includes("unknown network") ||
    normalized.includes("available_networks") ||
    normalized.includes("package not found") ||
    normalized.includes("invalid size")
  ) {
    return {
      code: "PBMHUB_INVALID_PACKAGE",
      message: "PBM HUB rejected the network or size. Check the package mapping.",
    }
  }

  return {
    code: "PBMHUB_API_ERROR",
    message: summary || "PBM HUB transaction failed",
  }
}

/**
 * Normalise a purchase or order-status payload onto our internal vocabulary.
 *
 * Their lifecycle is PROCESSING → DELIVERED or FAILED, all of which
 * normalizeInternalOrderStatus already understands. The fallback is "processing"
 * rather than "failed" because an unrecognised status on a live order must keep
 * the reconciler polling instead of refunding a bundle that may yet land.
 */
export function getPbmhubStatusDetails(data = {}) {
  const rawStatus = firstText([data?.data?.status, data?.status, data?.order?.status])
  const providerStatusDescription = firstText([data?.message, data?.error])
  const fallback = data?.success === false ? "failed" : "processing"

  return {
    providerStatusRaw: rawStatus || fallback.toUpperCase(),
    providerStatusDescription: providerStatusDescription || rawStatus,
    normalizedStatus: normalizeInternalOrderStatus(rawStatus, fallback),
  }
}
