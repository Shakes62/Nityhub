import { SUPPORTED_PACKAGE_NETWORKS } from "../config.js"
import { normalizeNetwork } from "./provider-mapping.js"
import { toMoneyUnits } from "./money.js"

/**
 * The admin switchboard, normalized so a missing or partial record always
 * reads as "everything open, no extra margin, costs optional". A fresh
 * deployment therefore keeps selling rather than going dark.
 */
export function normalizeVendingControls(raw = {}) {
  const networks = Object.fromEntries(SUPPORTED_PACKAGE_NETWORKS.map((network) => [
    network, raw?.networks?.[network] === "maintenance" ? "maintenance" : "active",
  ]))
  return {
    enabled: raw?.enabled !== false,
    networks,
    minimumMargin: Number.isFinite(Number(raw?.minimumMargin)) && Number(raw.minimumMargin) >= 0
      ? Math.round(Number(raw.minimumMargin) * 100) / 100 : 0,
    // Strict mode: refuse to sell a package on a provider whose wholesale cost
    // has not been recorded. Off by default so enabling cost tracking is opt-in
    // and cannot empty the shop the moment this ships.
    requireProviderCosts: raw?.requireProviderCosts === true,
    updatedAt: Number(raw?.updatedAt || 0),
    updatedBy: String(raw?.updatedBy || ""),
  }
}

export function isNetworkAvailable(controls, network) {
  return controls.enabled && controls.networks[normalizeNetwork(network)] === "active"
}

/**
 * Commercial guardrail: retail price >= provider wholesale cost + minimum margin.
 *
 * A recorded cost is always enforced. An unrecorded cost is only a refusal when
 * `requireCost` is set; otherwise there is nothing to compare against and the
 * sale proceeds (reported as `cost_unset` so admin screens can flag the gap).
 */
export function checkPriceFloor({ costs, packageId, provider, price, minimumMargin, requireCost = false }) {
  const cost = costs?.[packageId]?.[provider]
  if (cost == null || cost === "") {
    return requireCost
      ? { allowed: false, reason: "cost_missing" }
      : { allowed: true, reason: "cost_unset", cost: null }
  }
  const priceUnits = toMoneyUnits(price)
  const costUnits = toMoneyUnits(cost)
  const marginUnits = toMoneyUnits(minimumMargin)
  if (!Number.isSafeInteger(priceUnits) || priceUnits <= 0) {
    return { allowed: false, reason: "invalid_price", cost: Number(cost) }
  }
  return priceUnits >= costUnits + marginUnits
    ? { allowed: true, cost: Number(cost) }
    : { allowed: false, reason: "below_floor", cost: Number(cost) }
}
