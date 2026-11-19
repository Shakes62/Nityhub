import test from "node:test"
import assert from "node:assert/strict"
import { classifyRepairState, canRedispatchAfterStatus, isValidRepairReference, hasProviderSubmissionEvidence } from "../src/lib/repair-rules.js"

test("repair returns delivered and refunded orders without another dispatch", () => {
  assert.equal(classifyRepairState({ status: "delivered", paymentStatus: "success" }), "delivered")
  assert.equal(classifyRepairState({ status: "failed", paymentStatus: "wallet_refunded" }), "refunded")
  assert.equal(classifyRepairState({ status: "failed", paymentStatus: "success", refunded: true }), "refunded")
})

test("an uncertain or unconfirmed order is reconciliation only", () => {
  assert.equal(classifyRepairState({ status: "processing", paymentStatus: "wallet_debited", retryEligible: false }), "processing")
  assert.equal(canRedispatchAfterStatus({ previousState: "processing", upstream: { supported: false } }), false)
  assert.equal(canRedispatchAfterStatus({ previousState: "processing", upstream: { status: "pending" } }), false)
})

test("a definitive upstream rejection permits one guarded fallback", () => {
  assert.equal(classifyRepairState({ status: "failed", paymentStatus: "success" }), "retryable")
  assert.equal(canRedispatchAfterStatus({ previousState: "processing", upstream: { status: "failed", providerResponse: { data: { status: "failed" } } } }), true)
  assert.equal(canRedispatchAfterStatus({ previousState: "retryable", upstream: { supported: false }, order: { status: "failed", providerAttempts: [{ uncertain: false }] } }), true)
  assert.equal(canRedispatchAfterStatus({ previousState: "retryable", upstream: { status: "failed" } }), false)
  assert.equal(canRedispatchAfterStatus({ previousState: "processing", upstream: { status: "failed", providerResponse: { status: "failed" } }, order: { repairDispatchClaim: { claimedAt: Date.now() } } }), false)
})

test("repair references accept Paystack and app references while rejecting unsafe strings", () => {
  assert.equal(isValidRepairReference("MTN_DATA_1234567890_deadbeef"), true)
  assert.equal(isValidRepairReference("T12345678"), true)
  assert.equal(isValidRepairReference("pay_abcdef12345"), true)
  assert.equal(isValidRepairReference("../../orders"), false)
  assert.equal(isValidRepairReference("x"), false)
  assert.equal(isValidRepairReference(""), false)
  assert.equal(isValidRepairReference("has spaces in ref"), false)
})

test("classifyRepairState detects unpaid and active claim states", () => {
  assert.equal(classifyRepairState({ status: "pending", paymentStatus: "pending" }), "unpaid")
  assert.equal(classifyRepairState({ status: "failed", paymentStatus: "failed" }), "unpaid")
  assert.equal(classifyRepairState({ status: "failed", paymentStatus: "success", repairDispatchClaim: { token: "123" } }), "processing")
  assert.equal(classifyRepairState({ status: "pending", paymentStatus: "success" }), "reconcile")
})

test("canRedispatchAfterStatus respects the 3-state error matrix", () => {
  // Never redispatch if upstream is still delivered or pending
  assert.equal(canRedispatchAfterStatus({ previousState: "retryable", upstream: { status: "delivered" } }), false)
  assert.equal(canRedispatchAfterStatus({ previousState: "retryable", upstream: { status: "processing" } }), false)
  // Redispatch only on definitive failure or cancelled
  assert.equal(canRedispatchAfterStatus({ previousState: "reconcile", upstream: { status: "cancelled", providerResponse: { status: "cancelled" } } }), true)
  assert.equal(canRedispatchAfterStatus({ previousState: "reconcile", upstream: { status: "failed", providerResponse: { success: false } } }), true)
  // Unsupported status on non-retryable order stays false
  assert.equal(canRedispatchAfterStatus({ previousState: "reconcile", upstream: { supported: false } }), false)
})

test("a hubnet reference echo is not evidence that an order was submitted", () => {
  const reference = "GUEST_DATA_1700000000000_abcdef"
  // Hubnet stores our own reference as its provider reference before any request.
  const reconstructed = { reference, providerReference: reference, statusSource: "repair_reconstruction", status: "failed", paymentStatus: "success", retryEligible: true }
  assert.equal(hasProviderSubmissionEvidence(reconstructed, { providerSubmissionStatus: "pending" }), false)
  assert.equal(canRedispatchAfterStatus({ previousState: "retryable", upstream: null, order: reconstructed, intent: { providerSubmissionStatus: "pending" } }), true)
  // A provider-issued id, or a recorded submission, does count.
  assert.equal(hasProviderSubmissionEvidence({ ...reconstructed, providerOrderNumber: "CK-123" }), true)
  assert.equal(hasProviderSubmissionEvidence({ ...reconstructed, providerReference: "TXN-999" }), true)
  assert.equal(hasProviderSubmissionEvidence(reconstructed, { providerSubmissionStatus: "submitted" }), true)
  assert.equal(canRedispatchAfterStatus({ previousState: "retryable", upstream: null, order: reconstructed, intent: { providerSubmissionStatus: "submitted" } }), false)
})
