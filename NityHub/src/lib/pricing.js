// Pure package-pricing rules.
//
// Free of Firebase imports so the decision that determines what a customer is
// actually charged is unit testable in isolation.
//
// There is exactly ONE implementation of "which price applies", and it lives
// here. The bug this module exists to prevent: the price used to be resolved
// twice - once in the browser and once on the server - from subtly different
// expressions (`agentPrice || userPrice` vs `agentPrice ?? userPrice`). Those
// two disagree whenever agentPrice is 0, so the screen showed one number and
// the wallet was debited another. Clients now render whatever `price` the
// server resolved and make no pricing decision of their own.

import { toMoneyNumber } from "./money.js"

/**
 * The per-provider price overrides for a catalog entry, if any.
 *
 * Shape: `{ hubnet: { userPrice, agentPrice }, pbmhub: { ... } }`. A provider
 * with no entry, or with a non-positive price, falls back to the package's own
 * price - so adding a provider never silently zero-prices a bundle.
 */
function readProviderPricing(catalogEntry = {}, provider = "") {
  const key = String(provider || "").trim().toLowerCase()
  if (!key) {
    return null
  }

  const pricing = catalogEntry?.providerPricing
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) {
    return null
  }

  const entry = pricing[key]
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null
}

/**
 * The regular (non-agent) price for a catalog entry.
 *
 * When a provider is named, that provider's own price wins. Falls back through
 * the package price and then the legacy `price` field that older catalog rows
 * used, so a package priced before per-provider rates existed still sells.
 */
export function resolveUserPrice(catalogEntry = {}, { provider = "" } = {}) {
  const providerPricing = readProviderPricing(catalogEntry, provider)
  const candidates = [providerPricing?.userPrice, catalogEntry?.userPrice, catalogEntry?.price]
  for (const candidate of candidates) {
    const parsed = toMoneyNumber(candidate, 0)
    if (parsed > 0) {
      return parsed
    }
  }

  return 0
}

/**
 * The agent (wholesale) price for a catalog entry.
 *
 * A missing, blank, zero or negative agent price means "no separate wholesale
 * rate configured" and falls back to the regular price. It must never resolve
 * to 0: the admin catalog editor sends `Number("") || 0` for an untouched
 * field, and treating that literally handed agents free data.
 */
export function resolveAgentPrice(catalogEntry = {}, { provider = "" } = {}) {
  const userPrice = resolveUserPrice(catalogEntry, { provider })
  const providerPricing = readProviderPricing(catalogEntry, provider)
  // The provider's own wholesale rate first, then the package's. A blank
  // provider rate means "no separate rate for this provider", not "free".
  for (const candidate of [providerPricing?.agentPrice, catalogEntry?.agentPrice]) {
    const parsed = toMoneyNumber(candidate, 0)
    if (parsed > 0) {
      return parsed
    }
  }

  return userPrice
}

/**
 * The price that applies to one buyer.
 *
 * `agentPricing` must be a real boolean decided from a server-side role
 * lookup. Anything other than an explicit `true` charges the regular price, so
 * a missing or malformed role can only ever over-charge relative to wholesale -
 * never hand out an unearned discount.
 */
export function resolveEffectivePackagePrice(catalogEntry = {}, { agentPricing = false, provider = "" } = {}) {
  return agentPricing === true
    ? resolveAgentPrice(catalogEntry, { provider })
    : resolveUserPrice(catalogEntry, { provider })
}

/**
 * Both tiers for one provider, for the admin editor.
 *
 * Returns what that provider would actually charge, resolved through the same
 * fallbacks the till uses - so the number an admin sees is the number a customer
 * would be charged, rather than a raw (possibly blank) override.
 */
export function resolveProviderPricePair(catalogEntry = {}, provider = "") {
  return {
    provider: String(provider || "").trim().toLowerCase(),
    userPrice: resolveUserPrice(catalogEntry, { provider }),
    agentPrice: resolveAgentPrice(catalogEntry, { provider }),
    /** False when this provider simply inherits the package price. */
    overridden: Boolean(readProviderPricing(catalogEntry, provider)),
  }
}
