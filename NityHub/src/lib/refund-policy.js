// Pure retry policy for the refund outbox.
//
// Kept free of Firebase imports so the backoff schedule and the
// retry/dead-letter decision are unit testable. The worker in
// ../refund-queue.js owns all RTDB access.

import { CONFIG } from "../config.js"

/** Lifecycle of a queued refund. */
export const REFUND_STATUS = {
  /** Awaiting its next attempt. */
  PENDING: "pending",
  /** Credited back to the wallet. */
  SUCCEEDED: "succeeded",
  /** Retries exhausted; needs a human. */
  DEAD: "dead",
}

/**
 * Exponential backoff with full jitter, capped.
 *
 * Jitter matters because a provider outage tends to fail many refunds at once;
 * without it every retry would stampede the database on the same schedule.
 *
 * @param attempt  1-based attempt number that just failed.
 * @param random   Injectable RNG so tests are deterministic.
 */
export function getRefundBackoffDelay(
  attempt,
  {
    baseMs = CONFIG.refundRetryBaseMs,
    maxDelayMs = CONFIG.refundRetryMaxDelayMs,
    random = Math.random,
  } = {},
) {
  const exponent = Math.max(0, Number(attempt || 1) - 1)
  const ceiling = Math.min(baseMs * Math.pow(2, exponent), maxDelayMs)
  // Full jitter: pick anywhere in [baseMs, ceiling] so retries fan out but
  // never fire sooner than one base interval.
  const floor = Math.min(baseMs, ceiling)
  return Math.round(floor + random() * (ceiling - floor))
}

/**
 * Decide what happens to a refund after a failed attempt.
 *
 * @returns {{status: string, attempts: number, nextAttemptAt: number|null, lastError: string}}
 */
export function nextRefundState(
  entry,
  error,
  { now = Date.now(), maxAttempts = CONFIG.refundMaxAttempts, ...backoffOptions } = {},
) {
  const attempts = Math.max(0, Number(entry?.attempts || 0)) + 1
  const lastError = String(error?.message || error || "unknown error").slice(0, 500)

  if (attempts >= maxAttempts) {
    return { status: REFUND_STATUS.DEAD, attempts, nextAttemptAt: null, lastError }
  }

  return {
    status: REFUND_STATUS.PENDING,
    attempts,
    nextAttemptAt: now + getRefundBackoffDelay(attempts, backoffOptions),
    lastError,
  }
}

/** Whether a queued refund is eligible to run now. */
export function isRefundDue(entry, now = Date.now()) {
  if (!entry || entry.status !== REFUND_STATUS.PENDING) {
    return false
  }

  return Number(entry.nextAttemptAt || 0) <= now
}

/**
 * Build the initial queue entry for a refund that could not be applied inline.
 * `mutationId` is the caller's idempotency key: the wallet replay guard makes
 * re-running this entry safe no matter how many times it is retried.
 */
export function buildRefundEntry({
  userId,
  reference,
  amount,
  mutationId,
  reason = "wallet_purchase_refund",
  details = {},
  now = Date.now(),
  lastError = "",
}) {
  return {
    userId,
    reference,
    amount,
    mutationId,
    reason,
    details: details && typeof details === "object" && !Array.isArray(details) ? details : {},
    status: REFUND_STATUS.PENDING,
    attempts: 0,
    // Retry promptly; the inline attempt already failed once.
    nextAttemptAt: now,
    lastError: String(lastError || "").slice(0, 500),
    createdAt: now,
    updatedAt: now,
  }
}
