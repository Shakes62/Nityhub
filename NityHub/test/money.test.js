// Unit tests for the money math guarding real user balances.
//
// These import ./lib/money.js directly and never touch domain.js, so no
// Firebase connection is opened. Run with: npm test

import test from "node:test"
import assert from "node:assert/strict"

import {
  toMoneyNumber,
  toMoneyUnits,
  fromMoneyUnits,
  hashStableKey,
  sanitizeMutationId,
  trimWalletMutationHistory,
} from "../src/lib/money.js"

test("toMoneyNumber rounds to 2dp", () => {
  assert.equal(toMoneyNumber(1.005), 1.01)
  assert.equal(toMoneyNumber(1.004), 1)
  assert.equal(toMoneyNumber(10), 10)
  assert.equal(toMoneyNumber(0.1 + 0.2), 0.3)
})

test("toMoneyNumber parses numeric strings", () => {
  assert.equal(toMoneyNumber("12.50"), 12.5)
  assert.equal(toMoneyNumber("0"), 0)
})

test("toMoneyNumber falls back on non-finite input", () => {
  assert.equal(toMoneyNumber(undefined), 0)
  assert.equal(toMoneyNumber(undefined, 5), 5)
  assert.equal(toMoneyNumber("abc", 7), 7)
  assert.equal(toMoneyNumber(NaN, 3), 3)
  assert.equal(toMoneyNumber(Infinity, 2), 2)
  assert.equal(toMoneyNumber(-Infinity, 2), 2)
})

test("toMoneyNumber coerces null and empty string to 0, NOT the fallback", () => {
  // Sharp edge, asserted so it cannot change silently: Number(null) === 0 and
  // Number("") === 0 are both finite, so the fallback is never reached. Only
  // undefined / NaN / non-numeric strings / Infinity fall back. Callers that
  // need "missing means fallback" must not pass null or "".
  assert.equal(toMoneyNumber(null, 9), 0)
  assert.equal(toMoneyNumber("", 9), 0)
  assert.equal(toMoneyNumber([], 9), 0)
  // Whereas undefined does fall back.
  assert.equal(toMoneyNumber(undefined, 9), 9)
})

test("toMoneyUnits converts to integer pesewas", () => {
  assert.equal(toMoneyUnits(1), 100)
  assert.equal(toMoneyUnits(12.34), 1234)
  assert.equal(toMoneyUnits(0.01), 1)
  assert.equal(toMoneyUnits(0), 0)
})

test("toMoneyUnits always yields a safe integer", () => {
  for (const value of [1, 12.34, 0.07, 99.99, 1000.5, 0.1 + 0.2]) {
    const units = toMoneyUnits(value)
    assert.ok(Number.isSafeInteger(units), `${value} -> ${units} must be a safe integer`)
  }
})

test("fromMoneyUnits converts back to major units", () => {
  assert.equal(fromMoneyUnits(100), 1)
  assert.equal(fromMoneyUnits(1234), 12.34)
  assert.equal(fromMoneyUnits(1), 0.01)
  assert.equal(fromMoneyUnits(0), 0)
})

test("fromMoneyUnits falls back on non-finite input", () => {
  assert.equal(fromMoneyUnits(undefined, 4), 4)
  assert.equal(fromMoneyUnits("abc", 6), 6)
})

test("units round-trip without loss", () => {
  for (const value of [0, 0.01, 1, 12.34, 99.99, 1000.5, 250, 0.07]) {
    assert.equal(fromMoneyUnits(toMoneyUnits(value)), toMoneyNumber(value), `round-trip failed for ${value}`)
  }
})

test("repeated addition in units does not drift", () => {
  // The bug this design exists to prevent: 0.1 + 0.2 !== 0.3 in floats.
  // Adding 0.1 a thousand times in major units drifts; in minor units it must not.
  let units = 0
  for (let i = 0; i < 1000; i++) {
    units += toMoneyUnits(0.1)
  }
  assert.equal(units, 10000)
  assert.equal(fromMoneyUnits(units), 100)
})

