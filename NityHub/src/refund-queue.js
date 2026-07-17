// Durable refund outbox.
//
// Why this exists: a wallet purchase debits first, then calls the provider. If
// the provider fails we refund inline - but if that inline refund ALSO fails
// (database contention, a transient disconnect, a crash) the user stays
// debited and the only trace is a log line. This module makes that case
// recoverable: the refund is written to RTDB and retried with exponential
// backoff until it succeeds or lands in a dead-letter queue for a human.
//
// Safety: every retry reuses the caller's `mutationId` (purchase-refund:REF),
// and the wallet replay guard in lib/wallet-core.js rejects an already-applied
// mutation inside the RTDB transaction. Retrying can therefore never refund
// twice, no matter how many workers or attempts race. See
// test/wallet-core.test.js for the tests pinning that guarantee.
//
// DEPLOYMENT NOTE: the sweep queries `orderByChild("status")`. Add this to the
// Realtime Database rules or every sweep downloads the whole queue node:
//
//   "refund_queue": { ".indexOn": ["status"] }

import {
  CONFIG,
  INSTANCE_ID,
  REFUND_QUEUE_PATH,
  REFUND_DLQ_PATH,
  REFUND_LEASE_PATH,
} from "./config.js"
import { db } from "./firebase.js"
import { logger } from "./logger.js"
import { sanitizeMutationId } from "./lib/money.js"
import {
  REFUND_STATUS,
  buildRefundEntry,
  isRefundDue,
  nextRefundState,
} from "./lib/refund-policy.js"
import { updateWalletBalance, recordAuditEvent, isTransientRealtimeDisconnectError } from "./domain.js"

let refundRunInFlight = false

/** Queue key derived from the refund's idempotency key, so enqueue is itself idempotent. */
function refundQueueKey(mutationId) {
  return sanitizeMutationId(mutationId)
}

/**
 * Durably record a refund that must eventually be applied.
 *
 * Safe to call repeatedly for the same mutationId: an entry that is already
 * queued or already succeeded is left alone rather than reset.
 */
export async function enqueueRefund({ userId, reference, amount, mutationId, reason, details, lastError }) {
  const key = refundQueueKey(mutationId)
  if (!key || !userId || !(Number(amount) > 0)) {
    logger.warn("Refund enqueue skipped: incomplete payload", { userId, reference, mutationId, amount })
    return null
  }

  const entryRef = db.ref(`${REFUND_QUEUE_PATH}/${key}`)
  let stored = null

  await entryRef.transaction((current) => {
    if (current && typeof current === "object") {
      // Already tracked. Never resurrect a settled refund or reset attempts.
      stored = current
      return current
    }

    stored = buildRefundEntry({ userId, reference, amount, mutationId, reason, details, lastError })
    return stored
  })

  logger.warn("Refund queued for retry", { userId, reference, mutationId: key, amount })
  return stored
}

/** Multi-instance guard: only one worker sweeps the queue at a time. */
async function acquireRefundLease() {
  const leaseRef = db.ref(REFUND_LEASE_PATH)
  let acquired = false

  await leaseRef.transaction((current) => {
    const existing = current && typeof current === "object" ? current : {}
    const now = Date.now()
    const expiresAt = Number(existing.expiresAt || 0)

    if (expiresAt > now && existing.instanceId && existing.instanceId !== INSTANCE_ID) {
      return
    }

    acquired = true
    return { instanceId: INSTANCE_ID, acquiredAt: now, expiresAt: now + CONFIG.refundLeaseMs }
  })

  return acquired
}

async function releaseRefundLease() {
  try {
    const leaseRef = db.ref(REFUND_LEASE_PATH)
    const snapshot = await leaseRef.once("value").catch(() => null)
    if (snapshot?.val()?.instanceId === INSTANCE_ID) {
      await leaseRef.remove()
    }
  } catch (error) {
    logger.warn("Refund lease release failed", { error: error?.message || error })
  }
}

