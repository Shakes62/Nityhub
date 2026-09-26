// Tests for the reserve → capture/release state machine.
//
// The property being protected: a customer is only ever debited for an order a
// provider actually accepted. A purchase that fails everywhere must leave the
// wallet byte-identical in balance terms — no debit, no refund, nothing.

import test from "node:test"
import assert from "node:assert/strict"

import {
  HOLD_STATUS,
  WALLET_HOLD_OPERATION,
  WALLET_MUTATION,
  computeWalletHoldMutation,
  computeWalletMutation,
  getAvailableWalletBalance,
  getHeldWalletBalance,
} from "../src/lib/wallet-core.js"

const walletWith = (balance, holds = {}) => ({ balance, holds })

const hold = (wallet, { holdId = "h1", amount = 10, ...rest } = {}) =>
  computeWalletHoldMutation(wallet, {
    operation: WALLET_HOLD_OPERATION.HOLD,
    holdId,
    amount,
    ...rest,
  })

const settle = (wallet, operation, holdId = "h1") =>
  computeWalletHoldMutation(wallet, { operation, holdId })

const capture = (wallet, holdId) => settle(wallet, WALLET_HOLD_OPERATION.CAPTURE, holdId)
const release = (wallet, holdId) => settle(wallet, WALLET_HOLD_OPERATION.RELEASE, holdId)

/* --------------------------------- Holding -------------------------------- */

