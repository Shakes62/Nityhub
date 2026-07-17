// Unit tests for the refund outbox retry policy.
// Imports lib/refund-policy.js directly - no Firebase connection.

import test from "node:test"
import assert from "node:assert/strict"

import {
  REFUND_STATUS,
  buildRefundEntry,
  getRefundBackoffDelay,
  isRefundDue,
  nextRefundState,
} from "../src/lib/refund-policy.js"

const NOW = 1_700_000_000_000
const BACKOFF = { baseMs: 1000, maxDelayMs: 60_000 }

/** Deterministic RNG returning the midpoint of the jitter range. */
const midJitter = () => 0.5

test("backoff grows exponentially", () => {
  // With zero jitter the delay is the base interval floor.
  const noJitter = { ...BACKOFF, random: () => 0 }
  assert.equal(getRefundBackoffDelay(1, noJitter), 1000)
  assert.equal(getRefundBackoffDelay(2, noJitter), 1000)

  // With full jitter the ceiling doubles each attempt.
  const fullJitter = { ...BACKOFF, random: () => 1 }
  assert.equal(getRefundBackoffDelay(1, fullJitter), 1000)
  assert.equal(getRefundBackoffDelay(2, fullJitter), 2000)
  assert.equal(getRefundBackoffDelay(3, fullJitter), 4000)
  assert.equal(getRefundBackoffDelay(4, fullJitter), 8000)
})

test("backoff is capped", () => {
  const fullJitter = { ...BACKOFF, random: () => 1 }
  // 2^20 * 1000 would be ~17 minutes; the cap is 60s here.
  assert.equal(getRefundBackoffDelay(20, fullJitter), 60_000)
  assert.equal(getRefundBackoffDelay(100, fullJitter), 60_000)
})

test("backoff never returns below the base interval", () => {
  for (let attempt = 1; attempt <= 12; attempt++) {
    for (const random of [() => 0, () => 0.5, () => 1]) {
      const delay = getRefundBackoffDelay(attempt, { ...BACKOFF, random })
      assert.ok(delay >= 1000, `attempt ${attempt} returned ${delay}, below base`)
      assert.ok(delay <= 60_000, `attempt ${attempt} returned ${delay}, above cap`)
    }
  }
})

test("backoff jitter spreads retries across the range", () => {
  // Without jitter a provider outage would stampede every refund at once.
  const low = getRefundBackoffDelay(5, { ...BACKOFF, random: () => 0 })
  const mid = getRefundBackoffDelay(5, { ...BACKOFF, random: midJitter })
  const high = getRefundBackoffDelay(5, { ...BACKOFF, random: () => 1 })
  assert.ok(low < mid && mid < high, `expected spread, got ${low}/${mid}/${high}`)
})

test("backoff tolerates a missing attempt number", () => {
  assert.ok(getRefundBackoffDelay(undefined, BACKOFF) >= 1000)
  assert.ok(getRefundBackoffDelay(0, BACKOFF) >= 1000)
})

test("a failed attempt reschedules while attempts remain", () => {
  const entry = { attempts: 0 }
  const state = nextRefundState(entry, new Error("boom"), {
    now: NOW,
    maxAttempts: 3,
    ...BACKOFF,
    random: midJitter,
  })

  assert.equal(state.status, REFUND_STATUS.PENDING)
  assert.equal(state.attempts, 1)
  assert.ok(state.nextAttemptAt > NOW)
  assert.equal(state.lastError, "boom")
})

test("attempts accumulate across failures", () => {
  const state = nextRefundState({ attempts: 1 }, new Error("again"), {
    now: NOW,
    maxAttempts: 5,
    ...BACKOFF,
  })
  assert.equal(state.attempts, 2)
  assert.equal(state.status, REFUND_STATUS.PENDING)
})

test("the final attempt dead-letters instead of retrying forever", () => {
  const state = nextRefundState({ attempts: 2 }, new Error("still failing"), {
    now: NOW,
    maxAttempts: 3,
    ...BACKOFF,
  })

  assert.equal(state.status, REFUND_STATUS.DEAD)
  assert.equal(state.attempts, 3)
  assert.equal(state.nextAttemptAt, null, "a dead entry must not be rescheduled")
})

