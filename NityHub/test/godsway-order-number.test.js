// Regression tests for Godsway (Telecel) provider order-number extraction.
//
// Background: Godsway returns its order id as `data.reference`, not
// `data.orderNumber`. The code read only `orderNumber`, so providerOrderNumber
// was undefined on every Telecel order. Status polling then skipped those
// orders permanently ("provider order number not available"), leaving them at
// "pending" forever even though Godsway had reported SUCCESSFUL. One live order
// accumulated 1,632 futile sync attempts before this was found.
//
// The payloads below are real responses captured from production orders.

import test from "node:test"
import assert from "node:assert/strict"

import { extractGodswayOrderNumber, sanitizeGodswayProviderOrderNumber } from "../src/lib/godsway.js"

/** Real Godsway purchase response from order TELECEL_PBM_1784416592227_4cbd. */
const REAL_PURCHASE_RESPONSE = {
  balance: { current: 36.09999999999999, deducted: 38, previous: 74.1 },
  data: {
    capacity: "10GB",
    network: "TELECEL",
    orderDate: "2026-07-18T23:16:33.490Z",
    price: 38,
    recipient: "0201596568",
    reference: "bs_1784416596722",
    status: "SUCCESSFUL",
  },
  message: "Order placed successfully",
  success: true,
}

test("extracts Godsway's order id from the real production payload", () => {
  // This is the assertion that would have caught the bug.
  assert.equal(extractGodswayOrderNumber(REAL_PURCHASE_RESPONSE), "bs_1784416596722")
})

test("the extracted id survives sanitisation against the app reference", () => {
  // Sanitisation drops ids that echo our own reference. Godsway's bs_* ids do
  // not, so they must pass through - otherwise polling is skipped again.
  const appReference = "TELECEL_PBM_1784416592227_4cbd"
  const extracted = extractGodswayOrderNumber(REAL_PURCHASE_RESPONSE)
  assert.equal(sanitizeGodswayProviderOrderNumber(extracted, appReference), "bs_1784416596722")
})

test("prefers orderNumber when a Godsway account actually sends it", () => {
  const response = { data: { orderNumber: "ON-123", reference: "bs_999" } }
  assert.equal(extractGodswayOrderNumber(response), "ON-123")
})

test("falls back to data.reference when orderNumber is absent", () => {
  assert.equal(extractGodswayOrderNumber({ data: { reference: "bs_1" } }), "bs_1")
})

test("falls back to top-level fields", () => {
  assert.equal(extractGodswayOrderNumber({ orderNumber: "top-on" }), "top-on")
  assert.equal(extractGodswayOrderNumber({ reference: "top-ref" }), "top-ref")
})

test("returns empty when nothing usable is present", () => {
  assert.equal(extractGodswayOrderNumber({}), "")
  assert.equal(extractGodswayOrderNumber(), "")
  assert.equal(extractGodswayOrderNumber({ data: {} }), "")
  assert.equal(extractGodswayOrderNumber({ data: { reference: "   " } }), "")
})

test("handles the manual-order id format seen in production", () => {
  const response = { data: { reference: "manual_ORD-2148223391_1780558887890", status: "PROCESSING" } }
  assert.equal(extractGodswayOrderNumber(response), "manual_ORD-2148223391_1780558887890")
})

test("still rejects an id that merely echoes the app reference", () => {
  // The guard exists because polling with our own reference always fails.
  const appReference = "TELECEL_PBM_123_abc"
  assert.equal(sanitizeGodswayProviderOrderNumber(appReference, appReference), "")
  assert.equal(sanitizeGodswayProviderOrderNumber(`godsway-${appReference}`, appReference), "")
  assert.equal(sanitizeGodswayProviderOrderNumber(`x-${appReference}-y`, appReference), "")
})

test("a response echoing our reference yields no order number", () => {
  const appReference = "TELECEL_PBM_123_abc"
  const response = { data: { reference: appReference, status: "SUCCESSFUL" } }
  assert.equal(sanitizeGodswayProviderOrderNumber(extractGodswayOrderNumber(response), appReference), "")
})
