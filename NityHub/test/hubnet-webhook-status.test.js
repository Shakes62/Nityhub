// Regression tests for Hubnet webhook status mapping.
//
// Background: the Hubnet API documentation's own `transfer.delivered` sample
// payload carries `data.status: "Processing"`. The webhook handler read only
// the body, so every delivered order was written back as "processing" and never
// reached a terminal state - orders sat "processing" forever while the customer
// had already received the bundle.
//
// The payloads below are copied verbatim from the Hubnet v1.0 API docs.

import test from "node:test"
import assert from "node:assert/strict"

import {
  getHubnetStatusDetails,
  getHubnetWebhookStatusDetails,
  isHubnetTransactionNotFoundResponse,
} from "../src/lib/hubnet.js"
import { getWebhookEventStatus } from "../src/lib/order-status.js"

/** Verbatim `transfer.delivered` sample from the Hubnet docs. */
const DELIVERED_WEBHOOK = {
  event: "transfer.delivered",
  status: true,
  message: "Transfer successful",
  code: 200,
  data: {
    status: "Processing", // <- the trap: says Processing on a delivered event
    date_time: "April 17, 2025 12:26:40 AM",
    msisdn: "0271277777",
    network: "mtn",
    volume: "1000",
    reference: "webhook_test",
  },
}

/** Verbatim `transfer.processing` sample from the Hubnet docs. */
const PROCESSING_WEBHOOK = {
  event: "transfer.processing",
  status: true,
  message: "Order fulfillment is in progress",
  code: 200,
  data: {
    status: "processing",
    timestamp: "June 7, 2026 4:42:33 PM",
    msisdn: "0591923218",
    network: "mtn",
    volume: "2000",
    reference: "WAL-1780850315550-52999",
  },
}

test("transfer.delivered marks the order delivered despite data.status saying Processing", () => {
  // This is the assertion that would have caught the bug.
  assert.equal(getHubnetWebhookStatusDetails(DELIVERED_WEBHOOK).normalizedStatus, "delivered")
})

test("reading the body alone is what produced the wrong answer", () => {
  // Documents the old behaviour so nobody "simplifies" back to it.
  assert.equal(getHubnetStatusDetails(DELIVERED_WEBHOOK, "processing").normalizedStatus, "processing")
})

test("transfer.processing stays processing", () => {
  assert.equal(getHubnetWebhookStatusDetails(PROCESSING_WEBHOOK).normalizedStatus, "processing")
})

test("the raw provider status records the event name", () => {
  assert.equal(getHubnetWebhookStatusDetails(DELIVERED_WEBHOOK).providerStatusRaw, "transfer.delivered")
})

test("failure and cancellation events map to terminal states", () => {
  assert.equal(getHubnetWebhookStatusDetails({ event: "transfer.failed" }).normalizedStatus, "failed")
  assert.equal(getHubnetWebhookStatusDetails({ event: "transfer.reversed" }).normalizedStatus, "failed")
  assert.equal(getHubnetWebhookStatusDetails({ event: "transfer.cancelled" }).normalizedStatus, "cancelled")
})

test("an unrecognised event falls back to the payload body", () => {
  const payload = { event: "transfer.something_new", status: true, data: { status: "delivered" } }
  assert.equal(getHubnetWebhookStatusDetails(payload).normalizedStatus, "delivered")
})

test("a payload with no event at all still works off the body", () => {
  const payload = { status: true, data: { status: "failed" } }
  assert.equal(getHubnetWebhookStatusDetails(payload).normalizedStatus, "failed")
})

test("event names are matched regardless of prefix or separator", () => {
  assert.equal(getWebhookEventStatus("transfer.delivered"), "delivered")
  assert.equal(getWebhookEventStatus("order_completed"), "delivered")
  assert.equal(getWebhookEventStatus("TRANSACTION-FAILED"), "failed")
  assert.equal(getWebhookEventStatus("charge.success"), "delivered")
  assert.equal(getWebhookEventStatus(""), "")
  assert.equal(getWebhookEventStatus(undefined), "")
})

/* --------------------- status lookup ("check-transaction-status") --------- */

test("the documented delivered status response maps to delivered", () => {
  const response = {
    status: true,
    message: "0000",
    data: { status: "delivered", message: "Bundle delivered successfully." },
  }
  assert.equal(getHubnetStatusDetails(response, "processing").normalizedStatus, "delivered")
})

test("the documented pending status response stays pending, not delivered", () => {
  // `message: "0000"` makes isHubnetSuccessfulResponse true; the explicit
  // data.status must still win or every pending poll would mark orders
  // delivered.
  const response = {
    status: true,
    message: "0000",
    data: { status: "pending", message: "Transaction is being processed." },
  }
  assert.equal(getHubnetStatusDetails(response, "processing").normalizedStatus, "pending")
})

test("an unknown reference is detected rather than treated as a failure", () => {
  // Marking these failed would refund live orders Hubnet has not registered yet.
  assert.equal(isHubnetTransactionNotFoundResponse({ message: "No transaction found" }), true)
  assert.equal(isHubnetTransactionNotFoundResponse({ data: { message: "Transaction not found" } }), true)
  assert.equal(isHubnetTransactionNotFoundResponse({ message: "0000" }), false)
})
