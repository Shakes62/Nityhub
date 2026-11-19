import test from "node:test"
import assert from "node:assert/strict"

import {
  normalizeBanner,
  sortBanners,
  getDefaultBanners,
  BANNER_VARIANTS,
  normalizeBannerActionUrl,
  isValidBannerId,
  isBannerLive,
} from "../src/lib/banner-rules.js"

test("normalizeBanner validates and cleans banner data", () => {
  const input = {
    variant: "promotion",
    title: "  Promo Title  ",
    message: "  Special discount message  ",
    actionLabel: "  Click Here  ",
    actionUrl: "  /buy  ",
    enabled: true,
    priority: 5,
  }

  const normalized = normalizeBanner(input, "custom-id")
  assert.equal(normalized.id, "custom-id")
  assert.equal(normalized.variant, "promotion")
  assert.equal(normalized.title, "Promo Title")
  assert.equal(normalized.message, "Special discount message")
  assert.equal(normalized.actionLabel, "Click Here")
  assert.equal(normalized.actionUrl, "/buy")
  assert.equal(normalized.enabled, true)
  assert.equal(normalized.priority, 5)
  assert.ok(normalized.updatedAt > 0)
})

test("normalizeBanner falls back to announcement on unknown variant", () => {
  const normalized = normalizeBanner({
    variant: "unknown-variant",
    title: "Notice",
    message: "Test message",
  })
  assert.equal(normalized.variant, "announcement")
})

test("normalizeBanner rejects missing title or message", () => {
  assert.throws(() => normalizeBanner({ title: "", message: "msg" }), /title is required/)
  assert.throws(() => normalizeBanner({ title: "Title", message: "" }), /message is required/)
  assert.throws(() => normalizeBanner(null), /Invalid banner payload/)
})

test("sortBanners sorts by priority descending and respects activeOnly filter", () => {
  const banners = [
    { id: "1", priority: 1, enabled: true, updatedAt: 100 },
    { id: "2", priority: 10, enabled: true, updatedAt: 200 },
    { id: "3", priority: 5, enabled: false, updatedAt: 300 },
  ]

  const activeSorted = sortBanners(banners, true)
  assert.equal(activeSorted.length, 2)
  assert.equal(activeSorted[0].id, "2") // highest priority
  assert.equal(activeSorted[1].id, "1")

  const allSorted = sortBanners(banners, false)
  assert.equal(allSorted.length, 3)
  assert.equal(allSorted[0].id, "2")
  assert.equal(allSorted[1].id, "3")
  assert.equal(allSorted[2].id, "1")
})

test("default banners describe real features only", () => {
  const defaults = getDefaultBanners()
  assert.ok(defaults.length >= 1)
  for (const banner of defaults) {
    assert.ok(BANNER_VARIANTS.includes(banner.variant))
    assert.ok(banner.actionUrl.startsWith("/"))
    // No invented prices or uptime claims.
    assert.doesNotMatch(banner.message, /GHS|d+%|optimal|sub-minute/i)
  }
})

test("banner links accept in-app paths and https only", () => {
  assert.equal(normalizeBannerActionUrl("/buy"), "/buy")
  assert.equal(normalizeBannerActionUrl("https://example.com/promo"), "https://example.com/promo")
  assert.equal(normalizeBannerActionUrl(""), null)
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "http://plain.example", "buy"]) {
    assert.throws(() => normalizeBannerActionUrl(bad), /in-app path/)
  }
})

test("a banner link needs button text", () => {
  assert.throws(() => normalizeBanner({ title: "T", message: "M", actionUrl: "/buy" }), /button text/)
  const noLink = normalizeBanner({ title: "T", message: "M", actionLabel: "Orphan" })
  assert.equal(noLink.actionLabel, null)
})

test("banner ids cannot address other database paths", () => {
  assert.throws(() => normalizeBanner({ title: "T", message: "M" }, "settings/vending"), /Invalid banner id/)
  assert.equal(isValidBannerId("banner-1_a"), true)
  assert.equal(isValidBannerId("a/b"), false)
})

test("edits keep the stored createdAt", () => {
  const banner = normalizeBanner({ title: "T", message: "M", createdAt: 1 }, "b1", { createdAt: 12345 })
  assert.equal(banner.createdAt, 12345)
})

test("scheduled banners are live only inside their window", () => {
  const now = Date.now()
  const base = { enabled: true, priority: 0 }
  assert.equal(isBannerLive({ ...base, startsAt: now + 1000 }, now), false)
  assert.equal(isBannerLive({ ...base, endsAt: now - 1 }, now), false)
  assert.equal(isBannerLive({ ...base, startsAt: now - 1000, endsAt: now + 1000 }, now), true)
  assert.equal(sortBanners([{ ...base, id: "x", endsAt: now - 1 }], true, now).length, 0)
  assert.throws(() => normalizeBanner({ title: "T", message: "M", startsAt: now, endsAt: now - 5 }), /after its start/)
})
