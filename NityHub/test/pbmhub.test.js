// Unit tests for the PBM HUB provider helpers.
//
// The two things worth pinning down here both cost real money when wrong:
// failure classification (a misread failure either refunds an order that was
// actually delivered, or withholds a refund that is owed) and the size string
// (a size PBM HUB does not recognise fails after the wallet is already debited).

import test from "node:test"
import assert from "node:assert/strict"

import {
  classifyPbmhubFailure,
  extractPbmhubErrorCode,
  extractPbmhubOrderReference,
  formatPbmhubSizeFromVolume,
  getPbmhubStatusDetails,
  isPbmhubDuplicateReplay,
  isPbmhubOrderNotFound,
} from "../src/lib/pbmhub.js"
import {
  buildDefaultProviderMappings,
  describeProviderMappingGaps,
  isCompleteProviderMapping,
  normalizeProviderMappings,
} from "../src/lib/provider-mapping.js"
import { isTerminalOrderStatus } from "../src/lib/order-status.js"

/* ------------------------------ Size strings ------------------------------ */

test("a whole-GB volume becomes a GB size string", () => {
  assert.equal(formatPbmhubSizeFromVolume(1000), "1GB")
  assert.equal(formatPbmhubSizeFromVolume(50000), "50GB")
})

test("a sub-GB volume stays in MB", () => {
  assert.equal(formatPbmhubSizeFromVolume(500), "500MB")
  assert.equal(formatPbmhubSizeFromVolume(100), "100MB")
})

test("a part-GB volume keeps its fraction rather than rounding to a different bundle", () => {
  assert.equal(formatPbmhubSizeFromVolume(1500), "1.5GB")
  assert.equal(formatPbmhubSizeFromVolume(2500), "2.5GB")
})

test("a non-positive volume yields no size rather than an empty bundle", () => {
  assert.equal(formatPbmhubSizeFromVolume(0), "")
  assert.equal(formatPbmhubSizeFromVolume(-1000), "")
  assert.equal(formatPbmhubSizeFromVolume("not a number"), "")
})

/* --------------------------- Order reference ------------------------------ */

test("the pollable reference is read, not purchase_id or order_id", () => {
  // Only `reference` resolves on GET /orders/:reference; the other two 404,
  // which would leave every order open until the reconciler gave up.
  const purchaseResponse = {
    success: true,
    data: {
      purchase_id: "API_1F3A9C27B54D8E60A1B2",
      order_id: "ORD_20260703_XYZ789",
      reference: "ORD-K4T7Q2M9PX",
    },
  }
  assert.equal(extractPbmhubOrderReference(purchaseResponse), "ORD-K4T7Q2M9PX")
})

test("a response with no reference yields an empty string, not undefined", () => {
  assert.equal(extractPbmhubOrderReference({ success: true, data: {} }), "")
  assert.equal(extractPbmhubOrderReference({}), "")
})

/* ---------------------------- Duplicate replay ---------------------------- */

test("an idempotent replay is recognised so it is not read as a second charge", () => {
  assert.equal(
    isPbmhubDuplicateReplay({ success: true, message: "Duplicate request - no new charge" }),
    true,
  )
  assert.equal(isPbmhubDuplicateReplay({ success: true, message: "Purchase initiated successfully" }), false)
  assert.equal(isPbmhubDuplicateReplay({}), false)
})

/* ------------------------------ Error codes ------------------------------- */

test("the machine-readable error code is read from either envelope level", () => {
  assert.equal(extractPbmhubErrorCode({ error_code: "wallet_frozen" }), "WALLET_FROZEN")
  assert.equal(extractPbmhubErrorCode({ data: { error_code: "INSUFFICIENT_BALANCE" } }), "INSUFFICIENT_BALANCE")
  assert.equal(extractPbmhubErrorCode({}), "")
})

test("each documented purchase failure maps to its own provider error code", () => {
  const cases = [
    ["INSUFFICIENT_BALANCE", "INSUFFICIENT_PBMHUB_BALANCE"],
    ["WALLET_FROZEN", "PBMHUB_WALLET_FROZEN"],
    ["NETWORK_UNAVAILABLE", "PBMHUB_NETWORK_UNAVAILABLE"],
    ["DUPLICATE_PURCHASE_WINDOW", "PBMHUB_DUPLICATE_WINDOW"],
    ["PROVIDER_PURCHASE_FAILED", "PBMHUB_PURCHASE_FAILED"],
    ["CACHED_FAILURE", "PBMHUB_CACHED_FAILURE"],
  ]

  for (const [errorCode, expected] of cases) {
    assert.equal(
      classifyPbmhubFailure({ success: false, error_code: errorCode, message: "nope" }).code,
      expected,
      `${errorCode} should classify as ${expected}`,
    )
  }
})

test("a 401 is an auth failure even when the body says nothing useful", () => {
  const failure = classifyPbmhubFailure({ success: false, message: "Invalid or inactive API key" }, "", 401)
  assert.equal(failure.code, "PBMHUB_AUTH_FAILED")
  assert.match(failure.message, /PBMHUB_API_KEY/)
})

