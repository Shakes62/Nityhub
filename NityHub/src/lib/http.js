import { CONFIG } from "../config.js"
import { logger } from "../logger.js"
import { createAppError, parseJsonText } from "./errors.js"

export class CircuitBreaker {
  constructor(threshold = 3, timeout = 10000, name = "unknown") {
    this.threshold = threshold
    this.timeout = timeout
    this.name = name
    this.failureCount = 0
    this.lastFailureTime = null
    this.state = "CLOSED"
    this.successCount = 0
  }

  async call(fn) {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = "HALF_OPEN"
        logger.info(`Circuit breaker ${this.name} transitioning to HALF_OPEN`)
      } else {
        logger.warn(`Circuit breaker ${this.name} is OPEN, rejecting request`)
        // Tagged so callers can tell a locally-rejected request from one that
        // actually reached the provider. Nothing was sent here, so the order
        // cannot be live upstream: the caller must fail (and refund) rather
        // than hold the debit as an uncertain outcome. The provider name is
        // kept out of the message because that message reaches buyers; it
        // travels in `breaker` for the logs instead.
        throw createAppError("Service temporarily unavailable. Please try again shortly.", {
          code: "CIRCUIT_OPEN",
          breaker: this.name,
        })
      }
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    this.failureCount = 0
    this.successCount++

    if (this.state === "HALF_OPEN") {
      this.state = "CLOSED"
      this.successCount = 0
      logger.info(`Circuit breaker ${this.name} recovered to CLOSED`)
    }
  }

  onFailure() {
    this.failureCount++
    this.lastFailureTime = Date.now()
    this.successCount = 0

    if (this.failureCount >= this.threshold) {
      this.state = "OPEN"
      logger.error(`Circuit breaker ${this.name} opened after ${this.failureCount} failures`)
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    }
  }
}

export const paystackCircuitBreaker = new CircuitBreaker(3, 10000, "paystack")
export const hubnetCircuitBreaker = new CircuitBreaker(3, 15000, "hubnet")
export const godswayCircuitBreaker = new CircuitBreaker(3, 15000, "godsway")
export const gigshubCircuitBreaker = new CircuitBreaker(3, 15000, "gigshub")
export const pbmhubCircuitBreaker = new CircuitBreaker(3, 15000, "pbmhub")

/**
 * @param config.includeResponseMeta  Resolve to `{ data, statusCode }` instead
 *   of the bare parsed body. PBM HUB needs it: it answers a network timeout
 *   with 202 and a held (not reversed) debit, which is the one 2xx that must
 *   never be treated as a completed purchase — and the status code is the only
 *   thing that distinguishes it. Off by default, so existing callers are
 *   unaffected.
 */
export const fetchWithRetry = async (url, options = {}, config = {}) => {
  const {
    maxRetries = CONFIG.maxRetries,
    baseDelay = CONFIG.baseDelay,
    maxDelay = CONFIG.maxDelay,
    timeout = CONFIG.requestTimeout,
    circuitBreaker = null,
    includeResponseMeta = false,
  } = config

  let lastError = null

  const executeRequest = async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)

        const fetchOptions = {
          ...options,
          signal: controller.signal,
          headers: {
            "User-Agent": "PBM-DataHub/5.0",
            Accept: "application/json",
            Connection: "keep-alive",
            ...options.headers,
          },
        }

        logger.debug(`Making request to ${url}`, { attempt: attempt + 1, maxRetries: maxRetries + 1 })

        const response = await fetch(url, fetchOptions)
        clearTimeout(timeoutId)

        if (!response.ok) {
          const errorText = await response.text()
          const errorData = parseJsonText(errorText, { message: errorText || `HTTP ${response.status}` })
          const errorMessage =
            errorData.message || errorData.reason || errorData.code || errorText || `HTTP ${response.status}`

          logger.error(`HTTP error ${response.status}`, errorData, { url, attempt })

          const requestError = createAppError(
            response.status >= 400 && response.status < 500 && response.status !== 429
              ? `Client error: ${errorMessage}`
              : `Server error: ${errorMessage}`,
            {
              statusCode: response.status,
              responseData: errorData,
              responseText: errorText,
              url,
            },
          )

          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw requestError
          }

          throw requestError
        }

        const text = await response.text()
        const data = parseJsonText(text, { raw: text })

        logger.debug(`Request successful`, { url, attempt: attempt + 1 })
        return includeResponseMeta ? { data, statusCode: response.status } : data
      } catch (error) {
        lastError = error

        if (error.name === "AbortError") {
          lastError = createAppError("Request timeout", { code: "REQUEST_TIMEOUT", url })
        } else if (error.message.includes("Failed to fetch")) {
          lastError = createAppError("Network error", { code: "NETWORK_ERROR", url })
        }

        logger.error(`Request attempt ${attempt + 1} failed`, error, { url })

        if (error.message.includes("Client error") || attempt === maxRetries) {
          break
        }

        const delay = Math.min(baseDelay * Math.pow(1.5, attempt), maxDelay)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    throw lastError || new Error("Request failed")
  }

  if (circuitBreaker) {
    return circuitBreaker.call(executeRequest)
  } else {
    return executeRequest()
  }
}
