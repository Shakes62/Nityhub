// Pure order-status vocabulary and transition rules.
//
// Free of Firebase and config imports so the rules that decide whether an
// order may move from one status to another - the thing that determines
// whether a delivered order can be silently un-delivered by a late webhook -
// are unit testable in isolation.

/** Statuses from which an order never moves again on its own. */
export const TERMINAL_ORDER_STATUSES = new Set(["delivered", "failed", "cancelled"])

/**
 * Collapse any provider's status vocabulary onto our six internal statuses.
 *
 * Exact matches are tried first, then substring heuristics, so an unfamiliar
 * phrase like "order unsuccessful" still lands on "failed" rather than the
 * fallback.
 */
export function normalizeInternalOrderStatus(value, fallback = "pending") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")

  if (!normalized) {
    return fallback
  }

  if (["initiated", "accepted", "queued"].includes(normalized)) {
    return "accepted"
  }

  if (["pending", "awaiting", "submitted"].includes(normalized)) {
    return "pending"
  }

  if (["processing", "in_progress", "running"].includes(normalized)) {
    return "processing"
  }

  if (["successful", "success", "completed", "complete", "delivered"].includes(normalized)) {
    return "delivered"
  }

  if (["failed", "error", "rejected"].includes(normalized)) {
    return "failed"
  }

  if (["cancelled", "canceled"].includes(normalized)) {
    return "cancelled"
  }

  if (["unsuccessful", "unsuccess", "declined"].some((term) => normalized.includes(term))) {
    return "failed"
  }

  if (["failed", "error", "reject", "declin"].some((term) => normalized.includes(term))) {
    return "failed"
  }

  if (normalized.includes("cancel")) {
    return "cancelled"
  }

  if (["process", "progress", "running"].some((term) => normalized.includes(term))) {
    return "processing"
  }

  if (["pending", "await", "submit"].some((term) => normalized.includes(term))) {
    return "pending"
  }

  if (["success", "deliver", "complet", "fulfil", "fulfilled"].some((term) => normalized.includes(term))) {
    return "delivered"
  }

  if (["initiat", "queue", "accept"].some((term) => normalized.includes(term))) {
    return "accepted"
  }

  return fallback
}

export function isTerminalOrderStatus(status) {
  return TERMINAL_ORDER_STATUSES.has(normalizeInternalOrderStatus(status, ""))
}

/** How far along the fulfilment pipeline a status sits. Higher is later. */
export function getOrderStatusPriority(status) {
  switch (normalizeInternalOrderStatus(status, "")) {
    case "accepted":
      return 1
    case "pending":
      return 2
    case "processing":
      return 3
    case "delivered":
    case "failed":
    case "cancelled":
      return 4
    default:
      return 0
  }
}

export function getPurchaseIntentSubmissionStatusForOrderStatus(status) {
  const normalized = normalizeInternalOrderStatus(status, "pending")
  if (normalized === "delivered") {
    return "completed"
  }

  if (["failed", "cancelled"].includes(normalized)) {
    return "failed"
  }

  if (["accepted", "pending", "processing"].includes(normalized)) {
    return "submitted"
  }

  return "pending"
}

/**
 * Map a provider webhook `event` name to an internal status.
 *
 * This is the authoritative signal for Hubnet. Their own documentation shows a
 * `transfer.delivered` callback carrying `data.status: "Processing"`, so reading
 * `data.status` alone leaves every delivered order stuck on "processing"
 * forever. The event name says what actually happened; the body's status field
 * is only a fallback for events we do not recognise.
 */
export function getWebhookEventStatus(event) {
  const normalized = String(event || "")
    .trim()
    .toLowerCase()
    .replace(/^(transfer|order|transaction|charge)[._-]/, "")

  if (!normalized) {
    return ""
  }

  if (["delivered", "completed", "complete", "success", "successful", "fulfilled"].includes(normalized)) {
    return "delivered"
  }

  if (["failed", "failure", "error", "rejected", "declined", "reversed", "refunded"].includes(normalized)) {
    return "failed"
  }

  if (["cancelled", "canceled"].includes(normalized)) {
    return "cancelled"
  }

  if (["processing", "in_progress", "inprogress", "running"].includes(normalized)) {
    return "processing"
  }

  if (["pending", "queued", "submitted", "awaiting"].includes(normalized)) {
    return "pending"
  }

  if (["initiated", "accepted", "created", "received"].includes(normalized)) {
    return "accepted"
  }

  return ""
}

/**
 * Decide whether an incoming status may replace the stored one.
 *
 * Order status is monotonic for everything except an explicit admin override:
 * once an order is terminal (delivered/failed/cancelled) it stays there, and a
 * provider update may never walk it backwards. Without this, an out-of-order
 * `transfer.processing` webhook arriving after `transfer.delivered` - or a
 * status poll that raced a webhook - silently un-delivers a finished order.
 *
 * Returning false for an unchanged status is what makes replayed webhooks
 * idempotent: the caller writes nothing at all.
 */
export function canApplyOrderStatus(currentStatus, nextStatus, { manual = false } = {}) {
  const current = normalizeInternalOrderStatus(currentStatus, "")
  const next = normalizeInternalOrderStatus(nextStatus, "")

  if (!next || next === current) {
    return false
  }

  // Admins are the escape hatch: support has to be able to correct a wrong
  // terminal state (e.g. the provider reported delivered but the customer
  // never got the bundle).
  if (manual) {
    return true
  }

  if (!current) {
    return true
  }

  if (isTerminalOrderStatus(current)) {
    return false
  }

  return getOrderStatusPriority(next) >= getOrderStatusPriority(current)
}
