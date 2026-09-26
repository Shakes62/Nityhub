// Tests for per-provider pricing.
//
// Two properties matter here. A provider with no rate of its own must inherit
// the package price rather than selling for nothing, and the price a customer
// is quoted must be the price the till charges — they are resolved by the same
// function, against the same provider, precisely so they cannot drift.

import test from "node:test"
import assert from "node:assert/strict"

import {
  resolveAgentPrice,
  resolveEffectivePackagePrice,
  resolveProviderPricePair,
  resolveUserPrice,
} from "../src/lib/pricing.js"

const packageEntry = {
  id: "mtn-1gb",
  label: "1GB",
  volume: 1000,
  userPrice: 6,
  agentPrice: 5,
  providerPricing: {
    pbmhub: { userPrice: 7, agentPrice: 6.5 },
    gigshub: { userPrice: 5.5 },
  },
}

/* --------------------------- Per-provider rates --------------------------- */

test("a provider with its own rate is charged at that rate", () => {
  assert.equal(resolveUserPrice(packageEntry, { provider: "pbmhub" }), 7)
  assert.equal(resolveAgentPrice(packageEntry, { provider: "pbmhub" }), 6.5)
})

test("a provider with no rate inherits the package price", () => {
  // Never zero: an unpriced provider must not sell the bundle for nothing.
  assert.equal(resolveUserPrice(packageEntry, { provider: "hubnet" }), 6)
  assert.equal(resolveAgentPrice(packageEntry, { provider: "hubnet" }), 5)
})

test("a partial override falls back per tier, not all-or-nothing", () => {
  // gigshub sets only a regular price, so agents keep the package's wholesale.
  assert.equal(resolveUserPrice(packageEntry, { provider: "gigshub" }), 5.5)
  assert.equal(resolveAgentPrice(packageEntry, { provider: "gigshub" }), 5)
})

test("naming no provider keeps the package price", () => {
  assert.equal(resolveUserPrice(packageEntry), 6)
  assert.equal(resolveAgentPrice(packageEntry), 5)
})

test("an unknown provider falls back rather than resolving to zero", () => {
  assert.equal(resolveUserPrice(packageEntry, { provider: "nonsense" }), 6)
})

/* ------------------------------ Zero guards ------------------------------- */

test("a zero or blank provider rate is ignored, not charged", () => {
  // The admin editor sends Number("") || 0 for an untouched field. Honouring
  // that literally would hand out free data.
  const entry = {
    userPrice: 6,
    agentPrice: 5,
    providerPricing: { pbmhub: { userPrice: 0, agentPrice: 0 } },
  }

  assert.equal(resolveUserPrice(entry, { provider: "pbmhub" }), 6)
  assert.equal(resolveAgentPrice(entry, { provider: "pbmhub" }), 5)
})

test("a negative provider rate is ignored", () => {
  const entry = { userPrice: 6, providerPricing: { pbmhub: { userPrice: -3 } } }
  assert.equal(resolveUserPrice(entry, { provider: "pbmhub" }), 6)
})

test("a malformed providerPricing block is ignored rather than throwing", () => {
  for (const providerPricing of [null, "nope", [], 42]) {
    const entry = { userPrice: 6, providerPricing }
    assert.equal(resolveUserPrice(entry, { provider: "pbmhub" }), 6)
  }

  assert.equal(resolveUserPrice({ userPrice: 6, providerPricing: { pbmhub: "nope" } }, { provider: "pbmhub" }), 6)
})

/* ---------------------------- Tier resolution ----------------------------- */

test("the effective price picks the tier and the provider together", () => {
  assert.equal(resolveEffectivePackagePrice(packageEntry, { agentPricing: true, provider: "pbmhub" }), 6.5)
  assert.equal(resolveEffectivePackagePrice(packageEntry, { agentPricing: false, provider: "pbmhub" }), 7)
  assert.equal(resolveEffectivePackagePrice(packageEntry, { agentPricing: true, provider: "hubnet" }), 5)
})

test("anything other than an explicit true charges the regular rate", () => {
  // A malformed role can only ever over-charge relative to wholesale, never
  // hand out an unearned discount.
  for (const agentPricing of ["true", 1, {}, null, undefined]) {
    assert.equal(resolveEffectivePackagePrice(packageEntry, { agentPricing, provider: "pbmhub" }), 7)
  }
})

test("legacy rows priced only with `price` still sell", () => {
  const legacy = { price: 4 }
  assert.equal(resolveUserPrice(legacy, { provider: "pbmhub" }), 4)
  assert.equal(resolveAgentPrice(legacy, { provider: "pbmhub" }), 4)
})

/* ---------------------------- The admin readout --------------------------- */

test("the admin pair shows what each provider would actually charge", () => {
  assert.deepEqual(resolveProviderPricePair(packageEntry, "pbmhub"), {
    provider: "pbmhub",
    userPrice: 7,
    agentPrice: 6.5,
    overridden: true,
  })
})

test("an inheriting provider is shown as inheriting, with the real numbers", () => {
  assert.deepEqual(resolveProviderPricePair(packageEntry, "hubnet"), {
    provider: "hubnet",
    userPrice: 6,
    agentPrice: 5,
    overridden: false,
  })
})

test("the quoted price and the charged price come from one resolver", () => {
  // The shop quotes against the primary provider; the purchase charges against
  // the same one. Same function, same arguments — they cannot disagree.
  const quoted = resolveEffectivePackagePrice(packageEntry, { agentPricing: false, provider: "pbmhub" })
  const charged = resolveEffectivePackagePrice(packageEntry, { agentPricing: false, provider: "pbmhub" })
  assert.equal(quoted, charged)

  // And a failover to a costlier provider does not change what was quoted.
  const failoverCost = resolveEffectivePackagePrice(packageEntry, { agentPricing: false, provider: "hubnet" })
  assert.notEqual(failoverCost, quoted)
  assert.equal(quoted, 7, "the customer still pays the primary provider's price")
})