test("debit then credit restores the exact starting balance", () => {
  // Mirrors purchase-debit followed by purchase-refund.
  const start = toMoneyUnits(50)
  const price = toMoneyUnits(12.34)
  const afterDebit = start - price
  const afterRefund = afterDebit + price

  assert.equal(fromMoneyUnits(afterDebit), 37.66)
  assert.equal(afterRefund, start)
  assert.equal(fromMoneyUnits(afterRefund), 50)
})

test("hashStableKey is deterministic and 48 chars", () => {
  const key = hashStableKey("user:MTN:0241234567:pkg1")
  assert.equal(key.length, 48)
  assert.equal(key, hashStableKey("user:MTN:0241234567:pkg1"))
  assert.match(key, /^[0-9a-f]{48}$/)
})

test("hashStableKey separates distinct purchase intents", () => {
  const a = hashStableKey("user:MTN:0241234567:pkg1")
  const b = hashStableKey("user:MTN:0241234567:pkg2")
  const c = hashStableKey("user:MTN:0247654321:pkg1")
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})

test("hashStableKey handles empty input", () => {
  assert.equal(hashStableKey("").length, 48)
  assert.equal(hashStableKey(undefined), hashStableKey(""))
})

test("sanitizeMutationId strips RTDB-unsafe path characters", () => {
  // `.`, `#`, `$`, `[`, `]`, `/` are rejected by RTDB in keys.
  assert.equal(sanitizeMutationId("deposit:TRX.123"), "deposit:TRX_123")
  assert.equal(sanitizeMutationId("a/b#c$d[e]f"), "a_b_c_d_e_f")
  assert.equal(sanitizeMutationId("purchase-debit:TRX_1"), "purchase-debit:TRX_1")
})

test("sanitizeMutationId never emits a character RTDB rejects", () => {
  const dirty = "deposit:.#$[]/\\ TRX@2025!"
  const safe = sanitizeMutationId(dirty)
  for (const char of [".", "#", "$", "[", "]", "/"]) {
    assert.ok(!safe.includes(char), `sanitized id must not contain ${char}`)
  }
})

test("sanitizeMutationId caps length at 120", () => {
  assert.equal(sanitizeMutationId("x".repeat(500)).length, 120)
})

test("sanitizeMutationId uses fallback when value is empty", () => {
  assert.equal(sanitizeMutationId("", "fallback-id"), "fallback-id")
  assert.equal(sanitizeMutationId("   ", "fallback-id"), "fallback-id")
  assert.equal(sanitizeMutationId(null, "fallback-id"), "fallback-id")
  assert.equal(sanitizeMutationId("", ""), "")
})

test("trimWalletMutationHistory keeps history under the limit untouched", () => {
  const history = { a: { timestamp: 1 }, b: { timestamp: 2 } }
  assert.deepEqual(trimWalletMutationHistory(history, 10), history)
})

test("trimWalletMutationHistory keeps the newest entries", () => {
  const history = {
    oldest: { timestamp: 1 },
    middle: { timestamp: 2 },
    newest: { timestamp: 3 },
  }
  const trimmed = trimWalletMutationHistory(history, 2)
  assert.deepEqual(Object.keys(trimmed).sort(), ["middle", "newest"])
  assert.ok(!("oldest" in trimmed))
})

test("trimWalletMutationHistory handles boundary and empty input", () => {
  const history = { a: { timestamp: 1 }, b: { timestamp: 2 } }
  // Exactly at the limit is retained in full.
  assert.equal(Object.keys(trimWalletMutationHistory(history, 2)).length, 2)
  assert.deepEqual(trimWalletMutationHistory({}, 5), {})
  assert.deepEqual(trimWalletMutationHistory(undefined, 5), {})
})

test("trimWalletMutationHistory tolerates entries missing timestamps", () => {
  const history = {
    withTs: { timestamp: 5 },
    noTs: { amount: 1 },
  }
  const trimmed = trimWalletMutationHistory(history, 1)
  assert.deepEqual(Object.keys(trimmed), ["withTs"])
})
