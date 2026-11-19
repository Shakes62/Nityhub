import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"

import {
  verifyPaystackWebhookSignature,
  WebhookReplayCache,
  isEligibleWalletDeposit,
} from "../src/lib/deposit-rules.js"

test("verifyPaystackWebhookSignature validates authentic HMAC-SHA512 payload", () => {
  const secret = "sk_test_secret_key_12345"
  const payload = JSON.stringify({ event: "charge.success", data: { reference: "REF_001" } })
  const rawBody = Buffer.from(payload, "utf8")
  const validSignature = crypto.createHmac("sha512", secret).update(rawBody).digest("hex")

  assert.equal(verifyPaystackWebhookSignature(rawBody, validSignature, secret), true)
})

test("verifyPaystackWebhookSignature rejects tampered body, wrong secret, or non-buffer", () => {
  const secret = "sk_test_secret_key_12345"
  const payload = JSON.stringify({ event: "charge.success", data: { reference: "REF_001" } })
  const rawBody = Buffer.from(payload, "utf8")
  const validSignature = crypto.createHmac("sha512", secret).update(rawBody).digest("hex")

  // Tampered payload
  const tamperedBody = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "REF_002" } }), "utf8")
  assert.equal(verifyPaystackWebhookSignature(tamperedBody, validSignature, secret), false)

  // Wrong secret
  assert.equal(verifyPaystackWebhookSignature(rawBody, validSignature, "wrong_secret"), false)

  // Non-buffer payload
  assert.equal(verifyPaystackWebhookSignature(payload, validSignature, secret), false)

  // Empty or missing arguments
  assert.equal(verifyPaystackWebhookSignature(null, validSignature, secret), false)
  assert.equal(verifyPaystackWebhookSignature(rawBody, "", secret), false)
  assert.equal(verifyPaystackWebhookSignature(rawBody, validSignature, null), false)

  // Malformed signature (e.g. not 128-hex chars)
  assert.equal(verifyPaystackWebhookSignature(rawBody, "invalid-sig", secret), false)
})

test("WebhookReplayCache detects replayed webhook payloads within TTL and respects expiry", async () => {
  const shortTtlMs = 50
  const cache = new WebhookReplayCache(shortTtlMs)

  assert.equal(cache.isDuplicate("event-1"), false)
  cache.record("event-1")
  assert.equal(cache.isDuplicate("event-1"), true)
  assert.equal(cache.isDuplicate("event-2"), false)

  // Wait for TTL to expire
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.equal(cache.isDuplicate("event-1"), false)

  cache.destroy()
})

test("isEligibleWalletDeposit enforces strict currency, status, reference, and amount validity", () => {
  const validPayment = {
    reference: "DEP_12345",
    currency: "GHS",
    status: "success",
    amount: 5000, // 50.00 GHS in pesewas
    metadata: {
      userId: "user_abc",
    },
  }

  // Exact match
  assert.equal(isEligibleWalletDeposit(validPayment, "DEP_12345", "user_abc"), true)

  // Currency not GHS
  assert.equal(isEligibleWalletDeposit({ ...validPayment, currency: "NGN" }, "DEP_12345", "user_abc"), false)
  assert.equal(isEligibleWalletDeposit({ ...validPayment, currency: "USD" }, "DEP_12345", "user_abc"), false)

  // Status not success
  assert.equal(isEligibleWalletDeposit({ ...validPayment, status: "failed" }, "DEP_12345", "user_abc"), false)
  assert.equal(isEligibleWalletDeposit({ ...validPayment, status: "pending" }, "DEP_12345", "user_abc"), false)

  // Reference mismatch
  assert.equal(isEligibleWalletDeposit(validPayment, "DEP_OTHER", "user_abc"), false)

  // User mismatch
  assert.equal(isEligibleWalletDeposit(validPayment, "DEP_12345", "user_xyz"), false)

  // Invalid or fractional amount
  assert.equal(isEligibleWalletDeposit({ ...validPayment, amount: 0 }, "DEP_12345", "user_abc"), false)
  assert.equal(isEligibleWalletDeposit({ ...validPayment, amount: -100 }, "DEP_12345", "user_abc"), false)
  assert.equal(isEligibleWalletDeposit({ ...validPayment, amount: 50.5 }, "DEP_12345", "user_abc"), false)
  assert.equal(isEligibleWalletDeposit({ ...validPayment, amount: Infinity }, "DEP_12345", "user_abc"), false)
})
