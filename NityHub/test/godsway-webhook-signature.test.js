// Signature verification for CK-Godsway webhooks.
//
// CK signs every delivery with a hex HMAC-SHA256 of the raw body and sends it
// as X-Webhook-Signature. It registers one endpoint per account from its API
// Keys page, so the deliveries carry neither the `?token=` query nor the
// `x-webhook-secret` header the generic /webhook route checks. CK treats any
// non-2xx as a failure and auto-disables an endpoint after 10 consecutive
// failures, which makes a wrong verdict here expensive: Telecel orders stop
// receiving status updates entirely.

import test from "node:test"
import assert from "node:assert/strict"
import crypto from "crypto"

import { verifyGodswayWebhookSignature } from "../src/lib/godsway.js"

const SECRET = "whsec_ck_test_5f2a91c4"

/** The delivery shape from CK's published webhook documentation. */
const DELIVERY = {
  id: "evt_2b9f3a1c6b1d4f7e8a9c1b2d",
  event: "order.successful",
  createdAt: "2026-05-25T21:30:42.123Z",
  attempt: 1,
  data: {
    reference: "my-system-tx-9821",
    orderNumber: "ORD-289043",
    network: "MTN",
    recipient: "0201234567",
    capacity: "5GB",
    amount: 25.5,
    status: "SUCCESSFUL",
    createdAt: "2026-05-25T21:30:31.000Z",
    updatedAt: "2026-05-25T21:30:42.000Z",
  },
}

const rawBody = Buffer.from(JSON.stringify(DELIVERY), "utf8")
const sign = (body, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex")

test("a correctly signed delivery is accepted", () => {
  assert.equal(verifyGodswayWebhookSignature(rawBody, sign(rawBody), SECRET), true)
})

test("an uppercase hex signature is accepted", () => {
  assert.equal(verifyGodswayWebhookSignature(rawBody, sign(rawBody).toUpperCase(), SECRET), true)
})

test("surrounding whitespace on the header is tolerated", () => {
  assert.equal(verifyGodswayWebhookSignature(rawBody, `  ${sign(rawBody)}  `, SECRET), true)
})

test("a body tampered with in transit is rejected", () => {
  const tampered = Buffer.from(JSON.stringify({ ...DELIVERY, data: { ...DELIVERY.data, amount: 0.01 } }), "utf8")
  assert.equal(verifyGodswayWebhookSignature(tampered, sign(rawBody), SECRET), false)
})

test("a signature from a different secret is rejected", () => {
  assert.equal(verifyGodswayWebhookSignature(rawBody, sign(rawBody, "wrong-secret"), SECRET), false)
})

test("re-serialized JSON does not verify, so the raw bytes must be used", () => {
  // Key order and whitespace both change the HMAC. This is why the route reads
  // req.rawBody rather than JSON.stringify(req.body).
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString("utf8")), null, 2), "utf8")
  assert.equal(verifyGodswayWebhookSignature(reserialized, sign(rawBody), SECRET), false)
})

test("a missing or malformed signature is rejected without throwing", () => {
  // timingSafeEqual throws on a length mismatch, so these are screened first.
  for (const value of ["", "   ", "not-hex", "abc123", null, undefined, sign(rawBody).slice(0, 63)]) {
    assert.equal(verifyGodswayWebhookSignature(rawBody, value, SECRET), false)
  }
})

test("an unconfigured secret never verifies", () => {
  assert.equal(verifyGodswayWebhookSignature(rawBody, sign(rawBody), ""), false)
  assert.equal(verifyGodswayWebhookSignature(rawBody, sign(rawBody), null), false)
})

test("a non-buffer body is rejected rather than coerced", () => {
  // Guards the "[object Object]" failure mode: if the raw body was lost to an
  // earlier JSON parser, refuse instead of hashing a stringified object.
  assert.equal(verifyGodswayWebhookSignature(DELIVERY, sign(rawBody), SECRET), false)
  assert.equal(verifyGodswayWebhookSignature(rawBody.toString("utf8"), sign(rawBody), SECRET), false)
})
