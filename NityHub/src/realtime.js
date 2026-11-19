// Real-time user stream (Server-Sent Events).
//
// GET /api/me/events keeps one long-lived response per open tab and pushes:
//   wallet_updated  { balance, availableBalance, heldBalance }
//   notification    { id, type, title, message, url, amount, createdAt }
//
// It tails the database rather than an in-process event bus, so a deposit
// settled by any server instance (webhook on one, verify call on another)
// reaches every open tab of that user.

import { db } from "./firebase.js"
import { logger } from "./logger.js"
import { authenticateRequest, toMoneyNumber } from "./domain.js"
import { getAvailableWalletBalance, getHeldWalletBalance } from "./lib/wallet-core.js"
import { purchaseActionRateLimit } from "./middleware.js"
import {
  listNotifications, markNotificationsRead, savePushToken, removePushToken, toPublicNotification,
} from "./notifications.js"

const MAX_STREAMS_PER_USER = 5
const HEARTBEAT_MS = 25_000
// Streams are recycled periodically so a revoked or expired ID token cannot
// keep a connection alive indefinitely; the client reconnects with a fresh one.
const MAX_STREAM_MS = 30 * 60_000
const openStreams = new Map()

export function walletSnapshot(wallet = {}) {
  const value = wallet && typeof wallet === "object" ? wallet : {}
  return {
    balance: toMoneyNumber(value.balance, 0),
    availableBalance: getAvailableWalletBalance(value),
    heldBalance: getHeldWalletBalance(value),
  }
}

export function formatSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function registerRealtimeRoutes(app) {
  app.get("/api/me/events", authenticateRequest, (req, res) => {
    const uid = req.authUser.uid
    const count = openStreams.get(uid) || 0
    if (count >= MAX_STREAMS_PER_USER) {
      return res.status(429).json({ status: "error", message: "Too many open sessions. Close a tab and try again." })
    }
    openStreams.set(uid, count + 1)

    // Long-lived: opt out of the server's short idle timeout for this socket.
    req.socket.setTimeout(0)
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform keeps the compression middleware from buffering events.
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.flushHeaders?.()

    let closed = false
    const send = (event, data) => {
      if (closed) return
      res.write(formatSseEvent(event, data))
      res.flush?.()
    }
    res.write("retry: 5000\n\n")
    send("ready", { at: Date.now() })

    const walletRef = db.ref(`wallets/${uid}`)
    let lastWallet = ""
    const onWallet = (snapshot) => {
      const next = walletSnapshot(snapshot.val() || {})
      const key = JSON.stringify(next)
      if (key === lastWallet) return
      lastWallet = key
      send("wallet_updated", { ...next, at: Date.now() })
    }
    const onError = (error) => logger.warn("Realtime stream listener failed", { uid, message: error?.message })
    walletRef.on("value", onWallet, onError)

    const feedRef = db.ref(`user_notifications/${uid}`).orderByChild("createdAt").startAt(Date.now())
    const onNotification = (snapshot) => send("notification", toPublicNotification(snapshot.key, snapshot.val() || {}))
    feedRef.on("child_added", onNotification, onError)

    const heartbeat = setInterval(() => {
      if (!closed) {
        res.write(`: ping ${Date.now()}\n\n`)
        res.flush?.()
      }
    }, HEARTBEAT_MS)
    const recycle = setTimeout(() => res.end(), MAX_STREAM_MS)

    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      clearTimeout(recycle)
      walletRef.off("value", onWallet)
      feedRef.off("child_added", onNotification)
      const remaining = (openStreams.get(uid) || 1) - 1
      if (remaining > 0) openStreams.set(uid, remaining)
      else openStreams.delete(uid)
    }
    req.on("close", cleanup)
    res.on("close", cleanup)
    res.on("error", cleanup)
  })

  app.get("/api/me/notifications", authenticateRequest, async (req, res) => {
    try {
      res.set("Cache-Control", "no-store")
      return res.json({ status: "success", data: await listNotifications(req.authUser.uid, req.query.limit) })
    } catch (error) {
      logger.error("Failed to list notifications", error, { uid: req.authUser.uid })
      return res.status(503).json({ status: "error", message: "Notifications could not be loaded right now." })
    }
  })

  app.post("/api/me/notifications/read", authenticateRequest, purchaseActionRateLimit, async (req, res) => {
    try {
      return res.json({ status: "success", data: { updated: await markNotificationsRead(req.authUser.uid) } })
    } catch (error) {
      logger.error("Failed to mark notifications read", error, { uid: req.authUser.uid })
      return res.status(503).json({ status: "error", message: "Please try again shortly." })
    }
  })

  app.post("/api/me/push-token", authenticateRequest, purchaseActionRateLimit, async (req, res) => {
    try {
      await savePushToken(req.authUser.uid, req.body?.token)
      return res.json({ status: "success", data: { subscribed: true } })
    } catch (error) {
      return res.status(400).json({ status: "error", message: "Notifications could not be enabled on this device." })
    }
  })

  app.delete("/api/me/push-token", authenticateRequest, purchaseActionRateLimit, async (req, res) => {
    try {
      await removePushToken(req.authUser.uid, req.body?.token)
      return res.json({ status: "success", data: { subscribed: false } })
    } catch (error) {
      logger.warn("Push token removal failed", { uid: req.authUser.uid, message: error.message })
      return res.status(503).json({ status: "error", message: "Please try again shortly." })
    }
  })
}
