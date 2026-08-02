import test from "node:test"
import assert from "node:assert/strict"

import {
  buildDefaultProviderMappings,
  describeProviderMappingGapMessage,
  describeProviderMappingGaps,
  formatGodswayCapacityFromVolume,
  isCompleteProviderMapping,
  normalizeProviderMappings,
} from "../src/lib/provider-mapping.js"

/* ------------------------- CK-Godsway capacity ---------------------------- */

test("a whole-GB volume becomes a bare GB number", () => {
  assert.equal(formatGodswayCapacityFromVolume(1000), "1")
  assert.equal(formatGodswayCapacityFromVolume(50000), "50")
})

test("a part-GB volume keeps two decimals", () => {
  assert.equal(formatGodswayCapacityFromVolume(1500), "1.5")
  assert.equal(formatGodswayCapacityFromVolume(500), "0.5")
})

test("a non-positive volume yields no capacity rather than a zero bundle", () => {
  assert.equal(formatGodswayCapacityFromVolume(0), "")
  assert.equal(formatGodswayCapacityFromVolume(-1000), "")
  assert.equal(formatGodswayCapacityFromVolume("not a number"), "")
})

/* ------------------------------- Defaults --------------------------------- */

test("MTN and Telecel derive a CK-Godsway network key without configuration", () => {
  assert.equal(buildDefaultProviderMappings("mtn", 1000).godsway.networkKey, "YELLO")
  assert.equal(buildDefaultProviderMappings("telecel", 1000).godsway.networkKey, "TELECEL")
})

test("AirtelTigo has no derivable CK-Godsway network key", () => {
  // CK's AT code is not documented anywhere we can read, so it is left blank
  // rather than guessed: a wrong key passes config-time validation and only
  // fails after a customer's wallet has been debited.
  assert.equal(buildDefaultProviderMappings("at", 1000).godsway.networkKey, "")
})

test("an explicit mapping overrides the derived default", () => {
  const mappings = normalizeProviderMappings(
    "at",
    { godsway: { networkKey: "at_premium" } },
    2000,
  )
  assert.equal(mappings.godsway.networkKey, "AT_PREMIUM")
  assert.equal(mappings.godsway.capacity, "2")
})

/* ----------------------------- Completeness ------------------------------- */

const telecelPackage = { id: "telecel-1gb", label: "1GB", volume: 1000 }

test("Telecel is complete for CK-Godsway with no explicit mapping", () => {
  assert.equal(isCompleteProviderMapping("telecel", "godsway", telecelPackage), true)
  assert.deepEqual(describeProviderMappingGaps("telecel", "godsway", telecelPackage).missing, [])
})

test("AirtelTigo reports networkKey as the one blocking field for CK-Godsway", () => {
  const gaps = describeProviderMappingGaps("at", "godsway", { id: "at-1gb", label: "1GB", volume: 1000 })
  assert.deepEqual(gaps.missing, ["networkKey"])
  assert.equal(gaps.provider, "godsway")
})

test("a blank networkKey is a gap even when the mapping object exists", () => {
  // The admin editor used to render this as "Mapped" because the godsway key
  // was present; the save path rejected it with no indication of which row.
  const entry = { id: "at-1gb", label: "1GB", volume: 1000, providerMappings: { godsway: { networkKey: "  " } } }
  assert.equal(isCompleteProviderMapping("at", "godsway", entry), false)
  assert.deepEqual(describeProviderMappingGaps("at", "godsway", entry).missing, ["networkKey"])
})

test("a zero-volume package is missing capacity too", () => {
  const gaps = describeProviderMappingGaps("at", "godsway", { id: "broken", label: "Broken", volume: 0 })
  assert.deepEqual(gaps.missing, ["networkKey", "capacity"])
})

test("hubnet only needs a network, gigshub only a packageId", () => {
  assert.equal(isCompleteProviderMapping("mtn", "hubnet", { volume: 1000 }), true)
  assert.equal(isCompleteProviderMapping("mtn", "gigshub", { volume: 1000 }), false)
  assert.equal(
    isCompleteProviderMapping("mtn", "gigshub", { volume: 1000, providerMappings: { gigshub: { packageId: "42" } } }),
    true,
  )
})

test("an unknown provider is never complete", () => {
  assert.equal(isCompleteProviderMapping("mtn", "nosuchprovider", { volume: 1000 }), false)
})

/* ------------------------------- Messaging -------------------------------- */

test("the gap message names the package and the blank field", () => {
  const message = describeProviderMappingGapMessage("at", "godsway", {
    id: "at-5gb",
    label: "5GB",
    volume: 5000,
  })
  assert.match(message, /"5GB"/)
  assert.match(message, /networkKey/)
  assert.match(message, /godsway/)
})

test("both blank fields are named together", () => {
  const message = describeProviderMappingGapMessage("at", "godsway", { label: "Broken", volume: 0 })
  assert.match(message, /networkKey and capacity/)
})

test("a complete mapping has nothing to report", () => {
  assert.equal(describeProviderMappingGapMessage("telecel", "godsway", telecelPackage), "")
})
