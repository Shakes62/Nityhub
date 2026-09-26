// Tests for the routing config → ordered candidate list.
//
// This decides who may serve an order. The two failures it guards against:
// a config saved before failover existed no longer routing at all, and a
// provider the admin routed away from still taking orders.

import test from "node:test"
import assert from "node:assert/strict"

import {
  CANDIDATE_SKIP_REASON,
  buildProviderCandidates,
  hasCandidateAfter,
  listRoutableProviders,
  normalizeProviderRouteList,
} from "../src/lib/provider-routing.js"

/* ------------------------------ Reading routes ---------------------------- */

test("the original single-provider config still routes", () => {
  // Every route stored before failover existed is a bare string.
  assert.deepEqual(normalizeProviderRouteList("godsway", { network: "telecel" }), ["godsway"])
})

test("an ordered list is preserved exactly", () => {
  assert.deepEqual(normalizeProviderRouteList(["pbmhub", "hubnet", "godsway"], { network: "mtn" }), [
    "pbmhub",
    "hubnet",
    "godsway",
  ])
})

test("an object with a providers array is accepted", () => {
  assert.deepEqual(normalizeProviderRouteList({ providers: ["hubnet", "pbmhub"] }, { network: "mtn" }), [
    "hubnet",
    "pbmhub",
  ])
})

test("duplicates collapse to their first position", () => {
  // A provider listed twice must not be attempted twice.
  assert.deepEqual(normalizeProviderRouteList(["hubnet", "pbmhub", "hubnet"], { network: "mtn" }), [
    "hubnet",
    "pbmhub",
  ])
})

test("an unknown provider name is dropped, never guessed into a real one", () => {
  // A typo silently becoming the default provider is how orders get served by
  // a supplier the admin never chose.
  assert.deepEqual(normalizeProviderRouteList(["nonsense", "pbmhub"], { network: "mtn" }), ["pbmhub"])
})

test("an empty or unusable route falls back so the network never goes dark", () => {
  assert.deepEqual(normalizeProviderRouteList([], { network: "telecel" }), ["godsway"])
  assert.deepEqual(normalizeProviderRouteList(null, { network: "mtn" }), ["hubnet"])
  assert.deepEqual(normalizeProviderRouteList(["nonsense"], { network: "mtn" }), ["hubnet"])
  assert.deepEqual(normalizeProviderRouteList("", { network: "at" }), ["hubnet"])
})

test("an explicit fallback wins over the built-in default", () => {
  assert.deepEqual(normalizeProviderRouteList([], { network: "mtn", fallback: "pbmhub" }), ["pbmhub"])
})

/* --------------------------- Building candidates -------------------------- */

const allConfigured = () => true
const allMapped = () => true

test("a fully usable route yields every provider in order", () => {
  const { candidates, skipped } = buildProviderCandidates(["hubnet", "pbmhub"], {
    isConfigured: allConfigured,
    hasCompleteMapping: allMapped,
  })

  assert.deepEqual(
    candidates.map((c) => c.provider),
    ["hubnet", "pbmhub"],
  )
  assert.deepEqual(
    candidates.map((c) => c.position),
    [0, 1],
  )
  assert.deepEqual(skipped, [])
})

test("an unconfigured provider is skipped with a reason, not silently dropped", () => {
  const { candidates, skipped } = buildProviderCandidates(["hubnet", "pbmhub"], {
    isConfigured: (p) => p !== "hubnet",
    hasCompleteMapping: allMapped,
  })

  assert.deepEqual(
    candidates.map((c) => c.provider),
    ["pbmhub"],
  )
  assert.deepEqual(skipped, [{ provider: "hubnet", reason: CANDIDATE_SKIP_REASON.NOT_CONFIGURED }])
})

test("a provider with no mapping for this package is skipped", () => {
  // AirtelTigo on CK-Godsway is the real case: configured, but no network key.
  const { candidates, skipped } = buildProviderCandidates(["godsway", "hubnet"], {
    isConfigured: allConfigured,
    hasCompleteMapping: (p) => p !== "godsway",
  })

  assert.deepEqual(
    candidates.map((c) => c.provider),
    ["hubnet"],
  )
  assert.deepEqual(skipped, [{ provider: "godsway", reason: CANDIDATE_SKIP_REASON.MAPPING_INCOMPLETE }])
})

test("a route where nobody can serve yields no candidates at all", () => {
  // Must be distinguishable from a provider outage: this is a config mistake.
  const { candidates, skipped } = buildProviderCandidates(["hubnet", "pbmhub"], {
    isConfigured: () => false,
    hasCompleteMapping: allMapped,
  })

  assert.equal(candidates.length, 0)
  assert.equal(skipped.length, 2)
})

test("configuration is checked before mapping, so the cheaper reason wins", () => {
  const { skipped } = buildProviderCandidates(["pbmhub"], {
    isConfigured: () => false,
    hasCompleteMapping: () => false,
  })

  assert.deepEqual(skipped, [{ provider: "pbmhub", reason: CANDIDATE_SKIP_REASON.NOT_CONFIGURED }])
})

test("positions reflect the original route, not the filtered list", () => {
  // The position is what tells an operator "the 3rd choice served this order".
  const { candidates } = buildProviderCandidates(["hubnet", "godsway", "pbmhub"], {
    isConfigured: (p) => p === "pbmhub",
    hasCompleteMapping: allMapped,
  })

  assert.deepEqual(candidates, [{ provider: "pbmhub", position: 2 }])
})

/* ------------------------------ Failover check ---------------------------- */

test("hasCandidateAfter reports whether anyone can still take the order", () => {
  const candidates = [{ provider: "hubnet" }, { provider: "pbmhub" }]

  assert.equal(hasCandidateAfter(candidates, 0), true)
  assert.equal(hasCandidateAfter(candidates, 1), false)
  assert.equal(hasCandidateAfter([], 0), false)
})

test("every supported provider is routable", () => {
  assert.deepEqual(listRoutableProviders(), ["hubnet", "godsway", "gigshub", "pbmhub"])
})