test("the two 429s are told apart by their error code", () => {
  // DUPLICATE_PURCHASE_WINDOW carries a code and means "wait for this
  // recipient"; a bare 429 is the rate limiter and means "slow down".
  assert.equal(
    classifyPbmhubFailure({ success: false, error_code: "DUPLICATE_PURCHASE_WINDOW" }, "", 429).code,
    "PBMHUB_DUPLICATE_WINDOW",
  )
  assert.equal(classifyPbmhubFailure({ success: false, message: "Too many requests" }, "", 429).code, "PBMHUB_RATE_LIMITED")
})

test("a storefront-only field is named as our bug, not a wallet problem", () => {
  const failure = classifyPbmhubFailure({ success: false, error_code: "STOREFRONT_CHANNEL_REQUIRED" }, "", 403)
  assert.equal(failure.code, "PBMHUB_API_ERROR")
  assert.match(failure.message, /request-builder bug/)
})

test("a 404 points at the package mapping rather than a generic API error", () => {
  assert.equal(classifyPbmhubFailure({ success: false, message: "Network not found" }, "", 404).code, "PBMHUB_INVALID_PACKAGE")
})

test("the same 404 on a status lookup is 'not indexed yet', not a failure", () => {
  // On /purchase a 404 is a bad network or size; on /orders/:reference it is
  // indexing lag. Reading the status one as a failure refunds a live order.
  assert.equal(isPbmhubOrderNotFound({ statusCode: 404 }), true)
  assert.equal(isPbmhubOrderNotFound({ responseData: { success: false, message: "Order not found" } }), true)
  assert.equal(isPbmhubOrderNotFound({ statusCode: 503, message: "upstream down" }), false)
  assert.equal(isPbmhubOrderNotFound({}), false)
})

test("an unrecognised failure keeps the provider's own wording", () => {
  const failure = classifyPbmhubFailure({ success: false, message: "Something odd happened" })
  assert.equal(failure.code, "PBMHUB_API_ERROR")
  assert.match(failure.message, /Something odd happened/)
})

/* ----------------------------- Status details ----------------------------- */

test("the documented lifecycle maps onto internal statuses", () => {
  assert.equal(getPbmhubStatusDetails({ success: true, data: { status: "PROCESSING" } }).normalizedStatus, "processing")
  assert.equal(getPbmhubStatusDetails({ success: true, data: { status: "DELIVERED" } }).normalizedStatus, "delivered")
  assert.equal(getPbmhubStatusDetails({ success: true, data: { status: "FAILED" } }).normalizedStatus, "failed")
})

test("an unknown status keeps the order polling instead of failing it", () => {
  // The invariant is non-terminality, not one specific status: landing on
  // "failed" here would refund a bundle that may still be on its way. A status
  // the shared normalizer recognises in part ("QUEUED_...") settles on
  // accepted; one it cannot read at all falls back to processing. Both keep the
  // reconciler polling.
  assert.equal(
    isTerminalOrderStatus(getPbmhubStatusDetails({ success: true, data: { status: "QUEUED_UPSTREAM" } }).normalizedStatus),
    false,
  )
  assert.equal(
    getPbmhubStatusDetails({ success: true, data: { status: "WAITING_ON_TELCO" } }).normalizedStatus,
    "processing",
  )
  assert.equal(getPbmhubStatusDetails({ success: true, data: {} }).normalizedStatus, "processing")
})

test("an explicit failure envelope still normalizes to failed", () => {
  assert.equal(getPbmhubStatusDetails({ success: false, message: "Order rejected" }).normalizedStatus, "failed")
})

/* ---------------------------- Package mappings ---------------------------- */

test("all three networks derive a PBM HUB network id without configuration", () => {
  assert.equal(buildDefaultProviderMappings("mtn", 1000).pbmhub.network, "mtnup2u")
  assert.equal(buildDefaultProviderMappings("at", 1000).pbmhub.network, "airteltigo")
  assert.equal(buildDefaultProviderMappings("telecel", 1000).pbmhub.network, "telecel")
})

test("every supported network is complete for PBM HUB with no explicit mapping", () => {
  for (const network of ["mtn", "at", "telecel"]) {
    const entry = { id: `${network}-1gb`, label: "1GB", volume: 1000 }
    assert.equal(isCompleteProviderMapping(network, "pbmhub", entry), true, `${network} should be complete`)
    assert.deepEqual(describeProviderMappingGaps(network, "pbmhub", entry).missing, [])
  }
})

test("a zero-volume package reports size as the blocking field", () => {
  const gaps = describeProviderMappingGaps("mtn", "pbmhub", { id: "broken", label: "?", volume: 0 })
  assert.deepEqual(gaps.missing, ["size"])
})

test("an explicit mapping overrides the derived default and keeps the size casing", () => {
  const mappings = normalizeProviderMappings("mtn", { pbmhub: { network: "MTNUP2U", size: "1.5GB" } }, 1000)
  // The network id is matched case-insensitively upstream, but `size` is
  // compared against PBM HUB's own catalog strings, so it must survive verbatim.
  assert.equal(mappings.pbmhub.network, "mtnup2u")
  assert.equal(mappings.pbmhub.size, "1.5GB")
})
