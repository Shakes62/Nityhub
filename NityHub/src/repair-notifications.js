// Step 7 of the repair pipeline: tell the customer.
//
// Signed-in customers get an in-app notification (live over SSE) plus Web Push
// on any device where they enabled it. Everyone, guests included, gets an SMS
// when an SMS gateway is configured. SMS is queued durably and retried with
// backoff, because a gateway blip must not lose the confirmation.

import crypto from "crypto"
import { db } from "./firebase.js"
import { CONFIG } from "./config.js"
import { logger } from "./logger.js"
import { isValidRepairReference } from "./lib/repair-rules.js"
import { notifyUser, notificationId } from "./notifications.js"

const PATH = "repair_notifications"
const MAX_ATTEMPTS = 8

const smsConfigured = () => Boolean(String(process.env.REPAIR_SMS_WEBHOOK_URL || "").trim())

export function buildReceiptUrl(reference, guest) {
  const base = CONFIG.frontendUrl.replace(/\/$/, "")
  return `${base}${guest ? `/receipt/${encodeURIComponent(reference)}` : `/orders?reference=${encodeURIComponent(reference)}`}`
}

export async function queueRepairConfirmation({ reference, phone, userId = "", guest = false }) {
  if (!isValidRepairReference(reference)) return
  const receiptUrl = buildReceiptUrl(reference, guest)

  if (!guest && userId) {
    await notifyUser(userId, {
      id: notificationId("repair", reference),
      type: "order_repaired",
      title: "Order delivered",
      message: "Your data order has been confirmed delivered. No extra charge was made.",
      url: `/orders?reference=${encodeURIComponent(reference)}`,
    }).catch((error) => logger.warn("Repair in-app notification failed", { reference, message: error.message }))
  }

  if (!smsConfigured() || !/^0\d{9}$/.test(String(phone || ""))) return
  await db.ref(`${PATH}/${reference}`).transaction((current) => current || {
    reference, phone, guest, receiptUrl,
    message: `Your data order ${reference.slice(-10)} is confirmed. Track it: ${receiptUrl}`,
    smsStatus: "pending", attempts: 0, nextAttemptAt: Date.now(), createdAt: Date.now(),
  })
}

export async function runRepairNotificationQueue() {
  if (!smsConfigured()) return 0
  const now = Date.now()
  const snapshot = await db.ref(PATH).orderByChild("nextAttemptAt").startAt(1).endAt(now).limitToFirst(20).once("value")
  if (!snapshot.exists()) return 0
  let completed = 0
  for (const [reference, entry] of Object.entries(snapshot.val() || {})) {
    const token = crypto.randomUUID()
    const ref = db.ref(`${PATH}/${reference}`)
    const claim = await ref.transaction((current) => {
      const value = current === null ? entry : current
      if (!value || !Number(value.nextAttemptAt) || value.nextAttemptAt > now || Number(value.leaseExpiresAt || 0) > now) return
      return { ...value, leaseToken: token, leaseExpiresAt: now + 60_000 }
    })
    if (!claim.committed) continue
    const item = claim.snapshot.val() || entry
    let smsStatus = item.smsStatus
    try {
      const response = await fetch(process.env.REPAIR_SMS_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.REPAIR_SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.REPAIR_SMS_WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify({ to: item.phone, message: item.message, reference }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`SMS gateway returned ${response.status}`)
      smsStatus = "sent"
    } catch (error) {
      logger.warn("Repair SMS delivery failed", { reference, message: error.message })
    }
    const attempts = Number(item.attempts || 0) + 1
    const finished = smsStatus === "sent" || attempts >= MAX_ATTEMPTS
    await ref.transaction((current) => {
      const value = current === null ? item : current
      if (value?.leaseToken !== token) return
      return {
        ...value,
        smsStatus: smsStatus === "sent" ? "sent" : finished ? "failed" : "pending",
        attempts,
        nextAttemptAt: finished ? null : Date.now() + Math.min(60 * 60_000, 60_000 * 2 ** Math.min(6, attempts)),
        leaseToken: null, leaseExpiresAt: null,
      }
    })
    if (finished) completed++
  }
  return completed
}
