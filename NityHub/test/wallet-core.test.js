// Unit tests for the wallet mutation decision core.
//
// This is the logic that runs inside the RTDB transaction updater and is what
// stands between the platform and double-charging a real user. Imports
// lib/wallet-core.js directly, so no Firebase connection is opened.

import test from "node:test"
import assert from "node:assert/strict"

import { computeWalletMutation, WALLET_MUTATION } from "../src/lib/wallet-core.js"
import { toMoneyUnits } from "../src/lib/money.js"

const NOW = 1_700_000_000_000

/** Build the options a purchase debit would pass. */
function debit(amount, overrides = {}) {
  return {
    deltaUnits: -toMoneyUnits(amount),
    delta: -amount,
    safeMutationId: "purchase-debit:TRX_1",
    requireSufficient: true,
    reason: "purchase",
    reference: "TRX_1",
    now: NOW,
    ...overrides,
  }
}

/** Build the options a deposit credit would pass. */
function credit(amount, overrides = {}) {
  return {
    deltaUnits: toMoneyUnits(amount),
    delta: amount,
    safeMutationId: "deposit:TRX_2",
    requireSufficient: false,
    reason: "deposit",
    reference: "TRX_2",
    now: NOW,
    ...overrides,
  }
}

test("credit increases the balance", () => {
  const result = computeWalletMutation({ balance: 10 }, credit(5))
  assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(result.wallet.balance, 15)
  assert.equal(result.currentBalance, 10)
})

test("debit decreases the balance", () => {
  const result = computeWalletMutation({ balance: 50 }, debit(12.34))
  assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(result.wallet.balance, 37.66)
})

test("debit of the exact balance is allowed and lands on zero", () => {
  const result = computeWalletMutation({ balance: 25 }, debit(25))
  assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(result.wallet.balance, 0)
})

test("debit exceeding the balance is rejected when requireSufficient", () => {
  const result = computeWalletMutation({ balance: 10 }, debit(10.01))
  assert.equal(result.outcome, WALLET_MUTATION.INSUFFICIENT)
  // The wallet must come back untouched.
  assert.equal(result.wallet.balance, 10)
})

test("overdraft is allowed when requireSufficient is false", () => {
  // Refund/adjustment paths intentionally permit going negative.
  const result = computeWalletMutation({ balance: 5 }, debit(10, { requireSufficient: false }))
  assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(result.wallet.balance, -5)
})

test("a one-pesewa overdraft is still rejected", () => {
  const result = computeWalletMutation({ balance: 0.01 }, debit(0.02))
  assert.equal(result.outcome, WALLET_MUTATION.INSUFFICIENT)
})

// --- The double-charge guard -------------------------------------------------