test("a hold reserves funds without touching the balance", () => {
  const result = hold(walletWith(100), { amount: 24 })

  assert.equal(result.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(result.wallet.balance, 100, "the customer has not been charged yet")
  assert.equal(result.heldBalance, 24)
  assert.equal(result.availableBalance, 76)
  assert.equal(result.wallet.holds.h1.status, HOLD_STATUS.HELD)
})

test("a hold is refused when the SPENDABLE balance cannot cover it", () => {
  // 100 in the wallet but 90 already reserved by an in-flight purchase.
  const wallet = walletWith(100, { other: { amount: 90, status: HOLD_STATUS.HELD } })

  assert.equal(hold(wallet, { amount: 24 }).outcome, WALLET_MUTATION.INSUFFICIENT)
  assert.equal(hold(wallet, { amount: 10 }).outcome, WALLET_MUTATION.COMMIT)
})

test("two concurrent purchases cannot both reserve the same funds", () => {
  const first = hold(walletWith(30), { holdId: "a", amount: 24 })
  const second = hold(first.wallet, { holdId: "b", amount: 24 })

  assert.equal(first.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(second.outcome, WALLET_MUTATION.INSUFFICIENT)
})

test("replaying a hold does not reserve twice", () => {
  const first = hold(walletWith(100), { amount: 24 })
  const replay = hold(first.wallet, { amount: 24 })

  assert.equal(replay.outcome, WALLET_MUTATION.DUPLICATE)
  assert.equal(replay.heldBalance, 24)
})

test("a non-positive hold is refused rather than reserving nothing", () => {
  assert.equal(hold(walletWith(100), { amount: 0 }).outcome, WALLET_MUTATION.CONFLICT)
  assert.equal(hold(walletWith(100), { amount: -5 }).outcome, WALLET_MUTATION.CONFLICT)
})

/* -------------------------------- Capturing ------------------------------- */

test("capture is the only thing that moves the balance", () => {
  const held = hold(walletWith(100), { amount: 24 })
  const captured = capture(held.wallet)

  assert.equal(captured.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(captured.wallet.balance, 76)
  assert.equal(captured.heldBalance, 0)
  assert.equal(captured.availableBalance, 76)
  assert.equal(captured.wallet.holds.h1.status, HOLD_STATUS.CAPTURED)
})

test("replaying a capture charges exactly once", () => {
  const held = hold(walletWith(100), { amount: 24 })
  let wallet = capture(held.wallet).wallet

  for (let i = 0; i < 5; i++) {
    const replay = capture(wallet)
    assert.equal(replay.outcome, WALLET_MUTATION.DUPLICATE)
    wallet = replay.wallet
  }

  assert.equal(wallet.balance, 76)
})

/* -------------------------------- Releasing ------------------------------- */

test("a purchase no provider accepted leaves the balance untouched", () => {
  // The whole point of the feature: no debit, no refund, nothing to reconcile.
  const opening = walletWith(100)
  const held = hold(opening, { amount: 24 })
  const released = release(held.wallet)

  assert.equal(released.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(released.wallet.balance, 100)
  assert.equal(released.heldBalance, 0)
  assert.equal(released.availableBalance, 100)
  assert.equal(released.wallet.holds.h1.status, HOLD_STATUS.RELEASED)
})

test("replaying a release gives the money back exactly once", () => {
  const held = hold(walletWith(100), { amount: 24 })
  let wallet = release(held.wallet).wallet

  for (let i = 0; i < 5; i++) {
    const replay = release(wallet)
    assert.equal(replay.outcome, WALLET_MUTATION.DUPLICATE)
    wallet = replay.wallet
  }

  assert.equal(wallet.balance, 100)
})

/* ------------------------------- Conflicts -------------------------------- */

test("a released hold can never be captured", () => {
  // Otherwise a late success on an order we already gave back would charge for
  // it a second time.
  const held = hold(walletWith(100), { amount: 24 })
  const released = release(held.wallet)

  assert.equal(capture(released.wallet).outcome, WALLET_MUTATION.CONFLICT)
  assert.equal(released.wallet.balance, 100)
})

test("a captured hold can never be released", () => {
  // That would hand back money already spent on a delivered order; a genuine
  // reversal has to go through the refund path instead.
  const held = hold(walletWith(100), { amount: 24 })
  const captured = capture(held.wallet)

  assert.equal(release(captured.wallet).outcome, WALLET_MUTATION.CONFLICT)
  assert.equal(captured.wallet.balance, 76)
})

test("settling a hold that never existed does nothing", () => {
  assert.equal(capture(walletWith(100), "ghost").outcome, WALLET_MUTATION.MISSING)
  assert.equal(release(walletWith(100), "ghost").outcome, WALLET_MUTATION.MISSING)
  assert.equal(hold(walletWith(100), { holdId: "" }).outcome, WALLET_MUTATION.MISSING)
})

/* ------------------------- Interaction with debits ------------------------ */

test("a direct debit cannot spend reserved funds", () => {
  // Wallet shows 100, but 90 is reserved for an order in flight.
  const wallet = walletWith(100, { pending: { amount: 90, status: HOLD_STATUS.HELD } })

  const overspend = computeWalletMutation(wallet, {
    deltaUnits: -2400,
    delta: -24,
    requireSufficient: true,
  })
  assert.equal(overspend.outcome, WALLET_MUTATION.INSUFFICIENT)

  const withinAvailable = computeWalletMutation(wallet, {
    deltaUnits: -1000,
    delta: -10,
    requireSufficient: true,
  })
  assert.equal(withinAvailable.outcome, WALLET_MUTATION.COMMIT)
})

test("a credit still lands while funds are reserved", () => {
  const wallet = walletWith(10, { pending: { amount: 10, status: HOLD_STATUS.HELD } })
  const topUp = computeWalletMutation(wallet, { deltaUnits: 5000, delta: 50, requireSufficient: true })

  assert.equal(topUp.outcome, WALLET_MUTATION.COMMIT)
  assert.equal(topUp.nextBalance, 60)
})

/* --------------------------------- Readers -------------------------------- */

test("available and held are derived from the holds, not the stored mirror", () => {
  // A stale or hand-edited heldBalance must never make money unspendable.
  const wallet = {
    balance: 100,
    heldBalance: 999,
    holds: {
      a: { amount: 24, status: HOLD_STATUS.HELD },
      b: { amount: 50, status: HOLD_STATUS.CAPTURED },
      c: { amount: 10, status: HOLD_STATUS.RELEASED },
    },
  }

  assert.equal(getHeldWalletBalance(wallet), 24)
  assert.equal(getAvailableWalletBalance(wallet), 76)
})

test("a wallet with no holds reads as fully available", () => {
  assert.equal(getAvailableWalletBalance({ balance: 42 }), 42)
  assert.equal(getHeldWalletBalance({ balance: 42 }), 0)
  assert.equal(getAvailableWalletBalance(null), 0)
})

/* ------------------------------- No drift --------------------------------- */

test("many hold/capture cycles do not drift the balance", () => {
  let wallet = walletWith(100)
  for (let i = 0; i < 100; i++) {
    wallet = hold(wallet, { holdId: `h${i}`, amount: 0.01 }).wallet
    wallet = capture(wallet, `h${i}`).wallet
  }

  assert.equal(wallet.balance, 99)
  assert.equal(getHeldWalletBalance(wallet), 0)
})

test("hold then release restores the exact opening balance", () => {
  let wallet = walletWith(33.33)
  for (let i = 0; i < 50; i++) {
    wallet = hold(wallet, { holdId: `h${i}`, amount: 1.11 }).wallet
    wallet = release(wallet, `h${i}`).wallet
  }

  assert.equal(wallet.balance, 33.33)
  assert.equal(getAvailableWalletBalance(wallet), 33.33)
})

test("active holds survive pruning even when settled ones are dropped", () => {
  let wallet = walletWith(1000)
  wallet = hold(wallet, { holdId: "keep-me", amount: 5 }).wallet

  for (let i = 0; i < 40; i++) {
    wallet = hold(wallet, { holdId: `s${i}`, amount: 1, historyLimit: 5 }).wallet
    wallet = computeWalletHoldMutation(wallet, {
      operation: WALLET_HOLD_OPERATION.RELEASE,
      holdId: `s${i}`,
      historyLimit: 5,
    }).wallet
  }

  assert.equal(wallet.holds["keep-me"].status, HOLD_STATUS.HELD, "an active hold must never be pruned")
  assert.equal(getHeldWalletBalance(wallet), 5)
  assert.ok(Object.keys(wallet.holds).length <= 6, "settled holds are bounded")
})
