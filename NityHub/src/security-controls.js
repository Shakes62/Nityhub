// Anti-fraud controls: phone/identity blacklists and recipient velocity.
//
// Blacklists are mirrored into memory from the database, so every entry point
// (shop, storefront, repair) does a sub-millisecond set lookup. Entries are
// stored as keyed HMACs, never as raw numbers or emails.

import crypto from "crypto"
import { db } from "./firebase.js"
import { CONFIG } from "./config.js"
import { logger } from "./logger.js"
import { registerCacheReset } from "./lib/runtime-cache.js"

const phoneHashes = new Set()
const identityHashes = new Set()
const recipientWindows = new Map()
const flaggedRecently = new Map()
registerCacheReset(() => { recipientWindows.clear(); flaggedRecently.clear() })
// Set BLACKLIST_HASH_KEY explicitly in production. The Paystack fallback keeps
// existing deployments working, but rotating that key would silently orphan
// every blacklist entry.
const key = process.env.BLACKLIST_HASH_KEY || CONFIG.paystackSecretKey || "nityhub-blacklist-v1"

export const RECIPIENT_VELOCITY_WINDOW_MS = 5 * 60_000
export const RECIPIENT_VELOCITY_MAX_UNIQUE = 20

export function securityHash(value) {
  return crypto.createHmac("sha256", key).update(String(value || "").trim().toLowerCase()).digest("hex")
}

export function isRecipientBlocked(phone) {
  return phoneHashes.has(securityHash(phone))
}

export function isIdentityBlocked(identity) {
  return Boolean(identity) && identityHashes.has(securityHash(identity))
}

/**
 * Best-effort record for admin review. Throttled per actor so a bot hammering
 * the endpoint produces one flag, not thousands of writes.
 */
export function flagRisk(actor, reason, details = {}) {
  const id = String(actor || "unknown")
  const now = Date.now()
  if (now - Number(flaggedRecently.get(id) || 0) < 60_000) return
  flaggedRecently.set(id, now)
  if (flaggedRecently.size > 5000) {
    for (const [k, at] of flaggedRecently) if (now - at > 60_000) flaggedRecently.delete(k)
  }
  db.ref(`risk_flags/${securityHash(id).slice(0, 32)}`).transaction((current) => ({
    actor: id.slice(0, 128),
    reason,
    details,
    count: Number(current?.count || 0) + 1,
    firstAt: Number(current?.firstAt || now),
    lastAt: now,
  })).catch((error) => logger.warn("Risk flag write failed", { message: error.message }))
}

/**
 * True when `actor` (a uid or ip:<addr>) has targeted more than 20 distinct
 * recipients in 5 minutes - the signature of a carding or resale bot.
 */
export function assessRecipientVelocity(actor, phone, now = Date.now()) {
  const id = String(actor || "unknown")
  const previous = recipientWindows.get(id) || []
  const current = previous.filter((item) => item.at > now - RECIPIENT_VELOCITY_WINDOW_MS)
  current.push({ hash: securityHash(phone), at: now })
  recipientWindows.set(id, current.slice(-200))
  if (recipientWindows.size > 10_000) {
    for (const [idKey, entries] of recipientWindows) {
      if (entries.every((item) => item.at <= now - RECIPIENT_VELOCITY_WINDOW_MS)) recipientWindows.delete(idKey)
    }
  }
  const tripped = new Set(current.map((item) => item.hash)).size > RECIPIENT_VELOCITY_MAX_UNIQUE
  if (tripped) flagRisk(id, "recipient_velocity", { windowMinutes: 5, uniqueRecipients: new Set(current.map((item) => item.hash)).size })
  return tripped
}

export function startBlacklistSync() {
  for (const [path, target] of [["phone_blacklist", phoneHashes], ["identity_blacklist", identityHashes]]) {
    db.ref(path).on("value", (snapshot) => {
      target.clear()
      for (const [hash, entry] of Object.entries(snapshot.val() || {})) {
        if (entry?.active !== false) target.add(hash)
      }
    }, (error) => logger.error("Blacklist sync failed", error, { path }))
  }
}

function blacklistTarget(kind) {
  if (kind === "phone") return { target: phoneHashes, path: "phone_blacklist" }
  if (kind === "identity") return { target: identityHashes, path: "identity_blacklist" }
  return null
}

export async function changeBlacklist(kind, value, active, actorUid, note = "") {
  const entry = blacklistTarget(kind)
  if (!entry || !value) throw new Error("Invalid blacklist entry")
  const hash = securityHash(value)
  if (active) {
    await db.ref(`${entry.path}/${hash}`).set({ active: true, actorUid, note: String(note || "").slice(0, 140), updatedAt: Date.now() })
    entry.target.add(hash)
  } else {
    await db.ref(`${entry.path}/${hash}`).remove()
    entry.target.delete(hash)
  }
  return hash
}

export async function getBlacklistStatus(kind, value) {
  const entry = blacklistTarget(kind)
  if (!entry || !value) throw new Error("Invalid blacklist entry")
  const record = (await db.ref(`${entry.path}/${securityHash(value)}`).once("value")).val()
  return { blocked: Boolean(record && record.active !== false), note: record?.note || "", updatedAt: Number(record?.updatedAt || 0) || null }
}

export async function getBlacklistCounts() {
  return { phone: phoneHashes.size, identity: identityHashes.size }
}

export async function listRiskFlags(limit = 50) {
  const snapshot = await db.ref("risk_flags").orderByChild("lastAt").limitToLast(Math.min(Number(limit) || 50, 200)).once("value")
  return Object.entries(snapshot.val() || {})
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => Number(b.lastAt || 0) - Number(a.lastAt || 0))
}

export async function clearRiskFlag(id) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ""))) throw new Error("Invalid flag")
  await db.ref(`risk_flags/${id}`).remove()
}
