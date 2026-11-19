import test from "node:test"
import assert from "node:assert/strict"
import { fetchWithRetry, CircuitBreaker, isProviderHealthFailure } from "../src/lib/http.js"

test("a timed-out purchase submission is never automatically replayed", async () => {
  const previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("Failed to fetch") }
  try {
    await assert.rejects(fetchWithRetry("https://example.invalid/purchase", { method: "POST" }, { maxRetries: 3, baseDelay: 0 }))
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = previous
  }
})

test("definitive 4xx answers do not open a provider's circuit breaker", async () => {
  const breaker = new CircuitBreaker(3, 60_000, "test")
  const clientError = Object.assign(new Error("Client error: invalid recipient"), { statusCode: 400 })
  for (let i = 0; i < 5; i++) await assert.rejects(breaker.call(async () => { throw clientError }))
  assert.equal(breaker.getState().state, "CLOSED")

  const serverError = Object.assign(new Error("Server error"), { statusCode: 502 })
  for (let i = 0; i < 3; i++) await assert.rejects(breaker.call(async () => { throw serverError }))
  assert.equal(breaker.getState().state, "OPEN")
})

test("rate limiting and timeouts still count as provider failures", () => {
  assert.equal(isProviderHealthFailure({ statusCode: 429 }), true)
  assert.equal(isProviderHealthFailure({ statusCode: 408 }), true)
  assert.equal(isProviderHealthFailure({ statusCode: 503 }), true)
  assert.equal(isProviderHealthFailure(new Error("ETIMEDOUT")), true)
  assert.equal(isProviderHealthFailure({ statusCode: 404 }), false)
  assert.equal(isProviderHealthFailure({ statusCode: 422 }), false)
})
