// Pure helpers for the CK-Godsway provider (used for the Telecel network).
//
// Free of Firebase imports so the provider-order-number handling - which
// determines whether an order can ever be status-polled - is unit testable.

import crypto from "crypto"

/** First non-empty trimmed string from a list of candidates. */
export function firstNonEmptyText(values = []) {
  for (const value of values) {
    const safeValue = String(value || "").trim()
    if (safeValue) {
      return safeValue
    }
  }

  return ""
}

/**
 * Pull Godsway's own order identifier out of a purchase/status response.
 *
 * Godsway returns it as `data.reference` (e.g. "bs_1784416596722"), NOT as
 * `data.orderNumber`. Reading only `orderNumber` yielded undefined on every
 * order, which left providerOrderNumber unset and made status polling skip the
 * order forever - orders sat at "pending" despite Godsway reporting SUCCESSFUL.
 *
 * `orderNumber` is still checked first so any account or API version that does
 * send it keeps working; the observed `reference` field is the fallback.
 */
export function extractGodswayOrderNumber(response = {}) {
  return firstNonEmptyText([
    response?.data?.orderNumber,
    response?.data?.reference,
    response?.orderNumber,
    response?.reference,
  ])
}

/**
 * Reject a "provider order number" that is really just our own reference.
 *
 * Polling Godsway with the app reference always fails, so a value that echoes
 * it is worse than useless - it makes the order look pollable when it is not.
 */
/**
 * Constant-time check of CK-Godsway's `X-Webhook-Signature` header.
 *
 * The header is the hex HMAC-SHA256 of the exact bytes CK sent, so this takes
 * the raw body buffer: re-serialising the parsed JSON changes key order and
 * whitespace and would never match.
 *
 * Anything that is not a 64-char hex string is rejected before the compare,
 * both because timingSafeEqual throws on a length mismatch and because a
 * malformed header is never a genuine CK delivery.
 */
export function verifyGodswayWebhookSignature(rawBody, signature, secret) {
  const safeSecret = String(secret || "")
  const safeSignature = String(signature || "").trim()

  if (!safeSecret || !Buffer.isBuffer(rawBody) || !/^[a-f0-9]{64}$/i.test(safeSignature)) {
    return false
  }

  const expected = crypto.createHmac("sha256", safeSecret).update(rawBody).digest("hex")

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(safeSignature, "hex"))
  } catch {
    return false
  }
}

export function sanitizeGodswayProviderOrderNumber(value, appReference = "") {
  const safeValue = String(value || "").trim()
  const safeAppReference = String(appReference || "").trim()
  if (!safeValue) {
    return ""
  }

  if (safeAppReference) {
    const lowerValue = safeValue.toLowerCase()
    const lowerAppReference = safeAppReference.toLowerCase()
    if (
      lowerValue === lowerAppReference ||
      lowerValue === `godsway-${lowerAppReference}` ||
      lowerValue.includes(lowerAppReference)
    ) {
      return ""
    }
  }

  return safeValue
}
