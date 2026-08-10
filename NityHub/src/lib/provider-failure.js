// Pure classification of a failed provider submission.
//
// Free of Firebase imports so the single most expensive decision in the system
// - whether a debited customer is refunded, or has the debit held while the
// order is parked for review - is unit testable in isolation.
//
// The question this answers is only ever "could the order be live upstream?".
// It is not "did we get an error": every case here is an error. Getting it
// wrong in one direction refunds a bundle that was actually delivered; in the
// other it strands a customer's money on an order that never existed.

import { getErrorCode } from "./errors.js"
import { normalizeProvider } from "./provider-mapping.js"

export function isIndeterminateProviderSubmissionError(error) {
  const errorCode = getErrorCode(error)
  const upstreamCode = String(error?.upstreamCode || "").trim().toUpperCase()
  const statusCode = Number(error?.statusCode || 0)

  // An open circuit breaker rejects inside our own process - no request is ever
  // sent, so the order provably does not exist upstream. This has to be decided
  // before the catch-all below, because a breaker rejection carries no HTTP
  // status and would otherwise read as a 5xx: that held the debit and parked an
  // order that was never dispatched, on every purchase for as long as the
  // breaker stayed open.
  if (upstreamCode === "CIRCUIT_OPEN") {
    return false
  }

  // The request left the box and we never heard back. The provider may well
  // have accepted it.
  if (["REQUEST_TIMEOUT", "NETWORK_ERROR"].includes(upstreamCode)) {
    return true
  }

  // PBM HUB says so explicitly: it holds the debit and warns against retrying,
  // because the order may already be live.
  if (errorCode === "PBMHUB_SUBMISSION_PENDING") {
    return true
  }

  // A provider-side error with no status, or a 5xx: the request may have been
  // processed before the failure. A 4xx is excluded - that is a definitive
  // rejection, and the order is safe to fail and refund.
  if (
    ["HUBNET_API_ERROR", "GODSWAY_API_ERROR", "GIGSHUB_API_ERROR", "PBMHUB_API_ERROR"].includes(errorCode) &&
    (!statusCode || statusCode >= 500)
  ) {
    return true
  }

  return false
}

export function getIndeterminateProviderSubmissionMessage(provider = "") {
  const normalized = normalizeProvider(provider)
  const providerLabel =
    normalized === "godsway"
      ? "CK-Godsway"
      : normalized === "hubnet"
        ? "Hubnet"
        : normalized === "gigshub"
          ? "GiGSHUB"
          : normalized === "pbmhub"
            ? "PBM HUB"
            : "provider"

  return `${providerLabel} did not return a final confirmation. Do not retry this purchase yet; it is pending review.`
}
