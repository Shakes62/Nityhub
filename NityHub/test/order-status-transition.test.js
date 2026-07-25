// Tests for the order-status transition guard.
//
// Every writer (provider webhooks, the status reconciler, retries, admin
// actions) funnels status changes through canApplyOrderStatus. It is what makes
// webhook delivery idempotent and stops a late/out-of-order callback from
// un-delivering a finished order.

import test from "node:test"
import assert from "node:assert/strict"

import {
  canApplyOrderStatus,
  getOrderStatusPriority,
  getPurchaseIntentSubmissionStatusForOrderStatus,
  isTerminalOrderStatus,
  normalizeInternalOrderStatus,
} from "../src/lib/order-status.js"

/* ------------------------------ idempotency ------------------------------ */

test("re-applying the same status is a no-op", () => {
  // A replayed webhook must not rewrite the record.
  for (const status of ["pending", "accepted", "processing", "delivered", "failed", "cancelled"]) {
    assert.equal(canApplyOrderStatus(status, status), false, status)
  }
})

test("differently-spelled versions of the same status are still a no-op", () => {
  assert.equal(canApplyOrderStatus("delivered", "SUCCESSFUL"), false)
  assert.equal(canApplyOrderStatus("processing", "In Progress"), false)
})

test("an empty or unrecognised incoming status is never applied", () => {
  assert.equal(canApplyOrderStatus("processing", ""), false)
  assert.equal(canApplyOrderStatus("processing", null), false)
  assert.equal(canApplyOrderStatus("processing", "   "), false)
})

/* ------------------------------ progression ------------------------------ */

test("orders move forward through the pipeline", () => {
  assert.equal(canApplyOrderStatus("accepted", "processing"), true)
  assert.equal(canApplyOrderStatus("pending", "processing"), true)
  assert.equal(canApplyOrderStatus("processing", "delivered"), true)
  assert.equal(canApplyOrderStatus("processing", "failed"), true)
  assert.equal(canApplyOrderStatus("accepted", "delivered"), true)
})

test("a brand new order accepts any first status", () => {
  assert.equal(canApplyOrderStatus("", "processing"), true)
  assert.equal(canApplyOrderStatus(undefined, "delivered"), true)
})

/* ------------------------------- regression ------------------------------ */

test("a late transfer.processing cannot un-deliver a delivered order", () => {
  // The exact race this guard exists for: Hubnet retries a processing callback
  // after the delivered one, or a status poll answers late.
  assert.equal(canApplyOrderStatus("delivered", "processing"), false)
  assert.equal(canApplyOrderStatus("delivered", "pending"), false)
  assert.equal(canApplyOrderStatus("delivered", "accepted"), false)
})

test("terminal states never flip into one another automatically", () => {
  assert.equal(canApplyOrderStatus("delivered", "failed"), false)
  assert.equal(canApplyOrderStatus("failed", "delivered"), false)
  assert.equal(canApplyOrderStatus("cancelled", "delivered"), false)
})

test("a provider update cannot walk a live order backwards", () => {
  assert.equal(canApplyOrderStatus("processing", "accepted"), false)
  assert.equal(canApplyOrderStatus("processing", "pending"), false)
  assert.equal(canApplyOrderStatus("pending", "accepted"), false)
})

/* ---------------------------- admin override ----------------------------- */

test("an admin may correct any status, including a terminal one", () => {
  assert.equal(canApplyOrderStatus("delivered", "failed", { manual: true }), true)
  assert.equal(canApplyOrderStatus("failed", "delivered", { manual: true }), true)
  assert.equal(canApplyOrderStatus("delivered", "processing", { manual: true }), true)
  assert.equal(canApplyOrderStatus("cancelled", "pending", { manual: true }), true)
})

test("even an admin write is skipped when nothing would change", () => {
  // Keeps the manual endpoint idempotent too.
  assert.equal(canApplyOrderStatus("delivered", "delivered", { manual: true }), false)
})

/* ------------------------------ vocabulary ------------------------------- */

test("provider vocabularies collapse onto the internal statuses", () => {
  assert.equal(normalizeInternalOrderStatus("SUCCESSFUL"), "delivered")
  assert.equal(normalizeInternalOrderStatus("INITIATED"), "accepted")
  assert.equal(normalizeInternalOrderStatus("PROCESSING"), "processing")
  assert.equal(normalizeInternalOrderStatus("CANCELLED"), "cancelled")
  assert.equal(normalizeInternalOrderStatus("order unsuccessful"), "failed")
  assert.equal(normalizeInternalOrderStatus("", "pending"), "pending")
})

test("terminal statuses are exactly delivered/failed/cancelled", () => {
  assert.equal(isTerminalOrderStatus("delivered"), true)
  assert.equal(isTerminalOrderStatus("failed"), true)
  assert.equal(isTerminalOrderStatus("cancelled"), true)
  assert.equal(isTerminalOrderStatus("processing"), false)
  assert.equal(isTerminalOrderStatus("accepted"), false)
})

test("priority orders the pipeline", () => {
  assert.ok(getOrderStatusPriority("accepted") < getOrderStatusPriority("processing"))
  assert.ok(getOrderStatusPriority("processing") < getOrderStatusPriority("delivered"))
  assert.equal(getOrderStatusPriority("delivered"), getOrderStatusPriority("failed"))
})

test("purchase intents track the order status", () => {
  assert.equal(getPurchaseIntentSubmissionStatusForOrderStatus("delivered"), "completed")
  assert.equal(getPurchaseIntentSubmissionStatusForOrderStatus("failed"), "failed")
  assert.equal(getPurchaseIntentSubmissionStatusForOrderStatus("cancelled"), "failed")
  assert.equal(getPurchaseIntentSubmissionStatusForOrderStatus("processing"), "submitted")
})
