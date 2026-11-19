import test from "node:test"
import assert from "node:assert/strict"

import {
  formatDurationText,
  formatRelativeAgo,
  sanitizeDeliveryProof,
  filterAndFormatDeliveries,
  MAX_DELIVERY_SLA_SECONDS,
  FRESHNESS_WINDOW_MS,
  buildDeliveryFeedEntry,
  computeDeliveryEstimates,
  formatVolumeLabel,
  median,
  BASELINE_ESTIMATE,
} from "../src/lib/social-proof-rules.js"

test("formatDurationText converts seconds to clean readable shorthand", () => {
  assert.equal(formatDurationText(34), "34s")
  assert.equal(formatDurationText(60), "1m")
  assert.equal(formatDurationText(72), "1m 12s")
  assert.equal(formatDurationText(120), "2m")
  assert.equal(formatDurationText(0), "1s")
})

test("formatRelativeAgo converts ms difference to human friendly relative time", () => {
  assert.equal(formatRelativeAgo(15 * 1000), "just now")
  assert.equal(formatRelativeAgo(65 * 1000), "1 min ago")
  assert.equal(formatRelativeAgo(5 * 60 * 1000), "5 mins ago")
  assert.equal(formatRelativeAgo(2 * 3600 * 1000), "2 hours ago")
})

test("sanitizeDeliveryProof strips private recipient phone, userId, and email", () => {
  const now = Date.now()
  const rawOrder = {
    reference: "ORD_987654321",
    status: "delivered",
    createdAt: now - 35000,
    deliveredAt: now - 1000,
    network: "mtn",
    label: "5GB UP2U",
    phone: "0241234567", // MUST BE STRIPPED
    userId: "usr_secret_uid", // MUST BE STRIPPED
    email: "customer@example.com", // MUST BE STRIPPED
    amount: 25,
  }

  const proof = sanitizeDeliveryProof(rawOrder, now)
  assert.notEqual(proof, null)

  // Verify privacy: sensitive fields must not exist
  assert.equal(proof.phone, undefined)
  assert.equal(proof.userId, undefined)
  assert.equal(proof.email, undefined)
  assert.equal(proof.amount, undefined)

  // Verify public anonymous fields
  assert.equal(proof.network, "mtn")
  assert.equal(proof.networkLabel, "MTN")
  assert.equal(proof.packageLabel, "5GB UP2U")
  assert.equal(proof.durationSeconds, 34)
  assert.equal(proof.durationText, "34s")
  assert.equal(proof.completedAgoText, "just now")
})

test("sanitizeDeliveryProof rejects orders outside the 12-hour freshness window", () => {
  const now = Date.now()
  const staleOrder = {
    reference: "ORD_OLD_123",
    status: "delivered",
    createdAt: now - (FRESHNESS_WINDOW_MS + 60000) - 30000,
    deliveredAt: now - (FRESHNESS_WINDOW_MS + 60000), // 12 hours + 1 min ago
    network: "telecel",
  }

  assert.equal(sanitizeDeliveryProof(staleOrder, now), null)
})

test("sanitizeDeliveryProof rejects SLA outlier deliveries (> 15 minutes)", () => {
  const now = Date.now()
  const outlierOrder = {
    reference: "ORD_OUTLIER_999",
    status: "delivered",
    createdAt: now - 20 * 60 * 1000, // 20 minutes ago
    deliveredAt: now - 1 * 60 * 1000, // took 19 minutes (exceeds 15 min SLA)
    network: "at",
  }

  assert.equal(sanitizeDeliveryProof(outlierOrder, now), null)
})

test("sanitizeDeliveryProof rejects non-delivered orders", () => {
  const now = Date.now()
  assert.equal(sanitizeDeliveryProof({ status: "pending", deliveredAt: now }, now), null)
  assert.equal(sanitizeDeliveryProof({ status: "failed", deliveredAt: now }, now), null)
  assert.equal(sanitizeDeliveryProof({ status: "processing", deliveredAt: now }, now), null)
  assert.equal(sanitizeDeliveryProof(null, now), null)
})

