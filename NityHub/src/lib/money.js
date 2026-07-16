// Money math and wallet-mutation key helpers.
//
// Deliberately free of any Firebase or network import so the balance
// arithmetic that guards real user funds can be unit tested in isolation.
// Behaviour here is byte-for-byte the logic previously inlined in domain.js.

import crypto from "crypto"
import { CONFIG } from "../config.js"

/**
 * Coerce a value to a 2dp currency number, falling back when non-finite.
 * The Number.EPSILON nudge keeps values like 1.005 from rounding down.
 */
export function toMoneyNumber(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.round((parsed + Number.EPSILON) * 100) / 100
}

/**
 * Convert a currency value to integer minor units (pesewas).
 * Balance arithmetic runs in these units so repeated float addition
 * can never drift a user's balance.
 */
export function toMoneyUnits(value, fallback = 0) {
  const normalized = toMoneyNumber(value, fallback)
  return Number.isFinite(normalized) ? Math.round(normalized * 100) : Math.round(fallback * 100)
}

/** Convert integer minor units back to a major-unit currency number. */
export function fromMoneyUnits(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.round(parsed) / 100
}

/** Stable, collision-resistant short hash used to derive idempotency keys. */
export function hashStableKey(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 48)
}

/**
 * Normalise a mutation id into a key safe for use as an RTDB path segment.
 * RTDB rejects `.`, `#`, `$`, `[`, `]` and `/` in keys.
 */
export function sanitizeMutationId(value, fallback = "") {
  const safe = String(value || "").trim().replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 120)
  return safe || String(fallback || "").trim()
}

/**
 * Cap the per-wallet applied-mutation history, keeping the most recent
 * entries. This history is the in-transaction replay guard, so it is bounded
 * rather than unbounded to keep the wallet node small.
 */
export function trimWalletMutationHistory(history = {}, limit = CONFIG.walletMutationHistoryLimit) {
  const entries = Object.entries(history || {})
  if (entries.length <= limit) {
    return history
  }

  entries.sort((a, b) => Number(b?.[1]?.timestamp || 0) - Number(a?.[1]?.timestamp || 0))
  return Object.fromEntries(entries.slice(0, limit))
}
