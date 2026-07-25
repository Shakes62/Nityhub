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
 * The regular (non-agent) price for a catalog entry.
 *
 * Falls back through the legacy `price` field that older catalog rows used.
 */
export function resolveUserPrice(catalogEntry = {}) {
  const candidates = [catalogEntry?.userPrice, catalogEntry?.price]
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
export function resolveAgentPrice(catalogEntry = {}) {
  const userPrice = resolveUserPrice(catalogEntry)
  const agentPrice = toMoneyNumber(catalogEntry?.agentPrice, 0)
  return agentPrice > 0 ? agentPrice : userPrice
}

/**
 * The price that applies to one buyer.
 *
 * `agentPricing` must be a real boolean decided from a server-side role
 * lookup. Anything other than an explicit `true` charges the regular price, so
 * a missing or malformed role can only ever over-charge relative to wholesale -
 * never hand out an unearned discount.
 */
export function resolveEffectivePackagePrice(catalogEntry = {}, { agentPricing = false } = {}) {
  return agentPricing === true ? resolveAgentPrice(catalogEntry) : resolveUserPrice(catalogEntry)
}