test("filterAndFormatDeliveries never invents deliveries when volume is low", () => {
  const now = Date.now()
  assert.deepEqual(filterAndFormatDeliveries([], 5, now), [])
  const one = filterAndFormatDeliveries([{ status: "delivered", network: "mtn", createdAt: now - 40_000, deliveredAt: now - 5_000 }], 5, now)
  assert.equal(one.length, 1)
  assert.equal(one[0].durationSeconds, 35)
})

test("a proof without a real start time is dropped rather than given a made-up duration", () => {
  const now = Date.now()
  assert.equal(sanitizeDeliveryProof({ status: "delivered", network: "mtn", deliveredAt: now - 1000 }, now), null)
})

test("delivery feed entries are a strict whitelist", () => {
  const now = Date.now()
  const entry = buildDeliveryFeedEntry({ network: "telecel", label: "10GB", phone: "0201234567", userId: "u1",
    email: "a@b.co", amount: 45, reference: "REF", createdAt: now - 60_000, deliveredAt: now }, now)
  assert.deepEqual(Object.keys(entry).sort(), ["deliveredAt", "durationSeconds", "network", "packageLabel", "startedAt"])
  assert.equal(entry.durationSeconds, 60)
  assert.equal(buildDeliveryFeedEntry({ network: "unknown", createdAt: 1, deliveredAt: 2 }), null)
  assert.equal(buildDeliveryFeedEntry({ network: "mtn", createdAt: 5000, deliveredAt: 1000 }), null)
})

test("feed entries round-trip into public proofs", () => {
  const now = Date.now()
  const entry = buildDeliveryFeedEntry({ network: "at", volume: 1500, createdAt: now - 42_000, deliveredAt: now - 2_000 })
  const [proof] = filterAndFormatDeliveries([entry], 5, now)
  assert.equal(proof.networkLabel, "AirtelTigo")
  assert.equal(proof.packageLabel, "1.5GB")
  assert.equal(proof.durationText, "40s")
})

test("volume labels use 1000 MB per GB", () => {
  assert.equal(formatVolumeLabel(5000), "5GB")
  assert.equal(formatVolumeLabel(1500), "1.5GB")
  assert.equal(formatVolumeLabel(500), "500MB")
  assert.equal(formatVolumeLabel(0), "")
})

test("estimates never say unavailable and need enough samples", () => {
  const now = Date.now()
  const estimates = computeDeliveryEstimates([], now)
  for (const value of Object.values(estimates)) {
    assert.equal(value.label, BASELINE_ESTIMATE.label)
    assert.doesNotMatch(value.label, /unavailable/i)
  }
  const two = computeDeliveryEstimates([{ network: "mtn", deliveredAt: now, durationSeconds: 30 }, { network: "mtn", deliveredAt: now, durationSeconds: 40 }], now)
  assert.equal(two.mtn.measured, false)
})

test("estimates bucket the median into fast and standard ranges", () => {
  const now = Date.now()
  const feed = (network, seconds) => seconds.map((durationSeconds) => ({ network, deliveredAt: now - 1000, durationSeconds }))
  const result = computeDeliveryEstimates([...feed("mtn", [90, 120, 200]), ...feed("telecel", [400, 600, 700]), ...feed("at", [20, 30, 50])], now)
  assert.deepEqual([result.mtn.label, result.mtn.tone], ["~1–5 min", "fast"])
  assert.deepEqual([result.telecel.label, result.telecel.tone], ["~5–15 min", "standard"])
  assert.equal(result.at.label, "Under 1 min")
  // Slow deliveries count toward the estimate even though the ticker hides them.
  const slow = computeDeliveryEstimates(feed("mtn", [1500, 1600, 1700]), now)
  assert.equal(slow.mtn.label, "~15–30 min")
})

test("stale feed entries do not shape estimates", () => {
  const now = Date.now()
  const stale = [1, 2, 3].map(() => ({ network: "mtn", deliveredAt: now - FRESHNESS_WINDOW_MS - 1000, durationSeconds: 30 }))
  assert.equal(computeDeliveryEstimates(stale, now).mtn.measured, false)
})

test("median handles odd and even sample counts", () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), null)
})
