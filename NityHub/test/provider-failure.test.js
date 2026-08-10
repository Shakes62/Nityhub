// Regression tests for the indeterminate-submission classifier.
//
// This is the function that decides whether a debited customer is refunded or
// has the debit held pending review, so each case below is written as the money
// outcome it produces rather than as a boolean.

import test from "node:test"
import assert from "node:assert/strict"

import { createAppError } from "../src/lib/errors.js"
import {
  getIndeterminateProviderSubmissionMessage,
  isIndeterminateProviderSubmissionError,
} from "../src/lib/provider-failure.js"

/** True when the debit is held and the order parked; false when refunded. */
const holdsDebit = (error) => isIndeterminateProviderSubmissionError(error)

const PROVIDER_API_ERRORS = [
  "HUBNET_API_ERROR",
  "GODSWAY_API_ERROR",
  "GIGSHUB_API_ERROR",
  "PBMHUB_API_ERROR",
]

/* ------------------------- Never reached the provider --------------------- */

test("an open circuit breaker refunds, because no request was ever sent", () => {
  // The breaker rejects inside our own process. Holding the debit here parked
  // orders that never existed upstream - on every purchase for as long as the
  // breaker stayed open - and each one needed a manual refund.
  for (const errorCode of PROVIDER_API_ERRORS) {
    const error = createAppError(errorCode, { statusCode: null, upstreamCode: "CIRCUIT_OPEN" })
    assert.equal(holdsDebit(error), false, `${errorCode} via an open breaker must refund`)
  }
})

test("the breaker verdict wins over the missing status code", () => {
  // Both signals are present and they disagree: no status code says "maybe a
  // 5xx", CIRCUIT_OPEN says "nothing was sent". The latter is authoritative.
  const error = createAppError("PBMHUB_API_ERROR", { upstreamCode: "circuit_open" })
  assert.equal(holdsDebit(error), false)
})

/* --------------------------- Outcome genuinely unknown -------------------- */

test("a timeout or network error holds the debit", () => {
  // The request left the box; the provider may have accepted it. Refunding
  // could deliver the bundle and return the money.
  for (const upstreamCode of ["REQUEST_TIMEOUT", "NETWORK_ERROR"]) {
    assert.equal(holdsDebit(createAppError("PBMHUB_API_ERROR", { upstreamCode })), true, upstreamCode)
  }
})

test("PBM HUB's held-debit response holds the debit", () => {
  assert.equal(holdsDebit(createAppError("PBMHUB_SUBMISSION_PENDING", { statusCode: 202 })), true)
})

test("a provider 5xx, or an error with no status at all, holds the debit", () => {
  for (const errorCode of PROVIDER_API_ERRORS) {
    assert.equal(holdsDebit(createAppError(errorCode, { statusCode: 502 })), true, `${errorCode} 502`)
    assert.equal(holdsDebit(createAppError(errorCode, { statusCode: null })), true, `${errorCode} no status`)
  }
})

/* ----------------------------- Definitive failures ------------------------ */

test("a provider 4xx refunds - it is a definitive rejection", () => {
  for (const errorCode of PROVIDER_API_ERRORS) {
    assert.equal(holdsDebit(createAppError(errorCode, { statusCode: 400 })), false, `${errorCode} 400`)
  }
})

test("named provider failures refund rather than parking the order", () => {
  const definitive = [
    "INSUFFICIENT_PBMHUB_BALANCE",
    "PBMHUB_AUTH_FAILED",
    "PBMHUB_INVALID_PACKAGE",
    "PBMHUB_NETWORK_UNAVAILABLE",
    "PBMHUB_DUPLICATE_WINDOW",
    "GODSWAY_AUTH_FAILED",
    "INSUFFICIENT_HUBNET_BALANCE",
    "GIGSHUB_INVALID_PACKAGE",
    "PACKAGE_PROVIDER_MAPPING_MISSING",
  ]

  for (const errorCode of definitive) {
    assert.equal(holdsDebit(createAppError(errorCode, { statusCode: 400 })), false, errorCode)
  }
})

test("a bare error with nothing on it refunds rather than stranding money", () => {
  assert.equal(holdsDebit(new Error("something went wrong")), false)
  assert.equal(holdsDebit({}), false)
  assert.equal(holdsDebit(null), false)
})

/* ---------------------------------- Copy ---------------------------------- */

test("each provider is named in the pending message", () => {
  assert.match(getIndeterminateProviderSubmissionMessage("pbmhub"), /^PBM HUB /)
  assert.match(getIndeterminateProviderSubmissionMessage("godsway"), /^CK-Godsway /)
  assert.match(getIndeterminateProviderSubmissionMessage("hubnet"), /^Hubnet /)
  assert.match(getIndeterminateProviderSubmissionMessage("gigshub"), /^GiGSHUB /)
})

test("an unknown provider degrades to a generic label instead of throwing", () => {
  assert.match(getIndeterminateProviderSubmissionMessage("nope"), /^provider /)
  assert.match(getIndeterminateProviderSubmissionMessage(""), /^provider /)
})

test("the pending message tells the operator not to retry", () => {
  assert.match(getIndeterminateProviderSubmissionMessage("pbmhub"), /Do not retry/)
})
