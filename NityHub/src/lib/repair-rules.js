import { normalizeInternalOrderStatus } from "./order-status.js"

const PAID = new Set(["success", "wallet_debited", "wallet_debited_pending", "wallet_capture_unconfirmed"])
const REFUNDED = new Set(["refunded", "wallet_refunded", "wallet_not_charged", "wallet_hold_stuck"])

export function classifyRepairState(order = {}, intent = {}) {
  const status = normalizeInternalOrderStatus(order.status || intent.orderStatus, "pending")
  const payment = String(order.paymentStatus || intent.paymentStatus || "").toLowerCase()
  if (order.refunded === true || intent.refunded === true || REFUNDED.has(payment)) return "refunded"
  if (status === "delivered") return "delivered"
  if (!PAID.has(payment)) return "unpaid"
  if (order.repairDispatchClaim || intent.providerSubmissionStatus === "processing") return "processing"
  if (order.retryEligible === false || intent.retryEligible === false) return "processing"
  if (["failed", "cancelled"].includes(status) || intent.providerSubmissionStatus === "failed") return "retryable"
  return "reconcile"
}

export function hasDefinitiveProviderFailure(upstream) {
  if (!upstream || upstream.supported === false ||
    !["failed", "cancelled"].includes(normalizeInternalOrderStatus(upstream.status, "pending"))) return false
  const body = upstream.providerResponse || {}
  if (body.success === false || body.data?.success === false) return true
  const explicit = [body.order?.status, body.data?.status, body.data?.orderStatus,
    body.data?.state, body.status, body.orderStatus, body.state]
  return explicit.some((value) => ["failed", "cancelled"].includes(normalizeInternalOrderStatus(value, "")))
}

/**
 * Did this order ever reach a provider? Hubnet echoes our own reference as its
 * id, so the stored order carries providerReference === reference before any
 * request is made. That value is therefore NOT evidence of submission; only a
 * provider-issued id, or an intent that recorded a submission, is.
 */
export function hasProviderSubmissionEvidence(order = {}, intent = {}) {
  const reference = String(order.reference || intent.reference || "").trim()
  const providerReference = String(order.providerReference || "").trim()
  return Boolean(String(order.providerOrderNumber || "").trim()) ||
    Boolean(providerReference && providerReference !== reference) ||
    ["processing", "submitted", "completed"].includes(String(intent.providerSubmissionStatus || ""))
}

export function canRedispatchAfterStatus({ previousState, upstream, order = {}, intent = {} }) {
  if (order.repairDispatchClaim && Date.now() - Number(order.repairDispatchClaim.claimedAt || 0) < 120_000) return false
  if (hasDefinitiveProviderFailure(upstream)) return true
  if (upstream && upstream.supported !== false) return false
  if (previousState !== "retryable" || order.retryEligible === false) return false
  if (order.statusSource === "repair_reconstruction" && !hasProviderSubmissionEvidence(order, intent)) return true
  if (Array.isArray(order.providerAttempts) && order.providerAttempts.length > 0 &&
    order.providerAttempts.every((attempt) => attempt.uncertain !== true)) return true
  if (["provider_status", "provider_webhook", "webhook"].includes(order.statusSource) &&
    ["failed", "cancelled"].includes(normalizeInternalOrderStatus(order.providerStatusRaw, ""))) return true
  return false
}

export function isValidRepairReference(value) {
  return /^[A-Za-z0-9_-]{8,140}$/.test(String(value || "").trim())
}