/** Move an exhausted refund to the dead-letter queue and flag it for a human. */
async function deadLetterRefund(key, entry, state) {
  const payload = { ...entry, ...state, deadLetteredAt: Date.now(), instanceId: INSTANCE_ID }

  await db.ref(`${REFUND_DLQ_PATH}/${key}`).set(payload)
  await db.ref(`${REFUND_QUEUE_PATH}/${key}`).update({
    status: REFUND_STATUS.DEAD,
    attempts: state.attempts,
    lastError: state.lastError,
    updatedAt: Date.now(),
  })

  logger.error("Refund dead-lettered; manual intervention required", new Error(state.lastError), {
    userId: entry.userId,
    reference: entry.reference,
    amount: entry.amount,
    attempts: state.attempts,
  })

  await recordAuditEvent({
    action: "refund.dead_letter",
    targetUid: entry.userId,
    targetRef: entry.reference,
    status: "failure",
    metadata: { amount: entry.amount, attempts: state.attempts, lastError: state.lastError },
  }).catch(() => null)
}

/** Apply one queued refund. Idempotent via the wallet replay guard. */
async function processRefund(key, entry) {
  try {
    const balance = await updateWalletBalance(entry.userId, Number(entry.amount), {
      mutationId: entry.mutationId,
      reason: entry.reason || "wallet_purchase_refund",
      reference: entry.reference || null,
      details: entry.details || {},
    })

    await db.ref(`${REFUND_QUEUE_PATH}/${key}`).update({
      status: REFUND_STATUS.SUCCEEDED,
      settledAt: Date.now(),
      updatedAt: Date.now(),
      resultingBalance: balance,
    })

    logger.info("Queued refund applied", {
      userId: entry.userId,
      reference: entry.reference,
      amount: entry.amount,
      balance,
    })

    await recordAuditEvent({
      action: "refund.applied",
      targetUid: entry.userId,
      targetRef: entry.reference,
      status: "success",
      metadata: { amount: entry.amount, attempts: Number(entry.attempts || 0) + 1, balance },
    }).catch(() => null)

    return true
  } catch (error) {
    const state = nextRefundState(entry, error)

    if (state.status === REFUND_STATUS.DEAD) {
      await deadLetterRefund(key, entry, state)
      return false
    }

    await db.ref(`${REFUND_QUEUE_PATH}/${key}`).update({
      status: state.status,
      attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt,
      lastError: state.lastError,
      updatedAt: Date.now(),
    })

    logger.warn("Refund retry scheduled", {
      userId: entry.userId,
      reference: entry.reference,
      attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt,
      error: state.lastError,
    })

    return false
  }
}

/**
 * Sweep the refund queue once, applying every entry that is due.
 * Scheduled from server.js; safe to run concurrently across instances.
 */
export async function runRefundQueue() {
  if (refundRunInFlight) {
    return { skipped: "in_flight" }
  }

  refundRunInFlight = true
  let leaseHeld = false

  try {
    leaseHeld = await acquireRefundLease()
    if (!leaseHeld) {
      return { skipped: "lease_held_elsewhere" }
    }

    // Only pending entries are indexed for retry; succeeded/dead are skipped.
    const snapshot = await db
      .ref(REFUND_QUEUE_PATH)
      .orderByChild("status")
      .equalTo(REFUND_STATUS.PENDING)
      .limitToFirst(CONFIG.refundMaxPerRun)
      .once("value")

    const queued = snapshot.val() || {}
    const now = Date.now()
    let applied = 0
    let deferred = 0

    for (const [key, entry] of Object.entries(queued)) {
      if (!isRefundDue(entry, now)) {
        deferred++
        continue
      }

      const ok = await processRefund(key, entry)
      if (ok) {
        applied++
      }
    }

    if (applied > 0) {
      logger.info("Refund queue sweep complete", { applied, deferred })
    }

    return { applied, deferred }
  } catch (error) {
    if (isTransientRealtimeDisconnectError(error)) {
      logger.warn("Refund queue sweep skipped after transient database error", {
        error: error?.message || error,
      })
      return { skipped: "transient_error" }
    }

    logger.error("Refund queue sweep failed", error)
    return { skipped: "error" }
  } finally {
    if (leaseHeld) {
      await releaseRefundLease()
    }
    refundRunInFlight = false
  }
}
