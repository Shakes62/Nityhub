// Tests for package price resolution.
//
// Background: the price used to be resolved twice — once in the browser and
// once on the server — from subtly different expressions:
//
//   server:  toMoneyNumber(agentPrice ?? userPrice, ...)   // ?? keeps 0
//   browser: Number(agentPrice || userPrice || 0)          // || skips 0
//
// The admin catalog editor sends `Number("") || 0` for an untouched agent-price
// field, so a blank wholesale price persisted as 0. The two expressions then
// disagreed: the screen showed the regular price while the server charged 0 —
// agents got free data. More generally, any divergence between those two copies
// mis-priced a customer relative to what they were shown.
//
// There is now one implementation, on the server, and the client renders
// whatever price it is handed.

import test from "node:test"
import assert from "node:assert/strict"

import {
  resolveAgentPrice,
  resolveEffectivePackagePrice,
  resolveUserPrice,
} from "../src/lib/pricing.js"

/* ------------------------- the blank-agent-price bug ---------------------- */

test("a blank agent price falls back to the regular price, not to zero", () => {
  // This is the assertion that would have caught the free-data bug. `Number("")
  // || 0` is exactly what the admin catalog editor sends for an empty field.
  const entry = { userPrice: 6.5, agentPrice: Number("") || 0 }
  assert.equal(resolveAgentPrice(entry), 6.5)
  assert.equal(resolveEffectivePackagePrice(entry, { agentPricing: true }), 6.5)
})

test("an absent agent price falls back to the regular price", () => {
  assert.equal(resolveAgentPrice({ userPrice: 12.8 }), 12.8)
  assert.equal(resolveAgentPrice({ userPrice: 12.8, agentPrice: null }), 12.8)
  assert.equal(resolveAgentPrice({ userPrice: 12.8, agentPrice: "" }), 12.8)
  assert.equal(resolveAgentPrice({ userPrice: 12.8, agentPrice: undefined }), 12.8)
})

test("a nonsensical agent price never becomes a discount", () => {
  assert.equal(resolveAgentPrice({ userPrice: 30, agentPrice: -5 }), 30)
  assert.equal(resolveAgentPrice({ userPrice: 30, agentPrice: "abc" }), 30)
  assert.equal(resolveAgentPrice({ userPrice: 30, agentPrice: NaN }), 30)
})

/* --------------------- non-agents never get agent pricing ----------------- */

test("a regular customer is charged the regular price", () => {
  const entry = { userPrice: 6.5, agentPrice: 6.2 }
  assert.equal(resolveEffectivePackagePrice(entry, { agentPricing: false }), 6.5)
})

test("agent pricing requires an explicit true", () => {
  // Anything falsy or merely truthy-looking must not unlock wholesale rates, so
  // a missing or malformed role lookup can only ever over-charge.
  const entry = { userPrice: 6.5, agentPrice: 6.2 }
  for (const value of [undefined, null, false, 0, "", "false", "agent", 1, {}, []]) {
    assert.equal(
      resolveEffectivePackagePrice(entry, { agentPricing: value }),
      6.5,
      `agentPricing=${JSON.stringify(value)} must not grant agent pricing`,
    )
  }
})

test("omitting the options object entirely charges the regular price", () => {
  const entry = { userPrice: 6.5, agentPrice: 6.2 }
  assert.equal(resolveEffectivePackagePrice(entry), 6.5)
})

test("an actual agent is charged the wholesale price", () => {
  const entry = { userPrice: 6.5, agentPrice: 6.2 }
  assert.equal(resolveEffectivePackagePrice(entry, { agentPricing: true }), 6.2)
})

/* ------------------------------ regular price ---------------------------- */

test("the legacy flat `price` field is still honoured", () => {
  assert.equal(resolveUserPrice({ price: 24 }), 24)
  assert.equal(resolveUserPrice({ userPrice: 25, price: 24 }), 25)
})

test("a missing regular price resolves to zero so the entry is filtered out", () => {
  // Callers drop entries priced at 0 rather than selling a bundle for nothing.
  assert.equal(resolveUserPrice({}), 0)
  assert.equal(resolveUserPrice({ userPrice: 0 }), 0)
  assert.equal(resolveEffectivePackagePrice({}, { agentPricing: true }), 0)
})

test("prices are rounded to two decimal places", () => {
  assert.equal(resolveUserPrice({ userPrice: 6.499999999 }), 6.5)
  assert.equal(resolveAgentPrice({ userPrice: 10, agentPrice: 9.005 }), 9.01)
})

test("telecel-style catalogs where both tiers match resolve identically", () => {
  const entry = { userPrice: 24, agentPrice: 24 }
  assert.equal(resolveEffectivePackagePrice(entry, { agentPricing: false }), 24)
  assert.equal(resolveEffectivePackagePrice(entry, { agentPricing: true }), 24)
})

/* ---------------------------- no cross-subsidy ---------------------------- */

test("an agent price above the regular price is still what agents pay", () => {
  // Not a discount, but the configured value is respected rather than silently
  // clamped — admins are trusted to price their own catalog.
  const entry = { userPrice: 10, agentPrice: 12 }
  assert.equal(resolveEffectivePackagePrice(entry, { agentPricing: true }), 12)
  assert.equal(resolveEffectivePackagePrice(entry, { agentPricing: false }), 10)
})
