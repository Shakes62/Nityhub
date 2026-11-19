import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizeStoreSlug, storePrice, calculateStoreProfit, isValidReceiptEmail, isClaimableStoreSlug,
  normalizeCustomDomain, customDomainKey, maskPhoneNumber, toWhatsAppNumber, normalizeStoreTagline,
} from "../src/lib/storefront-rules.js"

test("store slugs cannot escape or collide through case", () => {
  assert.equal(normalizeStoreSlug(" Daniel-Data "), "daniel-data")
  for (const value of ["../admin", "a.b", "-bad", "bad-", "a--b", "x"]) assert.equal(normalizeStoreSlug(value), "")
})

test("store pricing uses pesewas and refuses invalid margins", () => {
  assert.equal(storePrice(20, 5), 25)
  assert.equal(calculateStoreProfit(25, 20), 5)
  assert.equal(storePrice(20, -1), null)
  assert.equal(calculateStoreProfit(19, 20), 0)
  assert.equal(isValidReceiptEmail("buyer@example.com"), true)
  assert.equal(isValidReceiptEmail("broken@"), false)
})

test("platform subdomains cannot be claimed as stores", () => {
  for (const reserved of ["www", "api", "admin", "checkout", "support"]) {
    assert.equal(isClaimableStoreSlug(reserved), false)
  }
  assert.equal(isClaimableStoreSlug("daniels-data"), true)
  assert.equal(isClaimableStoreSlug("../x"), false)
})

test("custom domains are validated and encoded for storage", () => {
  assert.equal(normalizeCustomDomain(" Data.Example.com. "), "data.example.com")
  assert.equal(normalizeCustomDomain(""), "")
  for (const bad of ["https://x.com", "x.com/path", "localhost", "10.0.0.1", "nodot", "a..b.com", "-a.com"]) {
    assert.equal(normalizeCustomDomain(bad), null, bad)
  }
  assert.equal(customDomainKey("data.example.com"), "data,example,com")
})

test("guest receipts mask the recipient number", () => {
  assert.equal(maskPhoneNumber("0241234567"), "024•••4567")
  assert.equal(maskPhoneNumber(""), "")
  assert.equal(maskPhoneNumber("123"), "•••")
})

test("whatsapp numbers are converted to the international form", () => {
  assert.equal(toWhatsAppNumber("0241234567"), "233241234567")
  assert.equal(toWhatsAppNumber("+233 24 123 4567"), "233241234567")
  assert.equal(toWhatsAppNumber("12345"), "")
})

test("taglines are single-line and bounded", () => {
  assert.equal(normalizeStoreTagline("  Fast\n data   deals "), "Fast data deals")
  assert.equal(normalizeStoreTagline("x".repeat(200)).length, 120)
})