test("dead-lettering is sticky past the limit", () => {
  const state = nextRefundState({ attempts: 99 }, new Error("x"), { now: NOW, maxAttempts: 3, ...BACKOFF })
  assert.equal(state.status, REFUND_STATUS.DEAD)
})

test("a non-Error failure still yields a readable message", () => {
  assert.equal(nextRefundState({ attempts: 0 }, "plain string", { maxAttempts: 5, ...BACKOFF }).lastError, "plain string")
  assert.equal(nextRefundState({ attempts: 0 }, null, { maxAttempts: 5, ...BACKOFF }).lastError, "unknown error")
})

test("lastError is truncated so a huge provider body cannot bloat the node", () => {
  const state = nextRefundState({ attempts: 0 }, new Error("x".repeat(5000)), { maxAttempts: 5, ...BACKOFF })
  assert.equal(state.lastError.length, 500)
})

test("isRefundDue only fires for pending entries whose time has come", () => {
  assert.equal(isRefundDue({ status: REFUND_STATUS.PENDING, nextAttemptAt: NOW - 1 }, NOW), true)
  assert.equal(isRefundDue({ status: REFUND_STATUS.PENDING, nextAttemptAt: NOW }, NOW), true)
  assert.equal(isRefundDue({ status: REFUND_STATUS.PENDING, nextAttemptAt: NOW + 1 }, NOW), false)
})

test("settled refunds are never due", () => {
  // The guarantee that matters: a succeeded refund can never be picked up again.
  assert.equal(isRefundDue({ status: REFUND_STATUS.SUCCEEDED, nextAttemptAt: 0 }, NOW), false)
  assert.equal(isRefundDue({ status: REFUND_STATUS.DEAD, nextAttemptAt: 0 }, NOW), false)
  assert.equal(isRefundDue(null, NOW), false)
  assert.equal(isRefundDue(undefined, NOW), false)
})

test("buildRefundEntry starts pending and immediately due", () => {
  const entry = buildRefundEntry({
    userId: "u1",
    reference: "TRX_1",
    amount: 12.34,
    mutationId: "purchase-refund:TRX_1",
    now: NOW,
    lastError: "inline refund failed",
  })

  assert.equal(entry.status, REFUND_STATUS.PENDING)
  assert.equal(entry.attempts, 0)
  assert.equal(entry.nextAttemptAt, NOW)
  assert.equal(isRefundDue(entry, NOW), true, "the inline attempt already failed, so retry promptly")
  assert.equal(entry.amount, 12.34)
  assert.equal(entry.mutationId, "purchase-refund:TRX_1")
  assert.equal(entry.reason, "wallet_purchase_refund")
})

test("buildRefundEntry normalises non-object details", () => {
  assert.deepEqual(buildRefundEntry({ userId: "u", amount: 1, mutationId: "m", details: ["bad"], now: NOW }).details, {})
  assert.deepEqual(buildRefundEntry({ userId: "u", amount: 1, mutationId: "m", details: null, now: NOW }).details, {})
})

test("a queued refund survives a full failure run to dead-letter", () => {
  // Walk the whole lifecycle the worker would drive.
  let entry = buildRefundEntry({ userId: "u1", reference: "TRX_1", amount: 5, mutationId: "m", now: NOW })
  const maxAttempts = 4
  let now = NOW

  for (let i = 0; i < maxAttempts - 1; i++) {
    const state = nextRefundState(entry, new Error("fail"), { now, maxAttempts, ...BACKOFF })
    assert.equal(state.status, REFUND_STATUS.PENDING, `attempt ${i + 1} should still retry`)
    entry = { ...entry, ...state }
    now = state.nextAttemptAt
    assert.equal(isRefundDue(entry, now), true)
  }

  const final = nextRefundState(entry, new Error("fail"), { now, maxAttempts, ...BACKOFF })
  assert.equal(final.status, REFUND_STATUS.DEAD)
  assert.equal(final.attempts, maxAttempts)
})
