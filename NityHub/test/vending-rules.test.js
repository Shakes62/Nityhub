import test from "node:test"
import assert from "node:assert/strict"
import { normalizeVendingControls, isNetworkAvailable, checkPriceFloor } from "../src/lib/vending-rules.js"
import { normalizeProvider } from "../src/lib/provider-mapping.js"

test("master and network switches deny purchases", () => {
  const controls = normalizeVendingControls({ enabled: false, networks: { mtn: "active" } })
  assert.equal(isNetworkAvailable(controls, "mtn"), false)
  const networkPaused = normalizeVendingControls({ networks: { mtn: "maintenance" } })
  assert.equal(isNetworkAvailable(networkPaused, "mtn"), false)
  assert.equal(isNetworkAvailable(networkPaused, "at"), true)
})

test("recorded costs compare exact pesewas at the margin boundary", () => {
  const input = { costs: { bundle: { hubnet: 5.25 } }, packageId: "bundle", provider: "hubnet", minimumMargin: 0.5 }
  assert.deepEqual(checkPriceFloor({ ...input, price: 5.75 }), { allowed: true, cost: 5.25 })
  assert.deepEqual(checkPriceFloor({ ...input, price: 5.74 }), { allowed: false, reason: "below_floor", cost: 5.25 })
  // A recorded cost is enforced even when strict mode is off.
  assert.equal(checkPriceFloor({ ...input, price: 1, requireCost: false }).allowed, false)
})

test("missing costs fail closed only in strict mode", () => {
  const input = { costs: { bundle: { hubnet: 5.25 } }, packageId: "bundle", minimumMargin: 0 }
  assert.deepEqual(checkPriceFloor({ ...input, provider: "godsway", price: 100, requireCost: true }), { allowed: false, reason: "cost_missing" })
  assert.deepEqual(checkPriceFloor({ ...input, provider: "godsway", price: 100 }), { allowed: true, reason: "cost_unset", cost: null })
  assert.deepEqual(checkPriceFloor({ costs: {}, packageId: "x", provider: "hubnet", price: 5, minimumMargin: 0 }).allowed, true)
})

test("a zero or invalid price never passes a recorded floor", () => {
  const input = { costs: { bundle: { hubnet: 0.01 } }, packageId: "bundle", provider: "hubnet", minimumMargin: 0 }
  assert.equal(checkPriceFloor({ ...input, price: 0 }).allowed, false)
  assert.equal(checkPriceFloor({ ...input, price: "abc" }).allowed, false)
})

test("strict cost mode is opt-in", () => {
  assert.equal(normalizeVendingControls({}).requireProviderCosts, false)
  assert.equal(normalizeVendingControls({ requireProviderCosts: true }).requireProviderCosts, true)
  assert.equal(normalizeVendingControls({ requireProviderCosts: "yes" }).requireProviderCosts, false)
})

test("an empty switchboard record keeps every network open", () => {
  const controls = normalizeVendingControls(null)
  assert.equal(controls.enabled, true)
  assert.equal(isNetworkAvailable(controls, "mtn"), true)
  assert.equal(isNetworkAvailable(controls, "telecel"), true)
  assert.equal(isNetworkAvailable(controls, "at"), true)
})

test("provider aliases decode strictly to internal keys", () => {
  assert.equal(normalizeProvider("Provider A"), "hubnet")
  assert.equal(normalizeProvider("provider_d"), "pbmhub")
  assert.equal(normalizeProvider("unknown"), "")
})
