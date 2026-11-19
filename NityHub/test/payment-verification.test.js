import test from "node:test"
import assert from "node:assert/strict"
import { verifiedWalletDepositMatchesOwner } from "../src/lib/payment-verification.js"

const payment = {
  reference: "WALLET_123",
  currency: "GHS",
  amount: 1500,
  metadata: { userId: "user-1", paymentType: "wallet" },
}

test("wallet deposit accepts the exact verified owner, reference, currency and subunit amount", () => {
  assert.equal(verifiedWalletDepositMatchesOwner(payment, "WALLET_123", "user-1"), true)
})

test("wallet deposit rejects absent or different ownership metadata", () => {
  assert.equal(verifiedWalletDepositMatchesOwner({ ...payment, metadata: {} }, "WALLET_123", "user-1"), false)
  assert.equal(verifiedWalletDepositMatchesOwner(payment, "WALLET_123", "user-2"), false)
})

test("wallet deposit rejects a different reference, currency or invalid amount", () => {
  assert.equal(verifiedWalletDepositMatchesOwner(payment, "WALLET_456", "user-1"), false)
  assert.equal(verifiedWalletDepositMatchesOwner({ ...payment, currency: "NGN" }, "WALLET_123", "user-1"), false)
  assert.equal(verifiedWalletDepositMatchesOwner({ ...payment, amount: 0 }, "WALLET_123", "user-1"), false)
  assert.equal(verifiedWalletDepositMatchesOwner({ ...payment, amount: 1.5 }, "WALLET_123", "user-1"), false)
})
