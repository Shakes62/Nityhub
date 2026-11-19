// Durable "paid but maybe not dispatched" queue.
//
// A Paystack charge.success webhook for a data bundle enqueues its reference
// here. Normally the buyer's browser returns and fulfils the order first; this
// queue is the safety net for the buyer who paid and closed the tab. Each
// entry is retried through the same self-healing repair pipeline a customer's
// Repair button uses, which holds a cross-instance lease and is idempotent:
// an order that is already delivered or in flight is never dispatched twice.

import crypto from "crypto"
import { db } from "./firebase.js"
import { logger } from "./logger.js"
import { isValidRepairReference } from "./lib/repair-rules.js"

const PATH = "pending_fulfillment"
const FIRST_ATTEMPT_DELAY_MS = 45_000
const MAX_ATTEMPTS = 8
const LEASE_MS = 90_000

let runner = null

/** routes.js registers the repair pipeline here once it is defined. */
export function setFulfillmentRunner(fn) {
  runner = fn
}

export async function enqueueFulfillment(reference, { requesterUid = "", delayMs = FIRST_ATTEMPT_DELAY_MS } = {}) {
  if (!isValidRepairReference(reference)) return false
  const result = await db.ref(`${PATH}/${reference}`).transaction((current) => {
    if (current) return
    return { reference, requesterUid: String(requesterUid || ""), attempts: 0, nextAttemptAt: Date.now() + delayMs, createdAt: Date.now() }
  })
  return result.committed === true
}

/**
 * Whether the pipeline's answer means "keep trying later". Everything else -
 * delivered, handed to the status reconciler, or definitively not ours to
 * deliver - is final for this queue.
 */
export function shouldRetryFulfillment({ code, body } = {}) {
  if (code === 503) return true
  if (code === 409 && body?.status === "pending") return true
  return false
}

export function nextFulfillmentDelay(attempts) {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.min(attempts, 6))
}

export async function runFulfillmentQueue(now = Date.now()) {
  if (!runner) return 0
  const snapshot = await db.ref(PATH).orderByChild("nextAttemptAt").endAt(now).limitToFirst(10).once("value")
  if (!snapshot.exists()) return 0
  let finished = 0
  for (const [reference, entry] of Object.entries(snapshot.val() || {})) {
    const token = crypto.randomUUID()
    const ref = db.ref(`${PATH}/${reference}`)
    const claim = await ref.transaction((current) => {
      const value = current === null ? entry : current
      if (!value || Number(value.nextAttemptAt || 0) > now || Number(value.leaseExpiresAt || 0) > now) return
      return { ...value, leaseToken: token, leaseExpiresAt: now + LEASE_MS }
    })
    if (!claim.committed) continue
    const item = claim.snapshot.val() || entry
    let outcome
    try {
      outcome = await runner({ reference, requesterUid: item.requesterUid || "" })
    } catch (error) {
      logger.error("Queued fulfillment attempt crashed", error, { reference })
      outcome = { code: 503, body: { status: "pending" } }
    }
    const attempts = Number(item.attempts || 0) + 1
    if (!shouldRetryFulfillment(outcome) || attempts >= MAX_ATTEMPTS) {
      if (attempts >= MAX_ATTEMPTS && shouldRetryFulfillment(outcome)) {
        logger.error("Queued fulfillment gave up; order needs review", new Error("fulfillment_exhausted"), { reference, attempts })
        await db.ref(`fulfillment_review/${reference}`).set({ reference, attempts, lastMessage: outcome?.body?.message || "", at: Date.now() }).catch(() => null)
      }
      await ref.transaction((current) => ((current === null ? item : current)?.leaseToken === token ? null : undefined))
      finished++
      continue
    }
    await ref.transaction((current) => {
      const value = current === null ? item : current
      if (value?.leaseToken !== token) return
      return { ...value, attempts, nextAttemptAt: Date.now() + nextFulfillmentDelay(attempts), leaseToken: null, leaseExpiresAt: null, lastMessage: String(outcome?.body?.message || "").slice(0, 200) }
    })
  }
  return finished
}
