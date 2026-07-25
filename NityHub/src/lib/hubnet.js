// Pure helpers for interpreting Hubnet API and webhook payloads.
//
// Free of Firebase imports so the status mapping - which decides whether an
// order is ever marked delivered - is unit testable.

import { firstNonEmptyText } from "./godsway.js"
import { getWebhookEventStatus, normalizeInternalOrderStatus } from "./order-status.js"

export function normalizeHubnetSuccessValue(value) {
  if (typeof value === "boolean") {
    return value
  }

  const normalized = String(value || "").trim().toLowerCase()
  if (!normalized) {
    return null
  }

  if (["success", "successful", "true", "ok", "completed"].includes(normalized)) {
    return true
  }

  if (["failed", "false", "error", "rejected"].includes(normalized)) {
    return false
  }

  return null
}

export function isHubnetSuccessfulResponse(data) {
  const topLevelStatus = normalizeHubnetSuccessValue(data?.status)
  if (topLevelStatus !== null) {
    return topLevelStatus
  }

  const nestedStatus = normalizeHubnetSuccessValue(data?.data?.status)
  if (nestedStatus !== null) {
    return nestedStatus
  }

  const codes = [data?.message, data?.code, data?.data?.message, data?.data?.code]
    .map((value) => String(value || "").trim())
    .filter(Boolean)

  return codes.includes("0000")
}

export function getHubnetResponseSummary(data = {}, fallbackMessage = "") {
  return [
    data?.message,
    data?.reason,
    data?.code,
    data?.response_code,
    data?.data?.message,
    data?.data?.reason,
    data?.data?.code,
    data?.data?.response_msg,
    fallbackMessage,
  ]
    .filter(Boolean)
    .join(" | ")
}

export function classifyHubnetFailure(data = {}, fallbackMessage = "") {
  const summary = getHubnetResponseSummary(data, fallbackMessage)
  const normalized = summary.toLowerCase()

  if (
    normalized.includes("invalid token") ||
    normalized.includes("no token") ||
    normalized.includes("unauthorized")
  ) {
    return {
      code: "HUBNET_AUTH_FAILED",
      message: "Hubnet API authentication failed. Update HUBNET_API_KEY.",
    }
  }

  if (normalized.includes("insufficient")) {
    return {
      code: "INSUFFICIENT_HUBNET_BALANCE",
      message: "Service provider has insufficient balance",
    }
  }

  if (
    normalized.includes("rate limit") ||
    normalized.includes("too many request") ||
    normalized.includes("429") ||
    normalized.includes("1007")
  ) {
    return {
      code: "HUBNET_RATE_LIMITED",
      message: "Hubnet API rate limit reached. Please try again shortly.",
    }
  }

  if (normalized.includes("invalid network") || normalized.includes("1001")) {
    return {
      code: "HUBNET_INVALID_NETWORK",
      message: "Hubnet rejected the selected network",
    }
  }

  if (normalized.includes("invalid volume") || normalized.includes("1002")) {
    return {
      code: "HUBNET_INVALID_VOLUME",
      message: "Hubnet rejected the selected bundle size",
    }
  }

  return {
    code: "HUBNET_API_ERROR",
    message: summary || "Hubnet transaction failed",
  }
}

/** Status details derived from a Hubnet API response body. */
export function getHubnetStatusDetails(data = {}, fallbackStatus = "accepted") {
  const rawStatusCandidate = firstNonEmptyText([
    data?.data?.status,
    data?.status,
    data?.data?.response_msg,
    data?.reason,
    data?.data?.message,
    data?.message,
  ])
  const successState = isHubnetSuccessfulResponse(data)
  const providerStatusDescription = getHubnetResponseSummary(data)
  const rawStatus =
    (["true", "false"].includes(String(rawStatusCandidate).toLowerCase()) ? "" : rawStatusCandidate) ||
    (successState === true ? "SUCCESS" : successState === false ? "FAILED" : fallbackStatus)
  const normalizedFallback =
    successState === true
      ? "delivered"
      : successState === false
        ? "failed"
        : normalizeInternalOrderStatus(providerStatusDescription, fallbackStatus)

  return {
    providerStatusRaw: rawStatus,
    providerStatusDescription,
    normalizedStatus: normalizeInternalOrderStatus(rawStatus, normalizedFallback),
  }
}

/**
 * Status details for an inbound Hubnet webhook.
 *
 * Prefers the `event` name over the body. Hubnet's documented
 * `transfer.delivered` callback carries `data.status: "Processing"`, so reading
 * the body alone parks every delivered order on "processing" permanently.
 */
export function getHubnetWebhookStatusDetails(payload = {}, fallbackStatus = "processing") {
  const bodyDetails = getHubnetStatusDetails(payload, fallbackStatus)
  const event = String(payload?.event || "").trim()
  const eventStatus = getWebhookEventStatus(event)

  if (!eventStatus) {
    return bodyDetails
  }

  return {
    providerStatusRaw: event || bodyDetails.providerStatusRaw,
    providerStatusDescription:
      bodyDetails.providerStatusDescription || String(payload?.message || "").trim() || event,
    normalizedStatus: eventStatus,
  }
}

/**
 * Hubnet answers a status lookup for an unknown reference with a "no transaction
 * found" body rather than an error. Treating that as a delivery failure would
 * wrongly fail (and refund) orders Hubnet has simply not registered yet, so
 * callers skip and retry instead.
 */
export function isHubnetTransactionNotFoundResponse(data = {}) {
  const summary = getHubnetResponseSummary(data).toLowerCase()
  return (
    summary.includes("no transaction found") ||
    summary.includes("transaction not found") ||
    summary.includes("record not found")
  )
}
