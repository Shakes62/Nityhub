// Pure provider-routing rules: config in, ordered candidate list out.
//
// Free of Firebase imports so the decision of WHO may serve an order - and in
// what order - is unit testable without a database.
//
// One authority. Every dispatch path builds its candidates through
// buildProviderCandidates: the failure this prevents is a second flow growing
// its own copy of the list, drifting, and quietly serving orders through a
// provider the admin had routed away from.

import { SUPPORTED_PROVIDERS, DEFAULT_PROVIDER_ROUTING } from "../config.js"
import { normalizeProvider, normalizeNetwork } from "./provider-mapping.js"

/** Why a routed provider was passed over for this particular order. */
export const CANDIDATE_SKIP_REASON = {
  NOT_CONFIGURED: "not_configured",
  MAPPING_INCOMPLETE: "mapping_incomplete",
  UNKNOWN_PROVIDER: "unknown_provider",
}

/**
 * Read one network's route into an ordered, de-duplicated provider list.
 *
 * Accepts every shape this key has ever held so a config saved before failover
 * existed still routes: a bare string (the original single-provider form), an
 * array, or an object with a `providers` array. Unknown provider names are
 * dropped rather than guessed - a typo must not silently become the default
 * provider and start taking orders.
 */
export function normalizeProviderRouteList(value, { network = "", fallback = "" } = {}) {
  const safeNetwork = normalizeNetwork(network)
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.providers)
      ? value.providers
      : value == null || value === ""
        ? []
        : [value]

  const seen = new Set()
  const providers = []
  for (const entry of source) {
    const provider = normalizeProvider(entry, "")
    if (!provider || seen.has(provider)) {
      continue
    }
    seen.add(provider)
    providers.push(provider)
  }

  if (providers.length) {
    return providers
  }

  // Never leave a network with nothing routed: an empty list would take the
  // shop offline for that network on a single bad save.
  const preferred = normalizeProvider(fallback, "") || DEFAULT_PROVIDER_ROUTING[safeNetwork] || "hubnet"
  return [preferred]
}

/**
 * Filter a route list down to the providers that can actually serve one order.
 *
 * Both predicates are asked per provider, because the answers differ per
 * provider AND per package: a provider with no credentials cannot serve
 * anything, and a provider with no mapping for this particular bundle cannot
 * serve this one. Skips are returned rather than swallowed so a purchase that
 * ends up with nobody can say which provider fell out and why, instead of
 * surfacing as a generic failure.
 */
export function buildProviderCandidates(routeList = [], { isConfigured, hasCompleteMapping } = {}) {
  const candidates = []
  const skipped = []

  for (const [position, entry] of routeList.entries()) {
    const provider = normalizeProvider(entry, "")
    if (!provider) {
      skipped.push({ provider: String(entry || ""), reason: CANDIDATE_SKIP_REASON.UNKNOWN_PROVIDER })
      continue
    }

    if (typeof isConfigured === "function" && !isConfigured(provider)) {
      skipped.push({ provider, reason: CANDIDATE_SKIP_REASON.NOT_CONFIGURED })
      continue
    }

    if (typeof hasCompleteMapping === "function" && !hasCompleteMapping(provider)) {
      skipped.push({ provider, reason: CANDIDATE_SKIP_REASON.MAPPING_INCOMPLETE })
      continue
    }

    candidates.push({ provider, position })
  }

  return { candidates, skipped }
}

/**
 * Whether a later candidate could still take the order.
 *
 * Used to decide whether a failure is worth surfacing to the buyer or can be
 * absorbed silently by falling through to the next provider.
 */
export function hasCandidateAfter(candidates = [], index = 0) {
  return candidates.length > index + 1
}

/** Every provider the admin may put in a route, in a stable display order. */
export function listRoutableProviders() {
  return [...SUPPORTED_PROVIDERS]
}