test("replaying the same mutation id does not apply the delta twice", () => {
  const first = computeWalletMutation({ balance: 50 }, debit(20))
  assert.equal(first.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(first.wallet.balance, 30)

  // Feed the committed wallet back in, exactly as an RTDB retry would.
  const replay = computeWalletMutation(first.wallet, debit(20))
  assert.equal(replay.outcome, WALLET_MUTATION.DUPLICATE)
  assert.equal(replay.wallet.balance, 30, "balance must not move on replay")
})

test("replaying ten times still charges exactly once", () => {
  let wallet = { balance: 100 }
  const opts = debit(10)

  const first = computeWalletMutation(wallet, opts)
  assert.equal(first.outcome, WALLET_MUTATION.COMMIT)
  wallet = first.wallet

  for (let i = 0; i < 10; i++) {
    const replay = computeWalletMutation(wallet, opts)
    assert.equal(replay.outcome, WALLET_MUTATION.DUPLICATE)
    wallet = replay.wallet
  }

  assert.equal(wallet.balance, 90, "ten replays must leave a single 10.00 debit")
})

test("duplicate returns the original mutation record", () => {
  const first = computeWalletMutation({ balance: 50 }, debit(20))
  const replay = computeWalletMutation(first.wallet, debit(20))
  assert.equal(replay.duplicateData.amount, -20)
  assert.equal(replay.duplicateData.balance, 30)
  assert.equal(replay.duplicateData.reference, "TRX_1")
})

test("distinct mutation ids both apply", () => {
  const first = computeWalletMutation({ balance: 50 }, debit(20))
  const second = computeWalletMutation(first.wallet, debit(20, { safeMutationId: "purchase-debit:TRX_9" }))
  assert.equal(second.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(second.wallet.balance, 10)
})

test("without a mutation id the replay guard is disabled", () => {
  // No id means no idempotency: the caller opted out, so the delta reapplies.
  const opts = credit(5, { safeMutationId: "" })
  const first = computeWalletMutation({ balance: 10 }, opts)
  assert.equal(first.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(first.wallet.balance, 15)
  assert.deepEqual(first.wallet.appliedMutations, {})

  const again = computeWalletMutation(first.wallet, opts)
  assert.equal(again.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(again.wallet.balance, 20)
})

// --- Node shape handling -----------------------------------------------------

test("null current falls back to the caller's snapshot", () => {
  // RTDB passes null on the optimistic first pass.
  const result = computeWalletMutation(null, credit(5, { initialWalletValue: { balance: 30 } }))
  assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(result.wallet.balance, 35)
})

test("null current with no snapshot starts from zero", () => {
  const result = computeWalletMutation(null, credit(5))
  assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(result.wallet.balance, 5)
})

test("a bare numeric node is treated as the balance", () => {
  // Legacy writes stored the balance directly rather than as an object.
  const result = computeWalletMutation(42, credit(8))
  assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(result.wallet.balance, 50)
})

test("an array appliedMutations is ignored rather than trusted", () => {
  const result = computeWalletMutation({ balance: 10, appliedMutations: ["junk"] }, credit(5))
  assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(result.wallet.balance, 15)
  assert.ok(!Array.isArray(result.wallet.appliedMutations))
})

test("unrelated wallet fields are preserved", () => {
  const result = computeWalletMutation({ balance: 10, currency: "GHS", ownerName: "Ama" }, credit(5))
  assert.equal(result.wallet.currency, "GHS")
  assert.equal(result.wallet.ownerName, "Ama")
})

// --- Ledger entry integrity --------------------------------------------------

test("commit records an immutable-shaped ledger entry", () => {
  const result = computeWalletMutation({ balance: 50 }, debit(12.34))
  const entry = result.wallet.appliedMutations["purchase-debit:TRX_1"]
  assert.equal(entry.amount, -12.34)
  assert.equal(entry.balance, 37.66)
  assert.equal(entry.reference, "TRX_1")
  assert.equal(entry.reason, "purchase")
  assert.equal(entry.timestamp, NOW)
  assert.equal(result.wallet.updatedAt, NOW)
})

test("blank reason and reference normalise to null", () => {
  const result = computeWalletMutation({ balance: 50 }, debit(1, { reason: "   ", reference: "" }))
  const entry = result.wallet.appliedMutations["purchase-debit:TRX_1"]
  assert.equal(entry.reason, null)
  assert.equal(entry.reference, null)
})

test("non-object details normalise to an empty object", () => {
  const result = computeWalletMutation({ balance: 50 }, debit(1, { details: ["bad"] }))
  const entry = result.wallet.appliedMutations["purchase-debit:TRX_1"]
  assert.deepEqual(entry.details, {})
})

test("applied mutation history is capped", () => {
  const appliedMutations = {}
  for (let i = 0; i < 5; i++) {
    appliedMutations[`old-${i}`] = { timestamp: i, amount: 1, balance: 1 }
  }
  const result = computeWalletMutation({ balance: 50, appliedMutations }, debit(1, { historyLimit: 3 }))
  const keys = Object.keys(result.wallet.appliedMutations)
  assert.equal(keys.length, 3)
  // The newest entry is the one we just wrote.
  assert.ok(keys.includes("purchase-debit:TRX_1"))
})

// --- Arithmetic integrity ----------------------------------------------------

test("debit then refund restores the starting balance exactly", () => {
  const start = { balance: 50 }
  const debited = computeWalletMutation(start, debit(12.34))
  const refunded = computeWalletMutation(debited.wallet, {
    ...credit(12.34),
    safeMutationId: "purchase-refund:TRX_1",
  })
  assert.equal(refunded.wallet.balance, 50)
})

test("many small debits do not drift the balance", () => {
  let wallet = { balance: 100 }
  for (let i = 0; i < 100; i++) {
    const result = computeWalletMutation(wallet, debit(0.1, { safeMutationId: `d-${i}` }))
    assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
    wallet = result.wallet
  }
  // 100 x 0.10 = 10.00 exactly; naive float addition would drift here.
  assert.equal(wallet.balance, 90)
})

test("a zero-amount mutation commits without moving the balance", () => {
  const result = computeWalletMutation({ balance: 10 }, credit(0))
  assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(result.wallet.balance, 10)
})
