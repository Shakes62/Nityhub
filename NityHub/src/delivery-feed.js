// Anonymous public delivery feed.
//
// When any order first becomes delivered, a whitelisted record (network,
// package label, timing - never phone, uid, email or amount) is appended to
// `delivery_feed`. The proof ticker and delivery estimates read only this
// small, pruned node instead of scanning every user's orders.

import crypto from "crypto"
import { db } from "./firebase.js"
import { logger } from "./logger.js"
import { registerOrderDeliveredHook } from "./domain.js"
import {
  buildDeliveryFeedEntry, filterAndFormatDeliveries, computeDeliveryEstimates, FRESHNESS_WINDOW_MS,
} from "./lib/social-proof-rules.js"
import { registerCacheReset } from "./lib/runtime-cache.js"

const PATH = "delivery_feed"
const CACHE_MS = 30_000
const RETAIN_MS = 24 * 60 * 60 * 1000
const READ_LIMIT = 300

let cache = { at: 0, entries: null }
let lastPruneAt = 0
registerCacheReset(() => { cache = { at: 0, entries: null } })

const entryKey = (reference) => crypto.createHash("sha256").update(String(reference || "")).digest("hex").slice(0, 20)

export async function recordDelivery(order) {
  const reference = String(order?.reference || "").trim()
  const entry = buildDeliveryFeedEntry(order, Date.now())
  if (!reference || !entry) return false
  const result = await db.ref(`${PATH}/${entryKey(reference)}`).transaction((current) => current || entry)
  cache = { at: 0, entries: null }
  return result.committed === true
}

async function pruneStaleEntries(now) {
  if (now - lastPruneAt < 10 * 60_000) return
  lastPruneAt = now
  const stale = await db.ref(PATH).orderByChild("deliveredAt").endAt(now - RETAIN_MS).limitToFirst(200).once("value")
  const updates = {}
  stale.forEach((child) => { updates[`${PATH}/${child.key}`] = null })
  if (Object.keys(updates).length) await db.ref().update(updates)
}

export async function getRecentDeliveries(now = Date.now()) {
  if (cache.entries && now - cache.at < CACHE_MS) return cache.entries
  const snapshot = await db.ref(PATH).orderByChild("deliveredAt").startAt(now - FRESHNESS_WINDOW_MS)
    .limitToLast(READ_LIMIT).once("value")
  const entries = []
  snapshot.forEach((child) => { entries.push(child.val()) })
  cache = { at: now, entries }
  pruneStaleEntries(now).catch((error) => logger.warn("Delivery feed prune failed", { message: error.message }))
  return entries
}

export async function getDeliveryProofs(limit = 10) {
  return filterAndFormatDeliveries(await getRecentDeliveries(), limit)
}

export async function getDeliveryEstimates() {
  return computeDeliveryEstimates(await getRecentDeliveries())
}

registerOrderDeliveredHook(async (order) => {
  await recordDelivery(order)
})
