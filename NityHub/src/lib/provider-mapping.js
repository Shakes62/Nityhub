// Package → provider mapping rules.
//
// Free of Firebase imports so the rule that decides whether a package can be
// fulfilled by a provider - the thing that blocks a network from being routed
// at all, and that silently reported "complete" for a blank CK-Godsway
// networkKey - is unit testable in isolation.

import { CONFIG, SUPPORTED_PROVIDERS } from "../config.js"
import { formatPbmhubSizeFromVolume } from "./pbmhub.js"

export function normalizeNetwork(network) {
  return String(network || "").trim().toLowerCase()
}

export function normalizeProvider(value, fallback = "") {
  const provider = String(value || "").trim().toLowerCase()
  return SUPPORTED_PROVIDERS.includes(provider) ? provider : fallback
}

/**
 * CK-Godsway sizes bundles in GB, our catalog stores MB. 1000 → "1",
 * 1500 → "1.5". A non-positive volume yields "", which the completeness check
 * below then reports as a gap rather than shipping an empty capacity upstream.
 */
export function formatGodswayCapacityFromVolume(volume) {
  const amount = Number(volume || 0)
  if (!Number.isFinite(amount) || amount <= 0) {
    return ""
  }

  const inGb = amount / 1000
  if (Number.isInteger(inGb)) {
    return String(inGb)
  }

  return String(Math.round((inGb + Number.EPSILON) * 100) / 100).replace(/\.0+$/, "")
}

export function buildDefaultProviderMappings(network, volume) {
  const safeNetwork = normalizeNetwork(network)
  // Sourced from config so an operator can supply CK-Godsway's AirtelTigo key
  // once, instead of hand-editing providerMappings on every AT package.
  const defaultGodswayNetworkKey = String(CONFIG.godswayNetworkKeys?.[safeNetwork] || "")
    .trim()
    .toUpperCase()
  // PBM HUB publishes an id for all three of our networks, so unlike the
  // CK-Godsway key above this default is never blank for a supported network.
  const defaultPbmhubNetwork = String(CONFIG.pbmhubNetworkIds?.[safeNetwork] || "")
    .trim()
    .toLowerCase()

  return {
    hubnet: {
      network: safeNetwork,
      volume: volume > 0 ? String(volume) : "",
    },
    godsway: {
      networkKey: defaultGodswayNetworkKey,
      capacity: formatGodswayCapacityFromVolume(volume),
    },
    gigshub: {
      packageId: "",
    },
    pbmhub: {
      network: defaultPbmhubNetwork,
      size: formatPbmhubSizeFromVolume(volume),
    },
  }
}

export function normalizeProviderMappings(network, rawMappings = {}, volume = 0) {
  const defaults = buildDefaultProviderMappings(network, volume)
  const source =
    rawMappings && typeof rawMappings === "object" && !Array.isArray(rawMappings) ? rawMappings : {}

  return {
    hubnet: {
      network: normalizeNetwork(source?.hubnet?.network || defaults.hubnet.network),
      volume: String(source?.hubnet?.volume || defaults.hubnet.volume || "").trim(),
    },
    godsway: {
      networkKey: String(source?.godsway?.networkKey || defaults.godsway.networkKey || "")
        .trim()
        .toUpperCase(),
      capacity: String(source?.godsway?.capacity || defaults.godsway.capacity || "").trim(),
    },
    gigshub: {
      packageId: String(source?.gigshub?.packageId || defaults.gigshub.packageId || "").trim(),
    },
    pbmhub: {
      network: String(source?.pbmhub?.network || defaults.pbmhub.network || "")
        .trim()
        .toLowerCase(),
      // Case-preserving: PBM HUB matches `size` against its own catalog
      // strings ("1GB"), and lower-casing it here would stop it resolving.
      size: String(source?.pbmhub?.size || defaults.pbmhub.size || "").trim(),
    },
  }
}

/** The mapping fields each provider cannot submit an order without. */
export const PROVIDER_MAPPING_REQUIRED_FIELDS = {
  hubnet: ["network"],
  godsway: ["networkKey", "capacity"],
  gigshub: ["packageId"],
  pbmhub: ["network", "size"],
}

/**
 * Which required mapping fields a package leaves blank for one provider.
 *
 * Returned as a list rather than a bare boolean so the admin endpoints can name
 * the empty field. "Package X is missing godsway mapping" gave no clue which of
 * networkKey/capacity was blank - and for AirtelTigo it is always networkKey,
 * because CK-Godsway's AT code has no default to derive (CONFIG.godswayNetworkKeys).
 */
export function describeProviderMappingGaps(network, provider, catalogEntry) {
  const safeProvider = normalizeProvider(provider)
  const requiredFields = PROVIDER_MAPPING_REQUIRED_FIELDS[safeProvider]
  if (!requiredFields) {
    return { provider: safeProvider, missing: ["provider"] }
  }

  const providerMappings = normalizeProviderMappings(
    network,
    catalogEntry?.providerMappings,
    catalogEntry?.volume,
  )
  const mapping = providerMappings[safeProvider] || {}

  return {
    provider: safeProvider,
    missing: requiredFields.filter((field) => !String(mapping[field] || "").trim()),
  }
}

export function isCompleteProviderMapping(network, provider, catalogEntry) {
  return describeProviderMappingGaps(network, provider, catalogEntry).missing.length === 0
}

/** One-line, actionable reason a package cannot be fulfilled by a provider. */
export function describeProviderMappingGapMessage(network, provider, catalogEntry) {
  const { missing } = describeProviderMappingGaps(network, provider, catalogEntry)
  if (!missing.length) {
    return ""
  }

  const label = String(catalogEntry?.label || catalogEntry?.id || "package").trim()
  return `Package "${label}" has no ${missing.join(" and ")} set for ${provider}. Open Catalog → Packages → Mapping on that row and fill it in.`
}
