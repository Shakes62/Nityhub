import { db } from "../firebase.js"
import { SUPPORTED_PACKAGE_NETWORKS, SUPPORTED_PROVIDERS } from "../config.js"
import { normalizeNetwork, normalizeProvider } from "./provider-mapping.js"
import { normalizeVendingControls, isNetworkAvailable, checkPriceFloor } from "./vending-rules.js"
export { normalizeVendingControls, isNetworkAvailable, checkPriceFloor } from "./vending-rules.js"
import { registerCacheReset } from "./runtime-cache.js"

const CONTROL_PATH = "settings/vending"
const COST_PATH = "provider_costs"
const HEALTH_PATH = "settings/provider_dispatch_health"
const WINDOW_MS = 10 * 60 * 1000
const COOLDOWN_MS = 10 * 60 * 1000

// Every purchase, catalog read and storefront quote consults the switchboard,
// so it is cached in memory briefly. An admin save on this instance refreshes
// it at once; other instances converge within the TTL.
const CONTROL_CACHE_MS = 15_000
const COST_CACHE_MS = 15_000
let controlCache = { at: 0, value: null }
const costCache = new Map()
registerCacheReset(() => { controlCache = { at: 0, value: null }; costCache.clear() })

export async function getVendingControls({ fresh = false } = {}) {
  const now = Date.now()
  if (!fresh && controlCache.value && now - controlCache.at < CONTROL_CACHE_MS) return controlCache.value
  const snapshot = await db.ref(CONTROL_PATH).once("value")
  const value = normalizeVendingControls(snapshot.val())
  controlCache = { at: now, value }
  return value
}

export async function saveVendingControls(input, uid) {
  if (!Number.isFinite(Number(input?.minimumMargin)) || Number(input.minimumMargin) < 0) {
    throw new Error("Minimum margin must be zero or greater")
  }
  if (Number(input.minimumMargin) > 1000) {
    throw new Error("Minimum margin is unrealistically high")
  }
  for (const network of SUPPORTED_PACKAGE_NETWORKS) {
    if (input?.networks?.[network] !== "active" && input?.networks?.[network] !== "maintenance") {
      throw new Error(`Invalid ${network} availability`)
    }
  }
  const normalized = normalizeVendingControls(input)
  const value = { ...normalized, updatedAt: Date.now(), updatedBy: uid }
  await db.ref(CONTROL_PATH).set(value)
  controlCache = { at: Date.now(), value }
  return value
}

export async function getProviderCosts(network, { fresh = false } = {}) {
  const key = normalizeNetwork(network)
  const cached = costCache.get(key)
  if (!fresh && cached && Date.now() - cached.at < COST_CACHE_MS) return cached.value
  const snapshot = await db.ref(`${COST_PATH}/${key}`).once("value")
  const value = snapshot.val() || {}
  costCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * Every sell-side check in one call: is the network open, and does this price
 * clear the provider's floor under the current strictness setting.
 */
export async function evaluateSaleGuard({ network, packageId, provider, price }) {
  const controls = await getVendingControls()
  if (!isNetworkAvailable(controls, network)) return { allowed: false, reason: "network_paused", controls }
  const floor = checkPriceFloor({
    costs: await getProviderCosts(network), packageId, provider, price,
    minimumMargin: controls.minimumMargin, requireCost: controls.requireProviderCosts,
  })
  return { ...floor, controls }
}

export async function saveProviderCosts(network, costs, uid) {
  const safeNetwork = normalizeNetwork(network)
  if (!SUPPORTED_PACKAGE_NETWORKS.includes(safeNetwork)) throw new Error("Unsupported network")
  const normalized = {}
  for (const [packageId, providers] of Object.entries(costs || {})) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(packageId) || !providers || typeof providers !== "object") {
      throw new Error("Invalid package cost entry")
    }
    const entry = {}
    for (const [provider, cost] of Object.entries(providers)) {
      if (cost === null || cost === "") continue
      if (!normalizeProvider(provider, "") || !Number.isFinite(Number(cost)) || Number(cost) <= 0 || Number(cost) > 10000) {
        throw new Error("Invalid provider cost")
      }
      entry[normalizeProvider(provider, "")] = Math.round(Number(cost) * 100) / 100
    }
    if (Object.keys(entry).length) normalized[packageId] = entry
  }
  await db.ref(`${COST_PATH}/${safeNetwork}`).set(normalized)
  await db.ref(`${COST_PATH}_audit/${safeNetwork}`).set({ updatedAt: Date.now(), updatedBy: uid })
  costCache.set(safeNetwork, { at: Date.now(), value: normalized })
  return normalized
}

