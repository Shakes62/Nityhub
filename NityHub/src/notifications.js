// User-facing notifications: one durable in-app feed per user, mirrored to Web
// Push when the user has opted in on a device.
//
// The feed (`user_notifications/{uid}`) is the source of truth. The SSE stream
// in realtime.js tails it, so an open tab sees a notification instantly no
// matter which server instance produced it. Push is best effort on top.

import crypto from "crypto"
import { admin, db } from "./firebase.js"
import { CONFIG } from "./config.js"
import { logger } from "./logger.js"

const FEED_PATH = "user_notifications"
const TOKEN_PATH = "push_tokens"
const MAX_TOKENS_PER_USER = 10
const FEED_READ_LIMIT = 30

const safeUid = (uid) => {
  const value = String(uid || "").trim()
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : ""
}

const tokenKey = (token) => crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 32)

/** Notification ids are derived from the event, so a retried event never notifies twice. */
export function notificationId(kind, reference) {
  return `${String(kind).replace(/[^a-z0-9_]/gi, "").slice(0, 24)}_${crypto
    .createHash("sha256").update(String(reference || "")).digest("hex").slice(0, 24)}`
}

export function toPublicNotification(id, value = {}) {
  return {
    id,
    type: String(value.type || "info"),
    title: String(value.title || ""),
    message: String(value.message || ""),
    url: typeof value.url === "string" && value.url.startsWith("/") ? value.url : "",
    amount: Number.isFinite(Number(value.amount)) ? Number(value.amount) : null,
    read: value.read === true,
    createdAt: Number(value.createdAt || 0),
  }
}

async function sendPush(uid, { title, message, url, id }) {
  const snapshot = await db.ref(`${TOKEN_PATH}/${uid}`).once("value")
  const entries = Object.entries(snapshot.val() || {}).filter(([, item]) => typeof item?.token === "string")
  if (!entries.length) return 0
  const link = `${CONFIG.frontendUrl.replace(/\/$/, "")}${url || "/dashboard"}`
  const response = await admin.messaging().sendEachForMulticast({
    tokens: entries.map(([, item]) => item.token),
    notification: { title, body: message },
    data: { url: url || "/dashboard", id },
    webpush: { fcmOptions: { link }, notification: { icon: "/icon.png", badge: "/icon.png", tag: id } },
  })
  // Drop tokens the push service says are gone, so the list cannot grow stale.
  const stale = {}
  response.responses.forEach((result, index) => {
    const code = result.error?.code || ""
    if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token") || code.includes("invalid-argument")) {
      stale[`${TOKEN_PATH}/${uid}/${entries[index][0]}`] = null
    }
  })
  if (Object.keys(stale).length) await db.ref().update(stale).catch(() => null)
  return response.successCount
}

/**
 * Record a notification once and fan it out. Returns false when this exact
 * notification already exists (a replayed webhook, a second settlement path).
 */
export async function notifyUser(uid, { id, type = "info", title, message, url = "", amount = null }) {
  const owner = safeUid(uid)
  if (!owner || !id || !title || owner.startsWith("guest_")) return false
  const ref = db.ref(`${FEED_PATH}/${owner}/${id}`)
  const created = await ref.transaction((current) => {
    if (current) return
    return { type, title, message: String(message || ""), url, amount, read: false, createdAt: Date.now() }
  })
  if (!created.committed) return false
  sendPush(owner, { title, message: String(message || ""), url, id })
    .catch((error) => logger.warn("Web push delivery failed", { uid: owner, message: error.message }))
  return true
}

export async function listNotifications(uid, limit = FEED_READ_LIMIT) {
  const owner = safeUid(uid)
  if (!owner) return []
  const snapshot = await db.ref(`${FEED_PATH}/${owner}`).orderByChild("createdAt")
    .limitToLast(Math.min(Math.max(Number(limit) || FEED_READ_LIMIT, 1), 100)).once("value")
  return Object.entries(snapshot.val() || {})
    .map(([id, value]) => toPublicNotification(id, value))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function markNotificationsRead(uid) {
  const owner = safeUid(uid)
  if (!owner) return 0
  const items = await listNotifications(owner, 100)
  const updates = {}
  for (const item of items) if (!item.read) updates[`${FEED_PATH}/${owner}/${item.id}/read`] = true
  if (Object.keys(updates).length) await db.ref().update(updates)
  return Object.keys(updates).length
}

export async function savePushToken(uid, token) {
  const owner = safeUid(uid)
  const value = String(token || "").trim()
  if (!owner || value.length < 20 || value.length > 4096) throw new Error("Invalid push token")
  const ref = db.ref(`${TOKEN_PATH}/${owner}`)
  await ref.transaction((current) => {
    const next = { ...(current || {}), [tokenKey(value)]: { token: value, updatedAt: Date.now() } }
    const keys = Object.keys(next).sort((a, b) => Number(next[b].updatedAt || 0) - Number(next[a].updatedAt || 0))
    for (const key of keys.slice(MAX_TOKENS_PER_USER)) delete next[key]
    return next
  })
}

export async function removePushToken(uid, token) {
  const owner = safeUid(uid)
  if (!owner || !token) return
  await db.ref(`${TOKEN_PATH}/${owner}/${tokenKey(token)}`).remove()
}

export async function getPushTokens(uid) {
  const owner = safeUid(uid)
  if (!owner) return []
  const snapshot = await db.ref(`${TOKEN_PATH}/${owner}`).once("value")
  return Object.values(snapshot.val() || {}).map((item) => item?.token).filter(Boolean)
}
