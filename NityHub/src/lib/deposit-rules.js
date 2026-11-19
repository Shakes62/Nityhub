import crypto from "crypto"

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000

/**
 * In-memory anti-replay cache for webhook delivery deduplication.
 * Prevents executing redundant database queries on replayed webhooks within 15 minutes.
 */
export class WebhookReplayCache {
  constructor(ttlMs = FIFTEEN_MINUTES_MS) {
    this._cache = new Map()
    this._ttlMs = ttlMs
    this._cleanupInterval = setInterval(() => this.cleanup(), 60_000)
    if (this._cleanupInterval.unref) this._cleanupInterval.unref()
  }

  isDuplicate(key) {
    if (!key) return false
    const entry = this._cache.get(key)
    if (!entry) return false
    if (Date.now() - entry > this._ttlMs) {
      this._cache.delete(key)
      return false
    }
    return true
  }

  record(key) {
    if (!key) return
    this._cache.set(key, Date.now())
  }

  cleanup() {
    const now = Date.now()
    for (const [key, timestamp] of this._cache.entries()) {
      if (now - timestamp > this._ttlMs) {
        this._cache.delete(key)
      }
    }
  }

  clear() {
    this._cache.clear()
  }

  destroy() {
    clearInterval(this._cleanupInterval)
    this._cache.clear()
  }
}

export const paystackWebhookReplayCache = new WebhookReplayCache()

/**
 * Verify Paystack webhook raw payload against the X-Paystack-Signature header using HMAC-SHA512.
 * Never verifies against parsed JSON to prevent key reordering and whitespace tampering.
 */
export function verifyPaystackWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false
  if (!Buffer.isBuffer(rawBody)) return false

  const cleanSignature = String(signature || "").trim().toLowerCase()
  // SHA-512 hex output is exactly 128 characters
  if (!/^[0-9a-f]{128}$/.test(cleanSignature)) return false

  try {
    const cleanSecret = String(secret || "").trim()
    if (!cleanSecret) return false
    const hash = crypto.createHmac("sha512", cleanSecret).update(rawBody).digest("hex")
    return crypto.timingSafeEqual(Buffer.from(hash, "utf8"), Buffer.from(cleanSignature, "utf8"))
  } catch {
    return false
  }
}

/**
 * Verify that payment metadata matches the intended wallet owner and GHS currency.
 */
export function isEligibleWalletDeposit(paymentData, reference, userId = "") {
  const amount = paymentData?.amount
  const targetUser = String(userId || "").trim()
  const metadataUser = String(paymentData?.metadata?.userId || "").trim()
  const userMatches = targetUser ? metadataUser === targetUser : Boolean(metadataUser)

  return (
    userMatches &&
    String(paymentData?.reference || "").trim() === String(reference || "").trim() &&
    Boolean(String(reference || "").trim()) &&
    String(paymentData?.currency || "").toUpperCase() === "GHS" &&
    String(paymentData?.status || "").toLowerCase() === "success" &&
    Number.isSafeInteger(amount) &&
    amount > 0
  )
}