function compactHealth(raw, now) {
  return {
    attempts: (Array.isArray(raw?.attempts) ? raw.attempts : Object.values(raw?.attempts || {}))
      .filter((a) => Number(a?.at) > now - WINDOW_MS).slice(-20),
    cooldownUntil: Number(raw?.cooldownUntil || 0),
    probeToken: String(raw?.probeToken || ""),
    probeAt: Number(raw?.probeAt || 0),
  }
}

/**
 * Admit one dispatch through the provider's health gate.
 *
 * Closed: everything passes. Cooling down: nothing passes. Cooldown expired:
 * exactly one canary is admitted (the probe) and everyone else waits until it
 * reports back or its 60s probe window lapses.
 */
export async function claimProviderDispatch(provider, token, now = Date.now()) {
  const ref = db.ref(`${HEALTH_PATH}/${provider}`)
  const result = await ref.transaction((raw) => {
    const state = compactHealth(raw, now)
    if (state.cooldownUntil > now || (state.probeToken && now - state.probeAt < 60_000)) return
    if (state.cooldownUntil && state.cooldownUntil <= now) {
      state.probeToken = token
      state.probeAt = now
    }
    return state
  })
  return result.committed === true
}

export async function recordProviderDispatch(provider, token, outcome, now = Date.now()) {
  const ref = db.ref(`${HEALTH_PATH}/${provider}`)
  await ref.transaction((raw) => {
    const state = compactHealth(raw, now)
    state.attempts.push({ at: now, outcome })
    state.attempts = state.attempts.slice(-20)
    const failures = state.attempts.filter((a) => a.outcome !== "success").length
    if (outcome === "hard_fail") {
      state.probeToken = ""
      state.probeAt = 0
      state.cooldownUntil = now + COOLDOWN_MS
    } else if (state.probeToken === token) {
      state.probeToken = ""
      state.probeAt = 0
      state.cooldownUntil = outcome === "success" ? 0 : now + COOLDOWN_MS
      if (outcome === "success") state.attempts = [{ at: now, outcome }]
    } else if (state.attempts.length >= 5 && failures > state.attempts.length / 2) {
      state.cooldownUntil = now + COOLDOWN_MS
    }
    return state
  })
}

/** Lets an admin end a cooldown early, e.g. after topping up a provider. */
export async function resetProviderDispatchHealth(provider) {
  const safe = normalizeProvider(provider, "")
  if (!safe) throw new Error("Unknown provider")
  await db.ref(`${HEALTH_PATH}/${safe}`).set({ attempts: [], cooldownUntil: 0, probeToken: "", probeAt: 0 })
}

export async function getDispatchHealth() {
  const snapshot = await db.ref(HEALTH_PATH).once("value")
  const now = Date.now()
  return Object.fromEntries(SUPPORTED_PROVIDERS.map((provider) => {
    const state = compactHealth(snapshot.val()?.[provider], now)
    const successes = state.attempts.filter((a) => a.outcome === "success").length
    return [provider, {
      state: state.cooldownUntil > now ? "cooldown" : state.probeToken ? "probing" : "available",
      cooldownUntil: state.cooldownUntil,
      attempts: state.attempts.length,
      healthRate: state.attempts.length ? successes / state.attempts.length : null,
    }]
  }))
}
