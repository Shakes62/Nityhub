import express from "express"
import { fileURLToPath } from "url"
import path from "path"
import crypto from "crypto"
import fs from "fs"
import cors from "cors"
import compression from "compression"
import helmet from "helmet"

import { admin, db } from "./src/firebase.js"
import {
  CONFIG,
  normalizeUrl,
  APP_URL,
  SUPPORTED_PACKAGE_NETWORKS,
  SUPPORTED_PROVIDERS,
  DEFAULT_PROVIDER_ROUTING,
  TERMINAL_ORDER_STATUSES,
  ORDER_SYNC_LEASE_PATH,
  ORDER_SYNC_STATE_PATH,
  INSTANCE_ID,
  DEFAULT_AFA_REGISTRATION_FEE,
  PURCHASE_INTENT_PATH,
  DEFAULT_PACKAGE_CATALOG,
} from "./src/config.js"
import { logger } from "./src/logger.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.disable("x-powered-by")

app.set("trust proxy", 1)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  }),
)

app.use(
  compression({
    level: 3,
    threshold: 256,
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false
      return compression.filter(req, res)
    },
  }),
)

const allowedOrigins = new Set([
  CONFIG.frontendUrl,
  CONFIG.baseUrl,
  "https://buy.nityhub.online",
  "https://www.buy.nityhub.online",
  "http://127.0.0.1:5500",
  "https://nityhub.online",
  "https://www.nityhub.online",
  ...CONFIG.additionalAllowedOrigins,
].filter(Boolean))

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin) || CONFIG.nodeEnv === "development") {
      callback(null, true)
    } else {
      callback(null, false)
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Cache-Control",
    "X-Requested-With",
    "X-Request-Timestamp",
    "Accept",
    "Origin",
  ],
  credentials: true,
  maxAge: 86400,
  optionsSuccessStatus: 204,
}

app.use(
  cors(corsOptions),
)
app.options("*", cors(corsOptions))

app.use(
  express.json({
    limit: "256kb",
    strict: true,
    type: "application/json",
  }),
)

app.use(
  express.urlencoded({
    extended: false,
    limit: "256kb",
    parameterLimit: 100,
  }),
)

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-DNS-Prefetch-Control": "off",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
}

app.use((req, res, next) => {
  Object.entries(securityHeaders).forEach(([key, value]) => {
    res.setHeader(key, value)
  })
  next()
})

const rateLimitStore = new Map()
const scopedRateLimitStore = new Map()

function rateLimit(req, res, next) {
  const clientId = req.ip || "unknown"
  const now = Date.now()
  const windowStart = now - CONFIG.rateLimitWindow

  if (!rateLimitStore.has(clientId)) {
    rateLimitStore.set(clientId, [])
  }

  const requests = rateLimitStore.get(clientId)
  const validRequests = requests.filter((time) => time > windowStart)

  if (validRequests.length >= CONFIG.rateLimitMax) {
    return res.status(429).json({
      status: "error",
      message: "Too many requests",
      retryAfter: Math.ceil(CONFIG.rateLimitWindow / 1000),
    })
  }

  validRequests.push(now)
  rateLimitStore.set(clientId, validRequests)
  next()
}

app.use(rateLimit)

function createScopedRateLimit(name, { windowMs, max, keyFn }) {
  return (req, res, next) => {
    const keySource = typeof keyFn === "function" ? keyFn(req) : req.ip || "unknown"
    const key = `${name}:${String(keySource || "unknown")}`
    const now = Date.now()
    const threshold = now - windowMs
    const existing = scopedRateLimitStore.get(key) || []
    const valid = existing.filter((timestamp) => timestamp > threshold)

    if (valid.length >= max) {
      logger.warn("Scoped rate limit exceeded", {
        limiter: name,
        ip: req.ip,
        path: req.path,
        key: keySource,
      })
      return res.status(429).json({
        status: "error",
        message: "Too many requests for this action",
        retryAfter: Math.ceil(windowMs / 1000),
        timestamp: new Date().toISOString(),
      })
    }

    valid.push(now)
    scopedRateLimitStore.set(key, valid)
    next()
  }
}

const purchaseActionRateLimit = createScopedRateLimit("purchase_action", {
  windowMs: 60 * 1000,
  max: 10,
  keyFn: (req) => req.authUser?.uid || req.ip || "unknown",
})

const paymentVerificationRateLimit = createScopedRateLimit("payment_verification", {
  windowMs: 60 * 1000,
  max: 20,
  keyFn: (req) => req.params?.reference || req.ip || "unknown",
})

const adminMutationRateLimit = createScopedRateLimit("admin_mutation", {
  windowMs: 60 * 1000,
  max: 25,
  keyFn: (req) => req.authUser?.uid || req.ip || "unknown",
})

// Request signature validation middleware for transaction endpoints
function validateRequestSignature(req, res, next) {
  const transactionEndpoints = [
    '/api/process-wallet-purchase',
    '/api/process-telecel-purchase',
    '/api/verify-payment',
    '/api/retry-transaction'
  ]
  
  if (transactionEndpoints.some(endpoint => req.path.includes(endpoint))) {
    // Validate request timestamp (prevent replay attacks)
    const requestTime = Date.now()
    const timestamp = req.headers['x-request-timestamp']
    
    if (timestamp) {
      const timeDiff = Math.abs(requestTime - parseInt(timestamp))
      if (timeDiff > 300000) { // 5 minutes
        logger.warn("Request timestamp too old", { 
          timestamp, 
          requestTime, 
          timeDiff, 
          ip: req.ip,
          path: req.path 
        })
        return res.status(400).json({
          status: "error",
          message: "Request timestamp too old",
          timestamp: new Date().toISOString(),
        })
      }
    }
    
    // Validate user agent
    const userAgent = req.headers['user-agent']
    if (!userAgent || userAgent.length < 10) {
      logger.warn("Suspicious user agent", { 
        userAgent, 
        ip: req.ip, 
        path: req.path 
      })
      return res.status(400).json({
        status: "error",
        message: "Invalid request",
        timestamp: new Date().toISOString(),
      })
    }
    
    // Log transaction attempts for monitoring
    logger.info("Transaction endpoint accessed", {
      path: req.path,
      method: req.method,
      ip: req.ip,
      userAgent: userAgent?.substring(0, 50),
      timestamp: new Date().toISOString(),
    })
  }
  
  next()
}

app.use(validateRequestSignature)

const publicDir = path.join(__dirname, "public")
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true })
}

app.use(
  express.static(publicDir, {
    maxAge: CONFIG.nodeEnv === "production" ? "1d" : "1h",
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
      if (path.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache")
      }
    },
  }),
)

class TransactionStore {
  constructor() {
    this._store = new Map()
    this._maxAge = 6 * 60 * 60 * 1000
    this._maxSize = 2000
    this.setupPeriodicCleanup()
  }

  setupPeriodicCleanup() {
    setInterval(() => {
      this.cleanup()
      this.memoryCleanup()
    }, CONFIG.cacheCleanupInterval)
  }

  memoryCleanup() {
    if (this._store.size > this._maxSize) {
      const entries = Array.from(this._store.entries())
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
      const toDelete = entries.slice(0, this._store.size - this._maxSize)
      toDelete.forEach(([key]) => this._store.delete(key))
    }
  }

  has(reference) {
    return this._store.has(reference)
  }

  add(reference, metadata = {}) {
    this._store.set(reference, {
      timestamp: Date.now(),
      ...metadata,
    })
    return this
  }

  get(reference) {
    return this._store.get(reference)
  }

  cleanup(maxAgeMs = this._maxAge) {
    const now = Date.now()
    let count = 0

    for (const [reference, metadata] of this._store.entries()) {
      if (now - metadata.timestamp > maxAgeMs) {
        this._store.delete(reference)
        count++
      }
    }

    return count
  }
}

const processedTransactions = new TransactionStore()

// Duplicate attempt monitoring
const duplicateAttempts = new Map()
const MAX_DUPLICATE_ATTEMPTS = 5
const DUPLICATE_ATTEMPT_WINDOW = 10 * 60 * 1000 // 10 minutes

function recordDuplicateAttempt(identifier, type = 'transaction') {
  const key = `${type}_${identifier}`
  const now = Date.now()
  
  if (!duplicateAttempts.has(key)) {
    duplicateAttempts.set(key, [])
  }
  
  const attempts = duplicateAttempts.get(key)
  attempts.push(now)
  
  // Keep only attempts within the window
  const validAttempts = attempts.filter(time => now - time < DUPLICATE_ATTEMPT_WINDOW)
  duplicateAttempts.set(key, validAttempts)
  
  // Log suspicious activity
  if (validAttempts.length >= MAX_DUPLICATE_ATTEMPTS) {
    logger.error("SUSPICIOUS DUPLICATE ATTEMPTS DETECTED", {
      identifier,
      type,
      attempts: validAttempts.length,
      window: DUPLICATE_ATTEMPT_WINDOW,
      timestamp: new Date().toISOString(),
    })
  }
  
  return validAttempts.length
}

function checkDuplicateAttempts(identifier, type = 'transaction') {
  const key = `${type}_${identifier}`
  const attempts = duplicateAttempts.get(key) || []
  const now = Date.now()
  const validAttempts = attempts.filter(time => now - time < DUPLICATE_ATTEMPT_WINDOW)
  
  return {
    count: validAttempts.length,
    isSuspicious: validAttempts.length >= MAX_DUPLICATE_ATTEMPTS,
    lastAttempt: validAttempts.length > 0 ? validAttempts[validAttempts.length - 1] : null
  }
}

// Enhanced transaction locking mechanism with multiple lock types
const transactionLocks = new Map()
const phoneTransactionLocks = new Map()
const userTransactionLocks = new Map()

function acquireTransactionLock(reference, timeout = 30000) {
  if (transactionLocks.has(reference)) {
    const lockTime = transactionLocks.get(reference)
    if (Date.now() - lockTime < timeout) {
      return false // Lock still active
    }
  }

  transactionLocks.set(reference, Date.now())
  return true
}

function acquirePhoneTransactionLock(phone, volume, network, timeout = 45000) {
  const phoneKey = `${phone}_${volume}_${network}`
  if (phoneTransactionLocks.has(phoneKey)) {
    const lockTime = phoneTransactionLocks.get(phoneKey)
    if (Date.now() - lockTime < timeout) {
      return false // Lock still active for this phone+volume+network
    }
  }

  phoneTransactionLocks.set(phoneKey, Date.now())
  return true
}

function acquireUserTransactionLock(userId, timeout = 30000) {
  if (userTransactionLocks.has(userId)) {
    const lockTime = userTransactionLocks.get(userId)
    if (Date.now() - lockTime < timeout) {
      return false // User has active transaction
    }
  }

  userTransactionLocks.set(userId, Date.now())
  return true
}

function releaseTransactionLock(reference) {
  transactionLocks.delete(reference)
}

function releasePhoneTransactionLock(phone, volume, network) {
  const phoneKey = `${phone}_${volume}_${network}`
  phoneTransactionLocks.delete(phoneKey)
}

function releaseUserTransactionLock(userId) {
  userTransactionLocks.delete(userId)
}

// Cleanup expired locks periodically
setInterval(() => {
  const now = Date.now()
  const timeout = 30000 // 30 seconds
  const phoneTimeout = 45000 // 45 seconds for phone locks

  // Cleanup transaction locks
  for (const [reference, lockTime] of transactionLocks.entries()) {
    if (now - lockTime > timeout) {
      transactionLocks.delete(reference)
    }
  }

  // Cleanup phone transaction locks
  for (const [phoneKey, lockTime] of phoneTransactionLocks.entries()) {
    if (now - lockTime > phoneTimeout) {
      phoneTransactionLocks.delete(phoneKey)
    }
  }

  // Cleanup user transaction locks
  for (const [userId, lockTime] of userTransactionLocks.entries()) {
    if (now - lockTime > timeout) {
      userTransactionLocks.delete(userId)
    }
  }
}, 60000) // Run every minute

function generateReference(prefix = "DATA") {
  const timestamp = Date.now()
  const random = crypto.randomBytes(2).toString("hex")
  return `${prefix}_${timestamp}_${random}`
}

class CircuitBreaker {
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
        throw new Error(`Service temporarily unavailable - ${this.name}`)
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

const paystackCircuitBreaker = new CircuitBreaker(3, 10000, "paystack")
const hubnetCircuitBreaker = new CircuitBreaker(3, 15000, "hubnet")
const godswayCircuitBreaker = new CircuitBreaker(3, 15000, "godsway")
const gigshubCircuitBreaker = new CircuitBreaker(3, 15000, "gigshub")

function createAppError(code, details = {}) {
  const error = new Error(code)
  error.code = code
  Object.assign(error, details)
  return error
}

function getErrorCode(error) {
  return String(error?.code || error?.message || "").trim()
}

function parseJsonText(text, fallback = {}) {
  if (!text) {
    return fallback
  }

  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

const fetchWithRetry = async (url, options = {}, config = {}) => {
  const {
    maxRetries = CONFIG.maxRetries,
    baseDelay = CONFIG.baseDelay,
    maxDelay = CONFIG.maxDelay,
    timeout = CONFIG.requestTimeout,
    circuitBreaker = null,
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
        return data
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

function normalizeHubnetSuccessValue(value) {
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

function isHubnetSuccessfulResponse(data) {
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

function getHubnetResponseSummary(data = {}, fallbackMessage = "") {
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

function classifyHubnetFailure(data = {}, fallbackMessage = "") {
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
    normalized.includes("429")
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

function resolveHubnetWebhookUrl() {
  const configuredWebhookUrl = String(CONFIG.hubnetWebhookUrl || "").trim()
  if (configuredWebhookUrl) {
    try {
      const target = new URL(configuredWebhookUrl)
      if (!target.pathname || target.pathname === "/") {
        target.pathname = "/webhook"
      }
      target.searchParams.set("provider", "hubnet")
      target.searchParams.set("source", "hubnet")
      target.searchParams.set("service", "hubnet")
      if (CONFIG.providerWebhookSecret) {
        target.searchParams.set("token", CONFIG.providerWebhookSecret)
      }
      return target.toString()
    } catch {
      return configuredWebhookUrl
    }
  }

  const fallbackBaseUrl = String(CONFIG.baseUrl || "").trim()
  if (!fallbackBaseUrl) {
    return null
  }

  try {
    const target = new URL(`${fallbackBaseUrl.replace(/\/$/, "")}/webhook`)
    target.searchParams.set("provider", "hubnet")
    target.searchParams.set("service", "hubnet")
    if (CONFIG.providerWebhookSecret) {
      target.searchParams.set("token", CONFIG.providerWebhookSecret)
    }
    return target.toString()
  } catch {
    return null
  }
}

function normalizeUrlPathname(value) {
  const safeValue = String(value || "/").trim()
  return safeValue.replace(/\/+$/, "") || "/"
}

function parseUrlSafe(value) {
  try {
    return new URL(String(value || "").trim())
  } catch {
    return null
  }
}

function isKnownAppOriginUrl(value) {
  const target = parseUrlSafe(value)
  if (!target) {
    return false
  }

  const appOrigins = [APP_URL, CONFIG.baseUrl, CONFIG.frontendUrl]
    .map((item) => parseUrlSafe(item))
    .filter(Boolean)
    .map((item) => item.origin)

  return appOrigins.includes(target.origin)
}

function resolveHubnetStatusBaseUrl() {
  const configuredStatusUrl = normalizeUrl(CONFIG.hubnetStatusUrl)
  if (!configuredStatusUrl || isKnownAppOriginUrl(configuredStatusUrl)) {
    return ""
  }

  return configuredStatusUrl
}

function resolveGodswayStatusBaseUrl() {
  const configuredStatusUrl = normalizeUrl(CONFIG.godswayStatusUrl)
  const fallbackStatusUrl = `${normalizeUrl(CONFIG.godswayBaseUrl)}/order-status`
  if (!configuredStatusUrl) {
    return fallbackStatusUrl
  }

  if (isKnownAppOriginUrl(configuredStatusUrl)) {
    return ""
  }

  const configured = parseUrlSafe(configuredStatusUrl)
  const base = parseUrlSafe(CONFIG.godswayBaseUrl)
  if (
    configured &&
    base &&
    configured.origin === base.origin &&
    normalizeUrlPathname(configured.pathname) === normalizeUrlPathname(base.pathname)
  ) {
    return fallbackStatusUrl
  }

  return configuredStatusUrl
}

function resolveGodswayWebhookUrl() {
  const baseUrl = String(CONFIG.baseUrl || "").trim()
  if (!baseUrl) {
    return null
  }

  try {
    const target = new URL(`${baseUrl.replace(/\/$/, "")}/webhook`)
    target.searchParams.set("provider", "godsway")
    target.searchParams.set("source", "godsway")
    target.searchParams.set("service", "godsway")
    if (CONFIG.providerWebhookSecret) {
      target.searchParams.set("token", CONFIG.providerWebhookSecret)
    }
    return target.toString()
  } catch {
    return null
  }
}

function resolveGigshubWebhookUrl() {
  const baseUrl = String(CONFIG.baseUrl || "").trim()
  if (!baseUrl) {
    return null
  }

  try {
    return new URL(`${baseUrl.replace(/\/$/, "")}/webhook/gigshub`).toString()
  } catch {
    return null
  }
}

async function checkGigshubBalance() {
  const baseUrl = String(CONFIG.gigshubBaseUrl || "").replace(/\/$/, "")
  let data
  try {
    data = await fetchWithRetry(
      `${baseUrl}/balance`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${CONFIG.gigshubApiKey}`,
          "Content-Type": "application/json",
        },
      },
      {
        circuitBreaker: gigshubCircuitBreaker,
        timeout: 8000,
      },
    )
  } catch (error) {
    const failure = classifyGigshubFailure(error?.responseData, error?.message)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: error?.responseData || null,
      statusCode: error?.statusCode || null,
    })
  }

  if (!data?.success) {
    const failure = classifyGigshubFailure(data)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: data,
    })
  }

  return data
}

async function initializePaystackPayment(payload) {
  return await fetchWithRetry(
    "https://api.paystack.co/transaction/initialize",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.paystackSecretKey}`,
      },
      body: JSON.stringify(payload),
    },
    {
      circuitBreaker: paystackCircuitBreaker,
      timeout: 8000,
      maxRetries: 2,
    },
  )
}

async function verifyPaystackPayment(reference) {
  return await fetchWithRetry(
    `https://api.paystack.co/transaction/verify/${reference}`,
    {
      headers: {
        Authorization: `Bearer ${CONFIG.paystackSecretKey}`,
        "Cache-Control": "no-cache",
      },
    },
    {
      circuitBreaker: paystackCircuitBreaker,
      timeout: 10000,
      maxRetries: 3,
    },
  )
}

async function checkHubnetBalance() {
  try {
    const data = await fetchWithRetry(
      "https://console.hubnet.app/live/api/context/business/transaction/check_balance",
      {
        method: "GET",
        headers: {
          token: `Bearer ${CONFIG.hubnetApiKey}`,
          "Content-Type": "application/json",
        },
      },
      {
        circuitBreaker: hubnetCircuitBreaker,
        timeout: 8000,
      },
    )

    if (!isHubnetSuccessfulResponse(data)) {
      const failure = classifyHubnetFailure(data)
      throw createAppError(failure.code, {
        providerMessage: failure.message,
        providerResponse: data,
      })
    }

    return data
  } catch (error) {
    const failure = classifyHubnetFailure(error?.responseData, error?.message)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: error?.responseData || null,
      statusCode: error?.statusCode || null,
    })
  }
}

function normalizeNetwork(network) {
  return String(network || "").trim().toLowerCase()
}

function normalizePurchaseNetwork(network) {
  const safeNetwork = normalizeNetwork(network)
  return safeNetwork === "big-time" ? "at" : safeNetwork
}

function normalizeProvider(value, fallback = "") {
  const provider = String(value || "").trim().toLowerCase()
  return SUPPORTED_PROVIDERS.includes(provider) ? provider : fallback
}

function normalizeProviderRoutingValue(network, value) {
  return normalizeProvider(value, DEFAULT_PROVIDER_ROUTING[normalizeNetwork(network)] || "hubnet")
}

function formatGodswayCapacityFromVolume(volume) {
  const amount = Number(volume || 0)
  if (!Number.isFinite(amount) || amount <= 0) {
    return ""
  }

  const inGb = amount / 1000
  if (Number.isInteger(inGb)) {
    return String(inGb)
  }

  return String(Math.round((inGb + Number.EPSILON) * 100) / 100).replace(/\.0+$/, "")
}

function buildDefaultProviderMappings(network, volume) {
  const safeNetwork = normalizeNetwork(network)
  const defaultGodswayNetworkKey =
    safeNetwork === "mtn" ? "YELLO" : safeNetwork === "telecel" ? "TELECEL" : ""

  return {
    hubnet: {
      network: safeNetwork,
      volume: volume > 0 ? String(volume) : "",
    },
    godsway: {
      networkKey: defaultGodswayNetworkKey,
      capacity: formatGodswayCapacityFromVolume(volume),
    },
    gigshub: {
      packageId: "",
    },
  }
}

function normalizeProviderMappings(network, rawMappings = {}, volume = 0) {
  const defaults = buildDefaultProviderMappings(network, volume)
  const source =
    rawMappings && typeof rawMappings === "object" && !Array.isArray(rawMappings) ? rawMappings : {}

  return {
    hubnet: {
      network: normalizeNetwork(source?.hubnet?.network || defaults.hubnet.network),
      volume: String(source?.hubnet?.volume || defaults.hubnet.volume || "").trim(),
    },
    godsway: {
      networkKey: String(source?.godsway?.networkKey || defaults.godsway.networkKey || "")
        .trim()
        .toUpperCase(),
      capacity: String(source?.godsway?.capacity || defaults.godsway.capacity || "").trim(),
    },
    gigshub: {
      packageId: String(source?.gigshub?.packageId || defaults.gigshub.packageId || "").trim(),
    },
  }
}

function isCompleteProviderMapping(network, provider, catalogEntry) {
  const providerMappings = normalizeProviderMappings(network, catalogEntry?.providerMappings, catalogEntry?.volume)

  if (provider === "hubnet") {
    return Boolean(providerMappings.hubnet.network)
  }

  if (provider === "godsway") {
    return Boolean(providerMappings.godsway.networkKey && providerMappings.godsway.capacity)
  }

  if (provider === "gigshub") {
    return Boolean(providerMappings.gigshub.packageId)
  }

  return false
}

function getPackageProviderMapping(network, provider, catalogEntry) {
  const safeProvider = normalizeProvider(provider)
  const providerMappings = normalizeProviderMappings(network, catalogEntry?.providerMappings, catalogEntry?.volume)
  const mapping = providerMappings[safeProvider] || null

  if (!mapping || !isCompleteProviderMapping(network, safeProvider, catalogEntry)) {
    throw createAppError("PACKAGE_PROVIDER_MAPPING_MISSING", {
      network: normalizeNetwork(network),
      provider: safeProvider,
      packageId: catalogEntry?.id || null,
      providerMappings,
    })
  }

  return mapping
}

function isTerminalOrderStatus(status) {
  return TERMINAL_ORDER_STATUSES.has(normalizeInternalOrderStatus(status, ""))
}

function normalizeInternalOrderStatus(value, fallback = "pending") {
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

function getOrderStatusPriority(status) {
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

function sanitizeGodswayProviderOrderNumber(value, appReference = "") {
  const safeValue = String(value || "").trim()
  const safeAppReference = String(appReference || "").trim()
  if (!safeValue) {
    return ""
  }

  if (safeAppReference) {
    const lowerValue = safeValue.toLowerCase()
    const lowerAppReference = safeAppReference.toLowerCase()
    if (
      lowerValue === lowerAppReference ||
      lowerValue === `godsway-${lowerAppReference}` ||
      lowerValue.includes(lowerAppReference)
    ) {
      return ""
    }
  }

  return safeValue
}

function resolveStoredProviderOrderNumber(provider, value, appReference = "") {
  const safeProvider = normalizeProvider(provider)
  const safeValue = String(value || "").trim()
  if (!safeValue) {
    return null
  }

  if (safeProvider === "godsway") {
    return sanitizeGodswayProviderOrderNumber(safeValue, appReference) || null
  }

  return safeValue
}

function resolveStoredProviderReference(provider, value, appReference = "", providerOrderNumber = "") {
  const safeProvider = normalizeProvider(provider)
  if (safeProvider === "godsway") {
    return sanitizeGodswayProviderOrderNumber(value || providerOrderNumber, appReference)
  }

  return String(value || appReference || "").trim()
}

function parseUtcDateBoundary(value, boundary = "start") {
  const raw = String(value || "").trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) {
    return null
  }

  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  const day = Number(match[3])
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || !Number.isInteger(day)) {
    return null
  }

  const probe = new Date(Date.UTC(year, monthIndex, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== monthIndex ||
    probe.getUTCDate() !== day
  ) {
    return null
  }

  return boundary === "end"
    ? Date.UTC(year, monthIndex, day, 23, 59, 59, 999)
    : Date.UTC(year, monthIndex, day, 0, 0, 0, 0)
}

function getPurchaseIntentSubmissionStatusForOrderStatus(status) {
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

function getProviderLegacyResponseField(provider) {
  return provider === "hubnet" ? "hubnetResponse" : provider === "godsway" ? "godswayResponse" : null
}

function getGodswayResponseSummary(data = {}, fallbackMessage = "") {
  return [
    data?.error,
    data?.message,
    data?.reason,
    data?.data?.statusDescription,
    data?.data?.status,
    fallbackMessage,
  ]
    .filter(Boolean)
    .join(" | ")
}

function getGigshubResponseSummary(data = {}, fallbackMessage = "") {
  return [data?.error, data?.message, fallbackMessage].filter(Boolean).join(" | ")
}

function classifyGigshubFailure(data = {}, fallbackMessage = "") {
  const summary = getGigshubResponseSummary(data, fallbackMessage)
  const normalized = summary.toLowerCase()

  if (
    normalized.includes("missing or invalid authorization") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("api key") ||
    normalized.includes("invalid token")
  ) {
    return {
      code: "GIGSHUB_AUTH_FAILED",
      message: "GiGSHUB API authentication failed. Update GIGSHUB_API_KEY.",
    }
  }

  if (normalized.includes("insufficient balance")) {
    return {
      code: "INSUFFICIENT_GIGSHUB_BALANCE",
      message: "Service provider has insufficient balance",
    }
  }

  if (normalized.includes("rate limit") || normalized.includes("429") || normalized.includes("too many")) {
    return {
      code: "GIGSHUB_RATE_LIMITED",
      message: "GiGSHUB API rate limit reached. Please try again shortly.",
    }
  }

  if (normalized.includes("product not found") || normalized.includes("invalid package")) {
    return {
      code: "GIGSHUB_INVALID_PACKAGE",
      message: "GiGSHUB rejected the selected package. Check the package ID configuration.",
    }
  }

  return {
    code: "GIGSHUB_API_ERROR",
    message: summary || "GiGSHUB transaction failed",
  }
}

function getGigshubStatusDetails(data = {}) {
  const rawStatusCandidate = firstNonEmptyText([
    data?.order?.status,
    data?.data?.status,
    data?.status,
  ])
  const providerStatusDescription = firstNonEmptyText([data?.message, data?.error])
  // Map partial_failure to failed before normalization
  const statusForNormalization = rawStatusCandidate === "partial_failure" ? "failed" : rawStatusCandidate
  const rawStatus = rawStatusCandidate || (data?.success === false ? "failed" : "processing")
  const normalizedStatus = normalizeInternalOrderStatus(
    statusForNormalization,
    data?.success === false ? "failed" : "processing",
  )

  return {
    providerStatusRaw: rawStatus,
    providerStatusDescription: providerStatusDescription || rawStatus,
    normalizedStatus,
  }
}

function classifyGodswayFailure(data = {}, fallbackMessage = "") {
  const summary = getGodswayResponseSummary(data, fallbackMessage)
  const normalized = summary.toLowerCase()

  if (
    normalized.includes("invalid api") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("api key")
  ) {
    return {
      code: "GODSWAY_AUTH_FAILED",
      message: "Godsway API authentication failed. Update GODSWAY_API_KEY.",
    }
  }

  if (normalized.includes("insufficient")) {
    return {
      code: "INSUFFICIENT_GODSWAY_BALANCE",
      message: "Service provider has insufficient balance",
    }
  }

  if (normalized.includes("rate limit") || normalized.includes("429") || normalized.includes("too many")) {
    return {
      code: "GODSWAY_RATE_LIMITED",
      message: "Godsway API rate limit reached. Please try again shortly.",
    }
  }

  if (normalized.includes("network")) {
    return {
      code: "GODSWAY_INVALID_NETWORK",
      message: "Godsway rejected the selected network",
    }
  }

  if (normalized.includes("capacity") || normalized.includes("bundle")) {
    return {
      code: "GODSWAY_INVALID_CAPACITY",
      message: "Godsway rejected the selected bundle size",
    }
  }

  return {
    code: "GODSWAY_API_ERROR",
    message: summary || "Godsway transaction failed",
  }
}

function getGodswayStatusDetails(data = {}) {
  const rawStatusCandidate = firstNonEmptyText([
    data?.data?.status,
    data?.status,
    data?.data?.orderStatus,
    data?.orderStatus,
    data?.data?.state,
    data?.state,
  ])
  const providerStatusDescription = firstNonEmptyText([
    data?.data?.statusDescription,
    data?.statusDescription,
    data?.data?.message,
    data?.message,
    data?.error,
    data?.reason,
  ])
  const rawStatus =
    (["true", "false"].includes(String(rawStatusCandidate).toLowerCase()) ? "" : rawStatusCandidate) ||
    providerStatusDescription ||
    (data?.success === false ? "FAILED" : "INITIATED")
  const normalizedStatus = normalizeInternalOrderStatus(
    rawStatus,
    data?.success === false ? "failed" : normalizeInternalOrderStatus(providerStatusDescription, "accepted"),
  )

  return {
    providerStatusRaw: rawStatus,
    providerStatusDescription,
    normalizedStatus,
  }
}

function isGodswayStatusEndpointUnavailable(error = {}) {
  const statusCode = Number(error?.statusCode || 0)
  const responseText = String(error?.responseText || "").toLowerCase()
  const responseMessage = String(error?.responseData?.message || error?.responseData?.error || "").toLowerCase()

  if (statusCode === 404) {
    return true
  }

  if (responseText.includes("<!doctype html") || responseText.includes("<html")) {
    return responseText.includes("page not found") || responseText.includes("404")
  }

  return responseMessage.includes("page not found") || responseMessage.includes("404")
}

function getHubnetStatusDetails(data = {}, fallbackStatus = "accepted") {
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

function sanitizeProviderMeta(provider, value = {}) {
  const source = value && typeof value === "object" ? value : {}

  if (provider === "hubnet") {
    return {
      transactionId: source.transactionId || source.transaction_id || source?.data?.transaction_id || null,
      message: getHubnetResponseSummary(source),
    }
  }

  if (provider === "godsway") {
    return {
      orderNumber: source.orderNumber || source?.data?.orderNumber || null,
      status: source.status || source?.data?.status || null,
      statusDescription: source.statusDescription || source?.data?.statusDescription || null,
    }
  }

  if (provider === "gigshub") {
    return {
      reference: source.reference || source?.order?.reference || null,
      status: source.status || source?.order?.status || null,
    }
  }

  return {}
}

function toMoneyNumber(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.round((parsed + Number.EPSILON) * 100) / 100
}

function toMoneyUnits(value, fallback = 0) {
  const normalized = toMoneyNumber(value, fallback)
  return Number.isFinite(normalized) ? Math.round(normalized * 100) : Math.round(fallback * 100)
}

function fromMoneyUnits(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.round(parsed) / 100
}

function sanitizeCatalogId(value, fallback = "package") {
  const source = String(value || fallback).trim().toLowerCase()
  return source.replace(/[^a-z0-9-_]/g, "-") || fallback
}

function defaultPackageLabel(volume) {
  if (!volume) return "Package"
  return volume % 1000 === 0 ? `${volume / 1000}GB` : `${volume}MB`
}

function normalizeCatalogEntry(raw, fallbackId = "", network = "") {
  const volume = Number(raw?.volume || 0)
  if (!Number.isFinite(volume) || volume <= 0) {
    return null
  }

  const userPrice = toMoneyNumber(raw?.userPrice ?? raw?.price, 0)
  const agentPrice = toMoneyNumber(raw?.agentPrice ?? raw?.userPrice ?? raw?.price, userPrice)
  const label = String(raw?.label || defaultPackageLabel(volume)).trim()
  const idBase = raw?.id || fallbackId || `${volume}-${Math.round(userPrice * 100)}`

  const normalized = {
    id: sanitizeCatalogId(idBase, `${volume}-${Math.round(userPrice * 100)}`),
    label,
    volume,
    userPrice,
    agentPrice,
    enabled: raw?.enabled !== false,
    sortOrder: Number(raw?.sortOrder || volume),
    updatedAt: toTimestampValue(raw?.updatedAt, Date.now()) || Date.now(),
    providerMappings: normalizeProviderMappings(network, raw?.providerMappings, volume),
  }

  if (raw?.updatedBy) {
    normalized.updatedBy = raw.updatedBy
  }

  return normalized
}

function getCatalogRef(network) {
  return db.ref(`catalog/packages/${network}`)
}

function toPublicCatalogEntry(entry) {
  const {
    providerMappings,
    updatedBy,
    ...publicEntry
  } = entry || {}

  return publicEntry
}

function getProviderRoutingRef() {
  return db.ref("settings/providers/routing")
}

function normalizeProviderRouting(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {}
  const normalized = {}

  for (const network of SUPPORTED_PACKAGE_NETWORKS) {
    normalized[network] = normalizeProviderRoutingValue(network, source?.[network])
  }

  return normalized
}

async function ensureProviderRoutingSettings() {
  const ref = getProviderRoutingRef()
  const snapshot = await ref.once("value")
  const current = snapshot.exists() ? snapshot.val() : {}
  const normalized = normalizeProviderRouting(current)
  const hasChanges = SUPPORTED_PACKAGE_NETWORKS.some((network) => normalized[network] !== current?.[network])

  if (hasChanges || !snapshot.exists()) {
    await ref.set({
      ...normalized,
      updatedAt: Date.now(),
      updatedBy: current?.updatedBy || "system",
    })
  }

  return normalized
}

async function getProviderRoutingConfig() {
  const snapshot = await getProviderRoutingRef().once("value")
  return normalizeProviderRouting(snapshot.exists() ? snapshot.val() : {})
}

async function getActiveProviderForNetwork(network) {
  const routing = await getProviderRoutingConfig()
  return normalizeProviderRoutingValue(network, routing[normalizeNetwork(network)])
}

async function normalizeCatalogPackages() {
  for (const network of SUPPORTED_PACKAGE_NETWORKS) {
    const ref = getCatalogRef(network)
    const snapshot = await ref.once("value")
    const current = snapshot.exists() ? snapshot.val() : {}
    const normalizedMap = {}
    const existingVolumes = new Set()

    Object.entries(current || {}).forEach(([key, value]) => {
      const normalized = normalizeCatalogEntry({ ...(value || {}), id: value?.id || key }, key, network)
      if (!normalized) {
        return
      }

      normalizedMap[key] = normalized
      existingVolumes.add(normalized.volume)
    })

    for (const fallbackRow of DEFAULT_PACKAGE_CATALOG[network] || []) {
      if (existingVolumes.has(Number(fallbackRow.volume))) {
        continue
      }

      const normalized = normalizeCatalogEntry(fallbackRow, fallbackRow.id, network)
      if (!normalized) {
        continue
      }

      normalizedMap[normalized.id] = normalized
      existingVolumes.add(normalized.volume)
    }

    const currentKeys = Object.keys(current || {})
    const normalizedKeys = Object.keys(normalizedMap)
    let changed = currentKeys.length !== normalizedKeys.length

    if (!changed) {
      for (const key of normalizedKeys) {
        const before = current[key] || {}
        const after = normalizedMap[key] || {}
        const fieldsToCompare = [
          "id",
          "label",
          "volume",
          "userPrice",
          "agentPrice",
          "enabled",
          "sortOrder",
          "updatedAt",
          "updatedBy",
          "providerMappings",
        ]

        const hasMismatch = fieldsToCompare.some((field) => {
          const beforeValue =
            before[field] && typeof before[field] === "object" ? JSON.stringify(before[field]) : before[field] == null ? null : before[field]
          const afterValue =
            after[field] && typeof after[field] === "object" ? JSON.stringify(after[field]) : after[field] == null ? null : after[field]
          return beforeValue !== afterValue
        })

        if (hasMismatch) {
          changed = true
          break
        }
      }
    }

    if (changed) {
      await ref.set(normalizedMap)
    }

    logger.info("Package catalog ready", {
      network,
      changed,
      totalRows: normalizedKeys.length,
    })
  }
}

async function getCatalogPackages(network, { includeDisabled = false } = {}) {
  const safeNetwork = normalizeNetwork(network)
  if (!SUPPORTED_PACKAGE_NETWORKS.includes(safeNetwork)) {
    throw new Error("Unsupported network")
  }

  const snapshot = await getCatalogRef(safeNetwork).once("value")
  const rows = snapshot.exists()
    ? Object.entries(snapshot.val())
        .map(([key, value]) => normalizeCatalogEntry({ ...(value || {}), id: value?.id || key }, key, safeNetwork))
        .filter(Boolean)
    : []

  const filtered = includeDisabled ? rows : rows.filter((item) => item.enabled !== false)
  return filtered.sort((a, b) => Number(a.sortOrder || a.volume) - Number(b.sortOrder || b.volume))
}

async function getCatalogPackage(network, { packageId = "", volume = 0 } = {}) {
  const rows = await getCatalogPackages(network, { includeDisabled: true })
  const safeId = sanitizeCatalogId(packageId || "", "")
  const numericVolume = Number(volume || 0)

  if (safeId) {
    const byId = rows.find((item) => item.id === safeId)
    if (byId) return byId
  }

  if (numericVolume > 0) {
    return rows.find((item) => Number(item.volume) === numericVolume) || null
  }

  return null
}

async function getUserProfileRecord(uid) {
  const snapshot = await db.ref(`users/${uid}`).once("value")
  return snapshot.exists() ? snapshot.val() : {}
}

async function getUserWalletRecord(uid) {
  const snapshot = await db.ref(`wallets/${uid}`).once("value")
  const wallet = snapshot.exists() ? snapshot.val() || {} : {}

  return {
    balance: toMoneyNumber(wallet.balance, 0),
    updatedAt: toTimestampValue(wallet.updatedAt, null),
  }
}

async function getUserOrdersList(uid, { limit = 100 } = {}) {
  const snapshot = await db.ref(`orders/${uid}`).once("value")
  const rows = snapshot.exists() ? Object.values(snapshot.val() || {}) : []

  return rows
    .map((item) =>
      normalizeStoredOrderRecord({
        ...item,
        amount: toMoneyNumber(item?.amount, 0),
      }),
    )
    .sort((a, b) => Number(b.timestamp || b.createdAt || 0) - Number(a.timestamp || a.createdAt || 0))
    .slice(0, Math.min(Math.max(Number(limit || 0), 1), 200))
}

async function getUserTransactionsList(uid, { limit = 50 } = {}) {
  const snapshot = await db.ref("transactions").orderByChild("userId").equalTo(uid).once("value")
  const rows = snapshot.exists() ? Object.values(snapshot.val() || {}) : []

  return rows
    .map((item) => ({
      ...item,
      amount: toMoneyNumber(item?.amount, 0),
      balance: toMoneyNumber(item?.balance, 0),
    }))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, Math.min(Math.max(Number(limit || 0), 1), 200))
    .map((item) => toPublicTransactionRecord(item))
}

async function getUserDashboardData(uid) {
  const [wallet, orders] = await Promise.all([
    getUserWalletRecord(uid),
    getUserOrdersList(uid, { limit: 200 }),
  ])

  const validOrders = orders.filter((item) => item?.refunded !== true && String(item?.status || "").toLowerCase() !== "failed")
  const totalSales = validOrders.reduce((sum, item) => sum + toMoneyNumber(item.amount, 0), 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStart = today.getTime()

  const todaysOrders = validOrders.filter((item) => Number(item.timestamp || item.createdAt || 0) >= todayStart)
  const todaysCustomers = new Set(
    todaysOrders
      .map((item) => sanitizePhoneNumber(item.phone || ""))
      .filter(Boolean),
  )
  const todaySales = todaysOrders.reduce((sum, item) => sum + toMoneyNumber(item.amount, 0), 0)

  return {
    balance: wallet.balance,
    walletUpdatedAt: wallet.updatedAt,
    ordersCount: validOrders.length,
    totalSales: toMoneyNumber(totalSales, 0),
    todayOrders: todaysOrders.length,
    todaySales: toMoneyNumber(todaySales, 0),
    todayCustomers: todaysCustomers.size,
  }
}

async function getAdminOverviewData() {
  const [usersSnap, walletsSnap, ordersSnap, transactionsSnap, afaSnap] = await Promise.all([
    db.ref("users").once("value"),
    db.ref("wallets").once("value"),
    db.ref("orders").once("value"),
    db.ref("transactions").once("value"),
    db.ref("afa_registrations").once("value"),
  ])

  const roleFlagBackfillUpdates = {}
  const roleFlagBackfillTimestamp = Date.now()
  const users = usersSnap.exists()
    ? Object.entries(usersSnap.val() || {}).map(([id, value]) => {
        const safeValue = value || {}
        const hasAgentFlag = Object.prototype.hasOwnProperty.call(safeValue, "isagent")
        const hasAdminFlag = Object.prototype.hasOwnProperty.call(safeValue, "isadmin")

        if (!hasAgentFlag) {
          roleFlagBackfillUpdates[`users/${id}/isagent`] = safeValue.isagent === true
        }

        if (!hasAdminFlag) {
          roleFlagBackfillUpdates[`users/${id}/isadmin`] = safeValue.isadmin === true
        }

        if (!hasAgentFlag || !hasAdminFlag) {
          roleFlagBackfillUpdates[`users/${id}/updatedAt`] = roleFlagBackfillTimestamp
        }

        return {
          id,
          uid: id,
          ...safeValue,
          isagent: safeValue.isagent === true,
          isadmin: safeValue.isadmin === true,
        }
      })
    : []

  if (Object.keys(roleFlagBackfillUpdates).length) {
    await db.ref().update(roleFlagBackfillUpdates).catch(() => null)
  }
  const rawWalletsMap = walletsSnap.exists() ? walletsSnap.val() || {} : {}
  const walletsMap = Object.fromEntries(
    Object.entries(rawWalletsMap).map(([uid, wallet]) => [
      uid,
      {
        balance: toMoneyNumber(wallet?.balance, 0),
        updatedAt: toTimestampValue(wallet?.updatedAt, null),
      },
    ]),
  )
  const orders = []
  const ordersData = ordersSnap.exists() ? ordersSnap.val() || {} : {}
  for (const userId of Object.keys(ordersData)) {
    const userOrders = ordersData[userId] || {}
    for (const orderId of Object.keys(userOrders)) {
      const normalizedOrder = normalizeStoredOrderRecord(userOrders[orderId] || {})
      orders.push({
        id: orderId,
        userId,
        reference: normalizedOrder.reference,
        network: normalizedOrder.network,
        provider: normalizedOrder.provider,
        phone: normalizedOrder.phone,
        volume: normalizedOrder.volume,
        label: normalizedOrder.label,
        amount: normalizedOrder.amount,
        status: normalizedOrder.status,
        providerStatusRaw: normalizedOrder.providerStatusRaw,
        providerStatusDescription: normalizedOrder.providerStatusDescription,
        paymentStatus: normalizedOrder.paymentStatus || "",
        packageId: normalizedOrder.packageId || "",
        timestamp: normalizedOrder.timestamp,
        createdAt: normalizedOrder.createdAt,
        updatedAt: normalizedOrder.updatedAt,
      })
    }
  }

  const transactions = transactionsSnap.exists()
    ? Object.entries(transactionsSnap.val() || {}).map(([id, value]) => ({
        id,
        ...(value || {}),
        amount: toMoneyNumber(value?.amount, 0),
        balance: toMoneyNumber(value?.balance, 0),
      }))
    : []
  const afa = afaSnap.exists()
    ? Object.entries(afaSnap.val() || {}).map(([id, value]) => ({
        id,
        ...(value || {}),
      }))
    : []

  return {
    users: users.sort((a, b) => String(a.username || a.email || "").localeCompare(String(b.username || b.email || ""))),
    walletsMap,
    orders: orders.sort((a, b) => Number(b.timestamp || b.createdAt || 0) - Number(a.timestamp || a.createdAt || 0)),
    transactions: transactions.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)),
    afa: afa.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)),
  }
}

async function isPrivilegedUser(uid) {
  const role = await getUserRoleSummary(uid)
  return role.privileged === true
}

async function getEffectivePackagePrice(catalogEntry, uid) {
  const canUseAgentPricing = uid ? await isPrivilegedUser(uid) : false
  return canUseAgentPricing
    ? toMoneyNumber(catalogEntry.agentPrice, toMoneyNumber(catalogEntry.userPrice, 0))
    : toMoneyNumber(catalogEntry.userPrice, 0)
}

async function getAfaRegistrationFee() {
  const snapshot = await db.ref("settings/fees/afa").once("value")
  return toMoneyNumber(snapshot.val(), DEFAULT_AFA_REGISTRATION_FEE)
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms || 0)))
  })
}

function isTransientRealtimeDisconnectError(error) {
  const message = String(error?.message || error || "").toLowerCase()
  return ["disconnect", "econnreset", "timed out", "timeout", "socket hang up", "network", "connection lost"].some((term) =>
    message.includes(term),
  )
}

function hashStableKey(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 48)
}

function sanitizeMutationId(value, fallback = "") {
  const safe = String(value || "").trim().replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 120)
  return safe || String(fallback || "").trim()
}

function trimWalletMutationHistory(history = {}) {
  const entries = Object.entries(history || {})
  if (entries.length <= CONFIG.walletMutationHistoryLimit) {
    return history
  }

  entries.sort((a, b) => Number(b?.[1]?.timestamp || 0) - Number(a?.[1]?.timestamp || 0))
  return Object.fromEntries(entries.slice(0, CONFIG.walletMutationHistoryLimit))
}

function assertProviderConfigured(provider, context = "runtime") {
  const safeProvider = normalizeProvider(provider)
  if (safeProvider === "hubnet" && !CONFIG.hubnetApiKey) {
    throw createAppError("PROVIDER_CONFIGURATION_MISSING", {
      provider: "hubnet",
      context,
      providerMessage: "HubNet is routed for one or more networks, but HUBNET_API_KEY is missing.",
    })
  }

  if (safeProvider === "godsway" && !CONFIG.godswayApiKey) {
    throw createAppError("PROVIDER_CONFIGURATION_MISSING", {
      provider: "godsway",
      context,
      providerMessage: "CK-Godsway is routed for one or more networks, but GODSWAY_API_KEY is missing.",
    })
  }

  if (safeProvider === "gigshub" && !CONFIG.gigshubApiKey) {
    throw createAppError("PROVIDER_CONFIGURATION_MISSING", {
      provider: "gigshub",
      context,
      providerMessage: "GiGSHUB is routed for one or more networks, but GIGSHUB_API_KEY is missing.",
    })
  }
}

async function validateProviderSecretsForRouting(routing = null) {
  const currentRouting = routing || (await getProviderRoutingConfig())
  for (const network of SUPPORTED_PACKAGE_NETWORKS) {
    assertProviderConfigured(currentRouting[network], `routing:${network}`)
  }
}

function sanitizeUserProfileForClient(profile = {}, authUser = {}) {
  return {
    username: String(profile.username || "").trim(),
    email: String(profile.email || authUser?.email || "").trim(),
    phone: sanitizePhoneNumber(profile.phone || ""),
    createdAt: toTimestampValue(profile.createdAt, null),
    updatedAt: toTimestampValue(profile.updatedAt, null),
  }
}

async function ensureUserAccountState(uid, authUser = {}, overrides = {}) {
  if (!uid) {
    throw new Error("User id is required")
  }

  const userRef = db.ref(`users/${uid}`)
  const walletRef = db.ref(`wallets/${uid}`)
  const [userSnap, walletSnap] = await Promise.all([userRef.once("value"), walletRef.once("value")])
  const now = Date.now()
  const sanitizedUsername = String(overrides.username || "").trim()
  const sanitizedPhone = sanitizePhoneNumber(overrides.phone || "")
  const existingUser = userSnap.exists() ? userSnap.val() || {} : {}
  const hasExplicitAgentFlag = Object.prototype.hasOwnProperty.call(existingUser, "isagent")
  const hasExplicitAdminFlag = Object.prototype.hasOwnProperty.call(existingUser, "isadmin")
  const currentCreatedAt = toTimestampValue(existingUser.createdAt, null)
  const currentUpdatedAt = toTimestampValue(existingUser.updatedAt, null)
  const resolvedCreatedAt = currentCreatedAt || now
  const resolvedUpdatedAt = currentUpdatedAt || resolvedCreatedAt || now
  const nextUserFields = {
    username: sanitizedUsername || existingUser.username || String(authUser.displayName || "").trim() || String(authUser.email || "").split("@")[0] || "User",
    email: String(existingUser.email || authUser.email || "").trim(),
    phone: sanitizedPhone || sanitizePhoneNumber(existingUser.phone || ""),
    createdAt: resolvedCreatedAt,
    isagent: existingUser.isagent === true,
    isadmin: existingUser.isadmin === true,
  }
  const currentComparable = {
    username: String(existingUser.username || "").trim(),
    email: String(existingUser.email || "").trim(),
    phone: sanitizePhoneNumber(existingUser.phone || ""),
    createdAt: currentCreatedAt,
    isagent: existingUser.isagent === true,
    isadmin: existingUser.isadmin === true,
  }
  const shouldWriteUser =
    !userSnap.exists() ||
    JSON.stringify(nextUserFields) !== JSON.stringify(currentComparable) ||
    currentUpdatedAt == null ||
    !hasExplicitAgentFlag ||
    !hasExplicitAdminFlag

  if (shouldWriteUser) {
    await userRef.set({
      ...nextUserFields,
      updatedAt: now,
    })
  }

  if (!walletSnap.exists()) {
    await walletRef.set({
      balance: 0,
      updatedAt: now,
      appliedMutations: {},
    })
  }

  return {
    profile: {
      ...nextUserFields,
      updatedAt: shouldWriteUser
        ? now
        : resolvedUpdatedAt,
    },
    wallet: walletSnap.exists() ? walletSnap.val() || {} : { balance: 0, updatedAt: now, appliedMutations: {} },
  }
}

async function getUserRoleSummary(uid) {
  const userSnapshot = await db.ref(`users/${uid}`).once("value")
  const user = userSnapshot.exists() ? userSnapshot.val() || {} : {}
  const isAgent = user.isagent === true
  const isAdmin = user.isadmin === true
  const missingRoleFlags = {}

  if (userSnapshot.exists() && !Object.prototype.hasOwnProperty.call(user, "isagent")) {
    missingRoleFlags.isagent = false
  }

  if (userSnapshot.exists() && !Object.prototype.hasOwnProperty.call(user, "isadmin")) {
    missingRoleFlags.isadmin = false
  }

  if (Object.keys(missingRoleFlags).length) {
    await db.ref(`users/${uid}`).update({
      ...missingRoleFlags,
      updatedAt: Date.now(),
    }).catch(() => null)
  }

  return {
    agent: isAgent,
    admin: isAdmin,
    privileged: isAgent || isAdmin,
    pricingTier: isAgent || isAdmin ? "agent" : "user",
  }
}

async function getUserAfaRegistrations(uid, { limit = 30 } = {}) {
  const snapshot = await db.ref("afa_registrations").orderByChild("userId").equalTo(uid).once("value")
  const rows = snapshot.exists() ? Object.values(snapshot.val() || {}) : []
  return rows
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, Math.min(Math.max(Number(limit || 0), 1), 100))
}

async function recordAuditEvent({
  actorUid = null,
  actorEmail = null,
  action,
  targetUid = null,
  targetRef = null,
  status = "success",
  metadata = {},
} = {}) {
  if (!action) {
    return null
  }

  const auditRef = db.ref("audit_logs").push()
  const payload = {
    actorUid: actorUid || null,
    actorEmail: actorEmail || null,
    action,
    targetUid: targetUid || null,
    targetRef: targetRef || null,
    status,
    metadata: metadata || {},
    timestamp: Date.now(),
  }
  await auditRef.set(payload)
  return { id: auditRef.key, ...payload }
}

function getPurchaseIntentRef(reference) {
  return db.ref(`${PURCHASE_INTENT_PATH}/${reference}`)
}

function normalizePurchaseIntent(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  const createdAt = toTimestampValue(source.createdAt, Date.now()) || Date.now()
  const reference = String(source.reference || "").trim()
  const provider = normalizeProvider(source.provider)
  const providerOrderNumber = resolveStoredProviderOrderNumber(provider, source.providerOrderNumber, reference)
  const providerReference = resolveStoredProviderReference(provider, source.providerReference, reference, providerOrderNumber)
  return {
    reference,
    userId: String(source.userId || "").trim(),
    type: String(source.type || "bundle").trim(),
    network: normalizeNetwork(source.network),
    phone: sanitizePhoneNumber(source.phone || ""),
    packageId: String(source.packageId || "").trim(),
    volume: Number(source.volume || 0) || 0,
    label: String(source.label || "").trim(),
    amount: toMoneyNumber(source.amount, 0),
    paymentStatus: String(source.paymentStatus || "initialized").trim(),
    orderStatus: String(source.orderStatus || "").trim(),
    providerSubmissionStatus: String(source.providerSubmissionStatus || "pending").trim(),
    provider,
    providerReference,
    providerOrderNumber: providerOrderNumber || "",
    providerStatusRaw: String(source.providerStatusRaw || "").trim(),
    providerStatusDescription: String(source.providerStatusDescription || "").trim(),
    statusSource: String(source.statusSource || "").trim(),
    retryEligible: source.retryEligible !== false,
    errorMessage: String(source.errorMessage || "").trim(),
    metadata: source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata : {},
    createdAt,
    updatedAt: toTimestampValue(source.updatedAt || source.createdAt, createdAt) || createdAt,
    processingStartedAt: Number(source.processingStartedAt || 0) || null,
    processingExpiresAt: Number(source.processingExpiresAt || 0) || null,
    processingBy: String(source.processingBy || "").trim(),
  }
}

async function getPurchaseIntent(reference) {
  const snapshot = await getPurchaseIntentRef(reference).once("value")
  return snapshot.exists() ? normalizePurchaseIntent(snapshot.val()) : null
}

async function upsertPurchaseIntent(reference, updates = {}) {
  const safeReference = String(reference || "").trim()
  if (!safeReference) {
    return null
  }

  const ref = getPurchaseIntentRef(safeReference)
  const snapshot = await ref.once("value")
  const current = snapshot.exists() ? normalizePurchaseIntent(snapshot.val()) : null
  const now = Date.now()
  const next = normalizePurchaseIntent({
    ...(current || { reference: safeReference, createdAt: now }),
    ...updates,
    reference: safeReference,
    updatedAt: now,
  })
  await ref.set(next)
  return next
}

async function claimPurchaseIntentProcessing(reference, actor = INSTANCE_ID) {
  const safeReference = String(reference || "").trim()
  if (!safeReference) {
    return { claimed: false, intent: null }
  }

  const ref = getPurchaseIntentRef(safeReference)
  let claimed = false
  let latestIntent = null

  await ref.transaction((current) => {
    if (!current) {
      return
    }

    const intent = normalizePurchaseIntent(current)
    latestIntent = intent
    const now = Date.now()
    const isActiveProcessing =
      intent.providerSubmissionStatus === "processing" &&
      Number(intent.processingExpiresAt || 0) > now &&
      intent.processingBy &&
      intent.processingBy !== actor

    if (isActiveProcessing || ["submitted", "completed"].includes(intent.providerSubmissionStatus)) {
      return
    }

    claimed = true
    return {
      ...intent,
      providerSubmissionStatus: "processing",
      processingBy: actor,
      processingStartedAt: now,
      processingExpiresAt: now + 60 * 1000,
      updatedAt: now,
    }
  })

  const snapshot = await ref.once("value")
  return {
    claimed,
    intent: snapshot.exists() ? normalizePurchaseIntent(snapshot.val()) : latestIntent,
  }
}

async function claimIdempotencyKey(scope, key, payload = {}, windowMs = CONFIG.idempotencyWindowMs) {
  const safeScope = sanitizeMutationId(scope, "default")
  const safeKey = sanitizeMutationId(key, hashStableKey(key))
  const ref = db.ref(`idempotency_keys/${safeScope}/${safeKey}`)
  const now = Date.now()
  let claimed = false
  let existing = null

  await ref.transaction((current) => {
    const value = current && typeof current === "object" ? current : {}
    if (Number(value.expiresAt || 0) > now) {
      existing = value
      return
    }

    claimed = true
    return {
      ...(payload || {}),
      createdAt: toTimestampValue(value.createdAt, now) || now,
      updatedAt: now,
      expiresAt: now + Math.max(1000, Number(windowMs || CONFIG.idempotencyWindowMs)),
    }
  })

  return {
    claimed,
    key: safeKey,
    scope: safeScope,
    existing,
  }
}

async function updateIdempotencyKey(scope, key, updates = {}) {
  const safeScope = sanitizeMutationId(scope, "default")
  const safeKey = sanitizeMutationId(key, hashStableKey(key))
  const ref = db.ref(`idempotency_keys/${safeScope}/${safeKey}`)
  await ref.update({
    ...(updates || {}),
    updatedAt: Date.now(),
  })
}

function isPurchaseIntentActivelyProcessing(intent = {}) {
  const normalizedOrderStatus = normalizeInternalOrderStatus(intent?.orderStatus, "pending")
  const submissionStatus = String(intent?.providerSubmissionStatus || "").trim().toLowerCase()
  const paymentStatus = String(intent?.paymentStatus || "").trim().toLowerCase()

  if (["failed", "wallet_refunded", "refunded"].includes(paymentStatus)) {
    return false
  }

  if (isTerminalOrderStatus(normalizedOrderStatus)) {
    return false
  }

  return ["pending", "processing", "submitted", "completed"].includes(submissionStatus) || !submissionStatus
}

async function findMatchingActivePurchaseIntent({ userId, network, phone, packageId, maxAgeMs = 15 * 60 * 1000 } = {}) {
  const safeUserId = String(userId || "").trim()
  if (!safeUserId) {
    return null
  }

  const snapshot = await db.ref(PURCHASE_INTENT_PATH).orderByChild("userId").equalTo(safeUserId).once("value")
  if (!snapshot.exists()) {
    return null
  }

  const now = Date.now()
  const safeNetwork = normalizePurchaseNetwork(network)
  const safePhone = sanitizePhoneNumber(phone || "")
  const safePackageId = String(packageId || "").trim()
  const candidates = Object.values(snapshot.val() || {})
    .map((item) => normalizePurchaseIntent(item))
    .filter((intent) => {
      if (!intent.reference || intent.userId !== safeUserId) {
        return false
      }

      if (safeNetwork && normalizePurchaseNetwork(intent.network) !== safeNetwork) {
        return false
      }

      if (safePhone && sanitizePhoneNumber(intent.phone) !== safePhone) {
        return false
      }

      if (safePackageId && String(intent.packageId || "").trim() !== safePackageId) {
        return false
      }

      if (Number(intent.createdAt || 0) < now - Math.max(1000, Number(maxAgeMs || 0))) {
        return false
      }

      return isPurchaseIntentActivelyProcessing(intent)
    })
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))

  return candidates[0] || null
}

async function buildWalletPurchaseStateResponse(userId, reference, fallback = {}) {
  const safeReference = String(reference || "").trim()
  const [existingOrderLocation, purchaseIntent, wallet] = await Promise.all([
    findOrderLocationByReference(safeReference, { includeOrder: true }).catch(() => null),
    getPurchaseIntent(safeReference).catch(() => null),
    getUserWalletRecord(userId).catch(() => ({ balance: null })),
  ])

  const order = existingOrderLocation?.order || null
  const source = order || purchaseIntent || fallback || {}
  const orderStatus = String(order?.status || purchaseIntent?.orderStatus || fallback.orderStatus || "pending").trim() || "pending"
  const providerSubmissionStatus = String(
    purchaseIntent?.providerSubmissionStatus || fallback.providerSubmissionStatus || "",
  )
    .trim()
    .toLowerCase()

  let message = "Purchase already received. Returning the current transaction state."
  if (!order && ["pending", "processing", "submitted"].includes(providerSubmissionStatus)) {
    message = "Purchase already received and is still being processed."
  } else if (["accepted", "pending", "processing"].includes(normalizeInternalOrderStatus(orderStatus, "pending"))) {
    message = "Purchase already received and is still being processed."
  }

  return {
    message,
    data: {
      reference: safeReference,
      orderId: existingOrderLocation?.orderId || null,
      orderStatus,
      amount: toMoneyNumber(source?.amount, 0),
      phone: sanitizePhoneNumber(source?.phone || fallback.phone || ""),
      network: normalizePurchaseNetwork(source?.network || fallback.network || ""),
      volume: Number(source?.volume || fallback.volume || 0) || 0,
      label: String(source?.label || fallback.label || "").trim(),
      packageId: String(source?.packageId || fallback.packageId || "").trim(),
      balance: wallet?.balance ?? null,
    },
  }
}

function isWebhookIpAllowed(ip) {
  if (!CONFIG.providerWebhookAllowedIps.length) {
    return true
  }

  const safeIp = String(ip || "").trim()
  return CONFIG.providerWebhookAllowedIps.includes(safeIp)
}

function isValidWebhookToken(token) {
  const expected = String(CONFIG.providerWebhookSecret || "").trim()
  if (!expected) {
    return true
  }

  const provided = String(token || "").trim()
  if (!provided) {
    return false
  }

  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}

async function authenticateRequest(req, res, next) {
  const authHeader = String(req.headers.authorization || "")
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      status: "error",
      message: "Authentication required",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    const token = authHeader.slice("Bearer ".length).trim()
    req.authUser = await admin.auth().verifyIdToken(token)
    next()
  } catch (error) {
    logger.warn("Token verification failed", { error: error.message })
    return res.status(401).json({
      status: "error",
      message: "Invalid authentication token",
      timestamp: new Date().toISOString(),
    })
  }
}

async function requirePrivilegedAccess(req, res, next) {
  try {
    const role = await getUserRoleSummary(req.authUser.uid)
    // STRICTLY enforce: admin must be explicitly true, not just truthy
    if (role.admin !== true) {
      logger.warn("Admin access denied - user does not have admin privileges", {
        userId: req.authUser.uid,
        email: req.authUser.email,
        isAdmin: role.admin,
      })
      return res.status(403).json({
        status: "error",
        message: "Admin access denied",
        timestamp: new Date().toISOString(),
      })
    }

    next()
  } catch (error) {
    logger.error("Privilege check failed", error, { uid: req.authUser?.uid })
    return res.status(500).json({
      status: "error",
      message: "Failed to verify access",
      timestamp: new Date().toISOString(),
    })
  }
}

function sanitizePhoneNumber(value) {
  return String(value || "").replace(/\D/g, "").slice(-10)
}

function buildFrontendUrl(pathname) {
  const base = CONFIG.frontendUrl.endsWith("/") ? CONFIG.frontendUrl : `${CONFIG.frontendUrl}/`
  return new URL(pathname.replace(/^\//, ""), base).toString()
}

async function updateWalletBalance(
  uid,
  delta,
  { requireSufficient = false, mutationId = "", reason = "", reference = null, details = {} } = {},
) {
  const walletRef = db.ref(`wallets/${uid}`)
  const deltaUnits = toMoneyUnits(delta, 0)
  const requiredAmount = fromMoneyUnits(Math.abs(deltaUnits), 0)
  const safeMutationId = sanitizeMutationId(mutationId, mutationId ? hashStableKey(mutationId) : "")
  let lastAbortDetails = null

  for (let attempt = 1; attempt <= 2; attempt++) {
    const initialSnapshot = await walletRef.once("value")
    const initialWalletValue = initialSnapshot.exists() ? initialSnapshot.val() : {}
    let lastSeenBalance = toMoneyNumber(initialWalletValue?.balance, 0)
    let rejectedForInsufficient = false
    let duplicateMutation = false
    let duplicateMutationData = null

    const transactionResult = await walletRef.transaction((current) => {
      const sourceValue = current == null ? initialWalletValue : current
      const wallet =
        sourceValue && typeof sourceValue === "object"
          ? sourceValue
          : {
              balance: sourceValue,
            }

      const appliedMutations =
        wallet.appliedMutations && typeof wallet.appliedMutations === "object" && !Array.isArray(wallet.appliedMutations)
          ? wallet.appliedMutations
          : {}
      const currentBalance = toMoneyNumber(wallet.balance, 0)
      const currentBalanceUnits = toMoneyUnits(currentBalance, 0)
      const nextBalanceUnits = currentBalanceUnits + deltaUnits
      const nextBalance = fromMoneyUnits(nextBalanceUnits, 0)
      lastSeenBalance = currentBalance

      if (safeMutationId && appliedMutations[safeMutationId]) {
        duplicateMutation = true
        duplicateMutationData = appliedMutations[safeMutationId]
        return wallet
      }

      if (requireSufficient && nextBalanceUnits < 0) {
        rejectedForInsufficient = true
        return
      }

      const nextAppliedMutations = safeMutationId
        ? trimWalletMutationHistory({
            ...appliedMutations,
            [safeMutationId]: {
              amount: toMoneyNumber(delta, 0),
              balance: nextBalance,
              reference: reference || null,
              reason: String(reason || "").trim() || null,
              details: details && typeof details === "object" && !Array.isArray(details) ? details : {},
              timestamp: Date.now(),
            },
          })
        : appliedMutations

      return {
        ...wallet,
        balance: nextBalance,
        updatedAt: Date.now(),
        appliedMutations: nextAppliedMutations,
      }
    })

    if (transactionResult.committed) {
      const nextWallet = transactionResult.snapshot.val() || {}
      if (safeMutationId) {
        await db.ref(`wallet_mutations/${uid}/${safeMutationId}`).set({
          mutationId: safeMutationId,
          userId: uid,
          amount: toMoneyNumber(delta, 0),
          balance: toMoneyNumber(nextWallet.balance, 0),
          reference: reference || null,
          reason: String(reason || "").trim() || null,
          details: details && typeof details === "object" && !Array.isArray(details) ? details : {},
          timestamp: Date.now(),
        })
      }
      return toMoneyNumber(nextWallet.balance, 0)
    }

    if (duplicateMutation) {
      return toMoneyNumber(duplicateMutationData?.balance, lastSeenBalance)
    }

    const balanceSnapshot = await walletRef.child("balance").once("value").catch(() => null)
    const availableBalance = balanceSnapshot ? toMoneyNumber(balanceSnapshot.val(), lastSeenBalance) : lastSeenBalance
    const shortfall = toMoneyNumber(requiredAmount - availableBalance, 0)
    const normalizedShortfall = shortfall > 0 ? shortfall : 0

    if (rejectedForInsufficient || (requireSufficient && availableBalance < requiredAmount)) {
      logger.warn("Wallet balance check failed", {
        uid,
        attempt,
        availableBalance,
        requiredAmount,
        shortfall: normalizedShortfall,
      })

      throw createAppError("INSUFFICIENT_WALLET_BALANCE", {
        availableBalance,
        requiredAmount,
        shortfall: normalizedShortfall,
      })
    }

    lastAbortDetails = {
      availableBalance,
      requiredAmount,
      shortfall: normalizedShortfall,
      attempt,
    }

    logger.warn("Wallet transaction aborted before commit; retrying", {
      uid,
      attempt,
      availableBalance,
      requiredAmount,
    })
  }

  throw createAppError("WALLET_TRANSACTION_ABORTED", lastAbortDetails || {
    requiredAmount,
  })
}

async function recordTransaction({
  userId,
  type,
  amount,
  balance,
  reference = null,
  details = {},
  mutationId = "",
}) {
  const safeMutationId = sanitizeMutationId(mutationId, mutationId ? hashStableKey(mutationId) : "")
  if (safeMutationId) {
    const existingIndex = await db.ref(`transaction_refs/${userId}/${safeMutationId}`).once("value")
    if (existingIndex.exists()) {
      const transactionId = String(existingIndex.val()?.transactionId || "").trim()
      if (transactionId) {
        const existingTransaction = await db.ref(`transactions/${transactionId}`).once("value")
        if (existingTransaction.exists()) {
          return { id: transactionId, ...(existingTransaction.val() || {}) }
        }
      }
    }
  }

  const transactionRef = db.ref("transactions").push()
  const payload = {
    userId,
    type,
    amount: toMoneyNumber(amount, 0),
    balance: toMoneyNumber(balance, 0),
    timestamp: Date.now(),
    details: details || {},
    mutationId: safeMutationId || null,
  }

  if (reference) {
    payload.reference = reference
  }

  await transactionRef.set(payload)
  if (safeMutationId) {
    await db.ref(`transaction_refs/${userId}/${safeMutationId}`).set({
      transactionId: transactionRef.key,
      reference: reference || null,
      updatedAt: Date.now(),
    })
  }
  return { id: transactionRef.key, ...payload }
}

function toTimestampValue(value, fallback = null) {
  if (value == null || value === "") {
    return fallback
  }

  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric
  }

  const parsed = Date.parse(value)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }

  return fallback
}

function normalizeOrderSyncState(raw = {}, provider = "") {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}

  return {
    provider: normalizeProvider(source.provider, normalizeProvider(provider)),
    attempts: Math.max(0, Number(source.attempts || 0)),
    lastAttemptAt: toTimestampValue(source.lastAttemptAt, null),
    lastSuccessAt: toTimestampValue(source.lastSuccessAt, null),
    nextAttemptAt: toTimestampValue(source.nextAttemptAt, null),
    lastError: String(source.lastError || "").trim(),
    lastProviderStatusRaw: String(source.lastProviderStatusRaw || "").trim(),
    skippedReason: String(source.skippedReason || "").trim(),
  }
}

function normalizeStoredOrderRecord(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  const network = normalizeNetwork(source.network)
  const provider = normalizeProvider(
    source.provider,
    source.godswayResponse || source.telecelResponse || source.orderNumber
      ? "godsway"
      : source.hubnetResponse || source.transaction_id
        ? "hubnet"
        : DEFAULT_PROVIDER_ROUTING[network] || "hubnet",
  )
  const legacyResponse =
    source.providerResponse ||
    source[getProviderLegacyResponseField(provider)] ||
    (provider === "godsway" ? source.telecelResponse : null) ||
    {}
  const derivedStatus =
    provider === "godsway"
      ? getGodswayStatusDetails(legacyResponse)
      : getHubnetStatusDetails(legacyResponse, normalizeInternalOrderStatus(source.status, "accepted"))
  const status = normalizeInternalOrderStatus(source.status || derivedStatus.normalizedStatus, derivedStatus.normalizedStatus)
  const statusUpdatedAt = toTimestampValue(
    source.statusUpdatedAt || source.updatedAt || source.timestamp || source.createdAt,
    Date.now(),
  )
  const reference = String(source.reference || source.providerReference || "").trim()
  const providerMeta = {
    ...sanitizeProviderMeta(provider, legacyResponse),
    ...(source.providerMeta && typeof source.providerMeta === "object" && !Array.isArray(source.providerMeta)
      ? source.providerMeta
      : {}),
  }
  const providerOrderNumber = resolveStoredProviderOrderNumber(
    provider,
    source.providerOrderNumber || source.orderNumber || providerMeta.orderNumber,
    reference,
  )
  const providerReference = resolveStoredProviderReference(
    provider,
    source.providerReference,
    reference,
    providerOrderNumber || providerMeta.orderNumber || "",
  )
  const normalized = {
    ...source,
    reference,
    network,
    provider,
    providerReference,
    providerOrderNumber,
    providerStatusRaw: String(source.providerStatusRaw || source.status || derivedStatus.providerStatusRaw || "").trim(),
    providerStatusDescription: String(
      source.providerStatusDescription ||
        source.statusDescription ||
        derivedStatus.providerStatusDescription ||
        source.errorMessage ||
        "",
    ).trim(),
    providerMeta,
    status,
    statusSource: String(source.statusSource || (source.updatedFrom === "webhook" ? "webhook" : "system")).trim() || "system",
    statusUpdatedAt,
    updatedAt: toTimestampValue(source.updatedAt, statusUpdatedAt),
    createdAt: toTimestampValue(source.createdAt || source.timestamp, statusUpdatedAt),
    timestamp: toTimestampValue(source.timestamp || source.createdAt, statusUpdatedAt),
    amount: toMoneyNumber(source.amount, 0),
    sync: normalizeOrderSyncState(source.sync, provider),
  }

  if (source.transaction_id && !normalized.providerMeta.transactionId) {
    normalized.providerMeta.transactionId = source.transaction_id
  }

  if (source.orderNumber && !normalized.providerOrderNumber) {
    normalized.providerOrderNumber = source.orderNumber
  }

  if (provider === "hubnet" && Object.keys(legacyResponse).length) {
    normalized.hubnetResponse = legacyResponse
  }

  if (provider === "godsway" && Object.keys(legacyResponse).length) {
    normalized.godswayResponse = legacyResponse
    if (!source.telecelResponse) {
      normalized.telecelResponse = legacyResponse
    }
  }

  if (provider === "godsway") {
    normalized.providerOrderNumber = resolveStoredProviderOrderNumber(
      provider,
      normalized.providerOrderNumber || normalized.orderNumber || normalized.providerMeta?.orderNumber,
      reference,
    )
    normalized.providerReference = resolveStoredProviderReference(
      provider,
      normalized.providerReference,
      reference,
      normalized.providerOrderNumber || "",
    )
    normalized.orderNumber = normalized.providerOrderNumber || null
    normalized.providerMeta = {
      ...(normalized.providerMeta || {}),
      orderNumber: normalized.providerOrderNumber || null,
    }
  }

  normalized.sync.provider = provider
  if (isTerminalOrderStatus(normalized.status)) {
    normalized.sync.nextAttemptAt = null
    normalized.sync.skippedReason = ""
  }

  return normalized
}

function toPublicOrderRecord(order = {}) {
  const normalized = normalizeStoredOrderRecord(order)
  return {
    reference: normalized.reference,
    network: normalized.network,
    phone: normalized.phone || "",
    label: normalized.label || defaultPackageLabel(normalized.volume),
    volume: normalized.volume || 0,
    amount: toMoneyNumber(normalized.amount, 0),
    status: normalized.status,
    statusDescription: normalized.providerStatusDescription || "",
    paymentStatus: normalized.paymentStatus || "",
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    timestamp: normalized.timestamp,
  }
}

function toPublicTransactionRecord(item = {}) {
  return {
    id: item.id || null,
    type: String(item.type || "transaction").trim(),
    amount: toMoneyNumber(item.amount, 0),
    balance: toMoneyNumber(item.balance, 0),
    reference: String(item.reference || item?.details?.reference || "").trim(),
    timestamp: toTimestampValue(item.timestamp, null),
  }
}

function orderRecordsDiffer(before = {}, after = {}) {
  const fields = [
    "reference",
    "network",
    "provider",
    "providerReference",
    "providerOrderNumber",
    "providerStatusRaw",
    "providerStatusDescription",
    "status",
    "statusSource",
    "statusUpdatedAt",
    "updatedAt",
    "createdAt",
    "timestamp",
    "amount",
  ]

  const fieldMismatch = fields.some((field) => (before?.[field] ?? null) !== (after?.[field] ?? null))
  if (fieldMismatch) {
    return true
  }

  return ["providerMeta", "sync", "providerMappings"].some((field) => {
    return JSON.stringify(before?.[field] || {}) !== JSON.stringify(after?.[field] || {})
  })
}

function toLookupKey(value) {
  const raw = String(value || "").trim()
  if (!raw) {
    return ""
  }

  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function getProviderOrderLookupEntries(order = {}) {
  const normalized = normalizeStoredOrderRecord(order)
  const provider = normalizeProvider(normalized.provider)
  const reference = String(normalized.reference || "").trim()
  if (!provider) {
    return []
  }

  const entries = []
  const seen = new Set()
  for (const [type, value] of [
    ["providerReference", normalized.providerReference],
    ["providerOrderNumber", normalized.providerOrderNumber],
  ]) {
    const lookupValue = String(value || "").trim()
    if (!lookupValue || lookupValue === reference || seen.has(lookupValue)) {
      continue
    }

    seen.add(lookupValue)
    entries.push({
      provider,
      type,
      lookupValue,
      key: toLookupKey(lookupValue),
    })
  }

  return entries
}

async function setProviderOrderLookupIndex(provider, lookupValue, payload = {}) {
  const safeProvider = normalizeProvider(provider)
  const safeLookupValue = String(lookupValue || "").trim()
  const key = toLookupKey(safeLookupValue)
  if (!safeProvider || !safeLookupValue || !key) {
    return
  }

  await db.ref(`order_provider_refs/${safeProvider}/${key}`).set({
    provider: safeProvider,
    type: String(payload.type || "providerReference").trim() || "providerReference",
    lookupValue: safeLookupValue,
    reference: String(payload.reference || "").trim(),
    userId: payload.userId || null,
    orderId: payload.orderId || null,
    network: normalizeNetwork(payload.network),
    status: normalizeInternalOrderStatus(payload.status, ""),
    updatedAt: Date.now(),
  })
}

async function removeProviderOrderLookupIndex(provider, lookupValue) {
  const safeProvider = normalizeProvider(provider)
  const key = toLookupKey(lookupValue)
  if (!safeProvider || !key) {
    return
  }

  await db.ref(`order_provider_refs/${safeProvider}/${key}`).remove().catch(() => null)
}

async function syncProviderOrderLookupIndexes(previousOrder = {}, nextOrder = {}, { userId = "", orderId = "" } = {}) {
  const previousEntries = getProviderOrderLookupEntries(previousOrder)
  const nextEntries = getProviderOrderLookupEntries(nextOrder)
  const nextNormalized = normalizeStoredOrderRecord(nextOrder)

  const previousMap = new Map(previousEntries.map((entry) => [`${entry.provider}:${entry.key}`, entry]))
  const nextMap = new Map(nextEntries.map((entry) => [`${entry.provider}:${entry.key}`, entry]))

  for (const [lookupId, entry] of previousMap.entries()) {
    if (!nextMap.has(lookupId)) {
      await removeProviderOrderLookupIndex(entry.provider, entry.lookupValue)
    }
  }

  for (const entry of nextEntries) {
    await setProviderOrderLookupIndex(entry.provider, entry.lookupValue, {
      type: entry.type,
      reference: nextNormalized.reference,
      userId,
      orderId,
      network: nextNormalized.network,
      status: nextNormalized.status,
    })
  }
}

async function setOrderReferenceIndex(reference, payload = {}) {
  if (!reference) {
    return
  }

  const sync = payload?.sync && typeof payload.sync === "object" && !Array.isArray(payload.sync) ? payload.sync : {}
  await db.ref(`order_refs/${reference}`).set({
    reference,
    userId: payload.userId || null,
    orderId: payload.orderId || null,
    provider: normalizeProvider(payload.provider),
    network: normalizeNetwork(payload.network),
    status: normalizeInternalOrderStatus(payload.status, ""),
    nextAttemptAt: toTimestampValue(sync.nextAttemptAt, null),
    lastAttemptAt: toTimestampValue(sync.lastAttemptAt, null),
    lastError: String(sync.lastError || "").trim(),
    updatedAt: Date.now(),
  })
}

async function getOrderLocationFromIndexData(indexData = {}, { includeOrder = false } = {}) {
  const userId = String(indexData.userId || "").trim()
  const orderId = String(indexData.orderId || "").trim()
  if (!userId || !orderId) {
    return null
  }

  const orderSnapshot = await db.ref(`orders/${userId}/${orderId}`).once("value").catch(() => null)
  if (!orderSnapshot?.exists()) {
    return null
  }

  const order = orderSnapshot.val() || {}
  return includeOrder ? { userId, orderId, order } : { userId, orderId }
}

async function findOrderLocationByReference(reference, { includeOrder = false } = {}) {
  const safeReference = String(reference || "").trim()
  if (!safeReference) {
    return null
  }

  const indexSnapshot = await db.ref(`order_refs/${safeReference}`).once("value")
  if (indexSnapshot.exists()) {
    const located = await getOrderLocationFromIndexData(indexSnapshot.val() || {}, { includeOrder })
    if (located) {
      return located
    }

    await db.ref(`order_refs/${safeReference}`).remove().catch(() => null)
  }

  const ordersSnapshot = await db.ref("orders").once("value")
  if (!ordersSnapshot.exists()) {
    return null
  }

  const ordersData = ordersSnapshot.val() || {}
  for (const userId of Object.keys(ordersData)) {
    const userOrders = ordersData[userId] || {}
    for (const orderId of Object.keys(userOrders)) {
      const order = userOrders[orderId]
      const normalizedOrder = normalizeStoredOrderRecord(order || {})
      if (String(normalizedOrder.reference || "").trim() === safeReference) {
        await setOrderReferenceIndex(safeReference, {
          userId,
          orderId,
          provider: normalizedOrder.provider,
          network: normalizedOrder.network,
          status: normalizedOrder.status,
          sync: normalizedOrder.sync,
        })
        await syncProviderOrderLookupIndexes({}, normalizedOrder, { userId, orderId })
        return includeOrder ? { userId, orderId, order } : { userId, orderId }
      }
    }
  }

  return null
}

async function findOrderLocationByProviderLookup(lookupValue, { includeOrder = false, provider = "" } = {}) {
  const safeLookupValue = String(lookupValue || "").trim()
  if (!safeLookupValue) {
    return null
  }

  const encodedLookupValue = toLookupKey(safeLookupValue)
  const providersToCheck = normalizeProvider(provider) ? [normalizeProvider(provider)] : SUPPORTED_PROVIDERS

  if (encodedLookupValue) {
    for (const candidateProvider of providersToCheck) {
      const aliasSnapshot = await db.ref(`order_provider_refs/${candidateProvider}/${encodedLookupValue}`).once("value")
      if (!aliasSnapshot.exists()) {
        continue
      }

      const located = await getOrderLocationFromIndexData(aliasSnapshot.val() || {}, { includeOrder })
      if (located) {
        return located
      }

      await db.ref(`order_provider_refs/${candidateProvider}/${encodedLookupValue}`).remove().catch(() => null)
    }
  }

  const ordersSnapshot = await db.ref("orders").once("value")
  if (!ordersSnapshot.exists()) {
    return null
  }

  const providerFilter = new Set(providersToCheck.filter(Boolean))
  const ordersData = ordersSnapshot.val() || {}
  for (const userId of Object.keys(ordersData)) {
    const userOrders = ordersData[userId] || {}
    for (const orderId of Object.keys(userOrders)) {
      const order = userOrders[orderId] || {}
      const normalizedOrder = normalizeStoredOrderRecord(order)
      if (providerFilter.size && !providerFilter.has(normalizedOrder.provider)) {
        continue
      }

      const lookupCandidates = new Set(
        [normalizedOrder.reference, normalizedOrder.providerReference, normalizedOrder.providerOrderNumber]
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      )

      if (!lookupCandidates.has(safeLookupValue)) {
        continue
      }

      await setOrderReferenceIndex(normalizedOrder.reference, {
        userId,
        orderId,
        provider: normalizedOrder.provider,
        network: normalizedOrder.network,
        status: normalizedOrder.status,
        sync: normalizedOrder.sync,
      })
      await syncProviderOrderLookupIndexes({}, normalizedOrder, { userId, orderId })
      return includeOrder ? { userId, orderId, order } : { userId, orderId }
    }
  }

  return null
}

async function findOrderLocationByLookupValue(lookupValue, { includeOrder = false, provider = "" } = {}) {
  const byReference = await findOrderLocationByReference(lookupValue, { includeOrder })
  if (byReference) {
    if (!provider) {
      return byReference
    }

    const normalizedOrder = normalizeStoredOrderRecord(byReference.order || {})
    if (!normalizedOrder.provider || normalizedOrder.provider === normalizeProvider(provider)) {
      return byReference
    }
  }

  return await findOrderLocationByProviderLookup(lookupValue, { includeOrder, provider })
}

async function createOrderRecord(uid, payload) {
  const orderRef = db.ref(`orders/${uid}`).push()
  const record = normalizeStoredOrderRecord({
    ...payload,
    timestamp: toTimestampValue(payload?.timestamp, Date.now()) || Date.now(),
  })

  await orderRef.set(record)
  await setOrderReferenceIndex(record.reference, {
    userId: uid,
    orderId: orderRef.key,
    provider: record.provider,
    network: record.network,
    status: record.status,
  })
  await syncProviderOrderLookupIndexes({}, record, { userId: uid, orderId: orderRef.key })
  return { id: orderRef.key, ...record }
}

async function updateOrderByReference(reference, updates = {}) {
  const located = await findOrderLocationByReference(reference, { includeOrder: true })
  if (!located) {
    return { found: false, order: null }
  }

  const nextOrder = normalizeStoredOrderRecord({
    ...located.order,
    ...updates,
    sync: {
      ...(located.order?.sync || {}),
      ...(updates?.sync || {}),
    },
  })

  await db.ref(`orders/${located.userId}/${located.orderId}`).set(nextOrder)
  const previousReference = String(located.order?.reference || "").trim()
  const nextReference = String(nextOrder.reference || reference).trim()
  if (previousReference && previousReference !== nextReference) {
    await db.ref(`order_refs/${previousReference}`).remove().catch(() => null)
  }
  await setOrderReferenceIndex(nextReference, {
    userId: located.userId,
    orderId: located.orderId,
    provider: nextOrder.provider,
    network: nextOrder.network,
    status: nextOrder.status,
    sync: nextOrder.sync,
  })
  await syncProviderOrderLookupIndexes(located.order || {}, nextOrder, {
    userId: located.userId,
    orderId: located.orderId,
  })

  return {
    found: true,
    userId: located.userId,
    orderId: located.orderId,
    order: nextOrder,
  }
}

async function syncPurchaseIntentFromOrder(reference, order = {}, overrides = {}) {
  const safeReference = String(reference || order?.reference || "").trim()
  if (!safeReference) {
    return null
  }

  const normalizedOrder = normalizeStoredOrderRecord(order)
  const orderStatus = normalizeInternalOrderStatus(overrides.orderStatus || normalizedOrder.status, normalizedOrder.status || "pending")
  const provider = normalizeProvider(overrides.provider || normalizedOrder.provider)
  const providerOrderNumber = resolveStoredProviderOrderNumber(
    provider,
    overrides.providerOrderNumber || normalizedOrder.providerOrderNumber || "",
    safeReference,
  )
  const providerReference = resolveStoredProviderReference(
    provider,
    overrides.providerReference || normalizedOrder.providerReference || "",
    safeReference,
    providerOrderNumber || "",
  )
  const nextPayload = {
    provider,
    providerReference,
    providerOrderNumber: providerOrderNumber || "",
    providerStatusRaw: String(overrides.providerStatusRaw || normalizedOrder.providerStatusRaw || "").trim(),
    providerStatusDescription: String(
      overrides.providerStatusDescription || normalizedOrder.providerStatusDescription || "",
    ).trim(),
    statusSource: String(overrides.statusSource || normalizedOrder.statusSource || "").trim() || "system",
    orderStatus,
    providerSubmissionStatus:
      String(overrides.providerSubmissionStatus || "").trim() || getPurchaseIntentSubmissionStatusForOrderStatus(orderStatus),
  }

  if (Object.prototype.hasOwnProperty.call(overrides, "errorMessage")) {
    nextPayload.errorMessage = String(overrides.errorMessage || "").trim()
  } else if (["failed", "cancelled"].includes(orderStatus)) {
    nextPayload.errorMessage = String(normalizedOrder.providerStatusDescription || normalizedOrder.errorMessage || "").trim()
  } else {
    nextPayload.errorMessage = ""
  }

  if (Object.prototype.hasOwnProperty.call(overrides, "paymentStatus")) {
    nextPayload.paymentStatus = String(overrides.paymentStatus || "").trim()
  }

  if (Object.prototype.hasOwnProperty.call(overrides, "retryEligible")) {
    nextPayload.retryEligible = overrides.retryEligible !== false
  }

  return await upsertPurchaseIntent(safeReference, nextPayload)
}

function mergeOrderPayloadWithPurchaseIntent(basePayload = {}, intent = null) {
  const nextPayload = { ...(basePayload || {}) }
  const normalizedIntent = intent ? normalizePurchaseIntent(intent) : null
  if (!normalizedIntent?.reference) {
    return nextPayload
  }

  if (normalizedIntent.provider) {
    nextPayload.provider = normalizeProvider(normalizedIntent.provider, nextPayload.provider)
  }

  if (normalizedIntent.providerReference) {
    nextPayload.providerReference = normalizedIntent.providerReference
  }

  if (normalizedIntent.providerOrderNumber) {
    nextPayload.providerOrderNumber = normalizedIntent.providerOrderNumber
  }

  const baseStatus = normalizeInternalOrderStatus(nextPayload.status, "pending")
  const intentStatus = normalizeInternalOrderStatus(normalizedIntent.orderStatus, "")
  const shouldPreferIntentStatus =
    intentStatus &&
    (getOrderStatusPriority(intentStatus) > getOrderStatusPriority(baseStatus) ||
      (isTerminalOrderStatus(intentStatus) && !isTerminalOrderStatus(baseStatus)))

  if (shouldPreferIntentStatus) {
    nextPayload.status = intentStatus
    nextPayload.providerStatusRaw = normalizedIntent.providerStatusRaw || nextPayload.providerStatusRaw || ""
    nextPayload.providerStatusDescription =
      normalizedIntent.providerStatusDescription || normalizedIntent.errorMessage || nextPayload.providerStatusDescription || ""
    nextPayload.statusSource = normalizedIntent.statusSource || nextPayload.statusSource || "system"
    const mergedStatusAt = Math.max(
      toTimestampValue(normalizedIntent.updatedAt, 0) || 0,
      toTimestampValue(nextPayload.statusUpdatedAt, 0) || 0,
    )
    if (mergedStatusAt) {
      nextPayload.statusUpdatedAt = mergedStatusAt
      nextPayload.updatedAt = Math.max(mergedStatusAt, toTimestampValue(nextPayload.updatedAt, mergedStatusAt) || mergedStatusAt)
    }
  }

  return nextPayload
}

async function bulkUpdateOrdersStatus({
  startDate,
  endDate,
  currentStatus,
  nextStatus,
  actorUid = "",
} = {}) {
  const startAt = parseUtcDateBoundary(startDate, "start")
  const endAt = parseUtcDateBoundary(endDate, "end")
  const normalizedCurrentStatus = normalizeInternalOrderStatus(currentStatus, "")
  const normalizedNextStatus = normalizeInternalOrderStatus(nextStatus, "")

  if (!startAt || !endAt) {
    throw createAppError("ADMIN_ORDER_BULK_DATE_INVALID", {
      providerMessage: "Valid start and end dates are required.",
    })
  }

  if (endAt < startAt) {
    throw createAppError("ADMIN_ORDER_BULK_DATE_RANGE_INVALID", {
      providerMessage: "End date must be on or after start date.",
    })
  }

  if (!normalizedCurrentStatus || !normalizedNextStatus) {
    throw createAppError("ADMIN_ORDER_BULK_STATUS_INVALID", {
      providerMessage: "Current status and next status are required.",
    })
  }

  if (normalizedCurrentStatus === normalizedNextStatus) {
    throw createAppError("ADMIN_ORDER_BULK_STATUS_SAME", {
      providerMessage: "Current status and next status must be different.",
    })
  }

  const ordersSnapshot = await db.ref("orders").once("value")
  if (!ordersSnapshot.exists()) {
    return {
      matched: 0,
      updated: 0,
      startAt,
      endAt,
      currentStatus: normalizedCurrentStatus,
      nextStatus: normalizedNextStatus,
      byProvider: {},
      references: [],
    }
  }

  const ordersData = ordersSnapshot.val() || {}
  const now = Date.now()
  const byProvider = {}
  const references = []
  let matched = 0
  let updated = 0

  for (const userId of Object.keys(ordersData)) {
    const userOrders = ordersData[userId] || {}
    for (const orderId of Object.keys(userOrders)) {
      const currentOrder = normalizeStoredOrderRecord(userOrders[orderId] || {})
      const orderTimestamp =
        toTimestampValue(currentOrder.timestamp || currentOrder.createdAt || currentOrder.updatedAt, 0) || 0
      const orderStatus = normalizeInternalOrderStatus(currentOrder.status, "")

      if (!orderTimestamp || orderTimestamp < startAt || orderTimestamp > endAt) {
        continue
      }

      if (orderStatus !== normalizedCurrentStatus) {
        continue
      }

      matched += 1

      const nextOrder = normalizeStoredOrderRecord({
        ...currentOrder,
        status: normalizedNextStatus,
        statusSource: "admin_bulk_update",
        statusUpdatedAt: now,
        updatedAt: now,
        sync: {
          ...(currentOrder.sync || {}),
          manualOverrideAt: now,
          manualOverrideBy: String(actorUid || "").trim(),
          nextAttemptAt: isTerminalOrderStatus(normalizedNextStatus)
            ? null
            : currentOrder?.sync?.nextAttemptAt || null,
          skippedReason: "",
        },
      })

      await db.ref(`orders/${userId}/${orderId}`).set(nextOrder)
      if (nextOrder.reference) {
        await setOrderReferenceIndex(nextOrder.reference, {
          userId,
          orderId,
          provider: nextOrder.provider,
          network: nextOrder.network,
          status: nextOrder.status,
          sync: nextOrder.sync,
        })
        await syncProviderOrderLookupIndexes(currentOrder, nextOrder, { userId, orderId })
        await syncPurchaseIntentFromOrder(nextOrder.reference, nextOrder, {
          errorMessage: ["failed", "cancelled"].includes(normalizedNextStatus)
            ? `Admin bulk update set status to ${normalizedNextStatus}`
            : "",
        }).catch(() => null)
        if (references.length < 50) {
          references.push(nextOrder.reference)
        }
      }

      const provider = normalizeProvider(nextOrder.provider, "unknown") || "unknown"
      byProvider[provider] = (byProvider[provider] || 0) + 1
      updated += 1
    }
  }

  return {
    matched,
    updated,
    startAt,
    endAt,
    currentStatus: normalizedCurrentStatus,
    nextStatus: normalizedNextStatus,
    byProvider,
    references,
  }
}

async function normalizeExistingOrdersAndIndexes() {
  const ordersSnapshot = await db.ref("orders").once("value")
  if (!ordersSnapshot.exists()) {
    return { normalized: 0, indexed: 0 }
  }

  const ordersData = ordersSnapshot.val() || {}
  let normalizedCount = 0
  let indexedCount = 0

  for (const userId of Object.keys(ordersData)) {
    const userOrders = ordersData[userId] || {}
    for (const orderId of Object.keys(userOrders)) {
      const currentOrder = userOrders[orderId] || {}
      const normalizedOrder = normalizeStoredOrderRecord(currentOrder)
      const reference = String(normalizedOrder.reference || "").trim()
      if (reference) {
        await setOrderReferenceIndex(reference, {
          userId,
          orderId,
          provider: normalizedOrder.provider,
          network: normalizedOrder.network,
          status: normalizedOrder.status,
          sync: normalizedOrder.sync,
        })
        await syncProviderOrderLookupIndexes({}, normalizedOrder, { userId, orderId })
        indexedCount += 1
      }

      if (orderRecordsDiffer(currentOrder, normalizedOrder)) {
        await db.ref(`orders/${userId}/${orderId}`).set(normalizedOrder)
        normalizedCount += 1
      }
    }
  }

  logger.info("Order normalization ready", {
    normalized: normalizedCount,
    indexed: indexedCount,
  })

  return { normalized: normalizedCount, indexed: indexedCount }
}

async function backfillPurchaseIntentsFromOrders() {
  const ordersSnapshot = await db.ref("orders").once("value")
  if (!ordersSnapshot.exists()) {
    return { created: 0 }
  }

  const ordersData = ordersSnapshot.val() || {}
  let created = 0

  for (const userId of Object.keys(ordersData)) {
    const userOrders = ordersData[userId] || {}
    for (const orderId of Object.keys(userOrders)) {
      const order = normalizeStoredOrderRecord(userOrders[orderId] || {})
      if (!order.reference) {
        continue
      }

      const existingIntent = await getPurchaseIntent(order.reference)
      if (existingIntent) {
        continue
      }

      await upsertPurchaseIntent(order.reference, {
        reference: order.reference,
        userId,
        type: order.paymentStatus === "success" ? "bundle" : "wallet_purchase",
        network: order.network,
        phone: order.phone,
        packageId: order.packageId || "",
        volume: Number(order.volume || 0),
        label: order.label || defaultPackageLabel(order.volume),
        amount: toMoneyNumber(order.amount, 0),
        paymentStatus: order.paymentStatus || (order.refunded ? "wallet_refunded" : "success"),
        orderStatus: order.status || "pending",
        providerSubmissionStatus: isTerminalOrderStatus(order.status) ? "completed" : "submitted",
        provider: order.provider,
        providerReference: order.providerReference || order.reference,
        providerOrderNumber: order.providerOrderNumber || "",
        providerStatusRaw: order.providerStatusRaw || "",
        providerStatusDescription: order.providerStatusDescription || "",
        statusSource: order.statusSource || "system",
        errorMessage: order.errorMessage || "",
        createdAt: toTimestampValue(order.createdAt || order.timestamp, Date.now()) || Date.now(),
      })
      created += 1
    }
  }

  logger.info("Purchase intent backfill complete", { created })
  return { created }
}

function firstNonEmptyText(values = []) {
  for (const value of values) {
    const safeValue = String(value || "").trim()
    if (safeValue) {
      return safeValue
    }
  }

  return ""
}

function uniqueTextValues(values = []) {
  const output = []
  const seen = new Set()

  for (const value of values) {
    const safeValue = String(value || "").trim()
    if (!safeValue || seen.has(safeValue)) {
      continue
    }

    seen.add(safeValue)
    output.push(safeValue)
  }

  return output
}

function getWebhookLookupContext(payload = {}, provider = "") {
  const data = payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : {}
  const safeProvider = normalizeProvider(provider)
  const appReference = firstNonEmptyText([
    data.reference,
    payload?.reference,
    data.clientReference,
    payload?.clientReference,
    data.client_reference,
    payload?.client_reference,
    data.orderReference,
    payload?.orderReference,
    data.order_reference,
    payload?.order_reference,
    data.merchantReference,
    payload?.merchantReference,
  ])
  const providerOrderNumber = firstNonEmptyText([
    data.orderNumber,
    payload?.orderNumber,
    data.order_number,
    payload?.order_number,
    data.orderNo,
    payload?.orderNo,
    data.order_no,
    payload?.order_no,
    data.providerOrderNumber,
    payload?.providerOrderNumber,
    data.transaction_id,
    payload?.transaction_id,
    data.transactionId,
    payload?.transactionId,
  ])
  const providerReference =
    safeProvider === "godsway"
      ? firstNonEmptyText([
          providerOrderNumber,
          data.providerReference,
          payload?.providerReference,
          data.provider_reference,
          payload?.provider_reference,
          data.order_reference,
          payload?.order_reference,
          appReference,
        ])
      : firstNonEmptyText([
          data.providerReference,
          payload?.providerReference,
          data.provider_reference,
          payload?.provider_reference,
          appReference,
          providerOrderNumber,
          data.order_reference,
          payload?.order_reference,
        ])

  // For Godsway, prioritize providerOrderNumber; for Hubnet, use app reference
  // Godsway webhook should ALWAYS include orderNumber - if not, lookup will still check other candidates
  const lookupCandidates = uniqueTextValues([
    safeProvider === "godsway" ? providerOrderNumber : appReference,
    safeProvider === "godsway" ? providerReference : providerReference,
    safeProvider === "godsway" ? appReference : providerOrderNumber,
    data.orderRef,
    payload?.orderRef,
    data.ref,
    payload?.ref,
    data.reference,
    payload?.reference,
    data.order_reference,
    payload?.order_reference,
    data.orderReference,
    payload?.orderReference,
    data.clientReference,
    payload?.clientReference,
    data.client_reference,
    payload?.client_reference,
    data.merchantReference,
    payload?.merchantReference,
    data.providerReference,
    payload?.providerReference,
    data.provider_reference,
    payload?.provider_reference,
    data.orderNumber,
    payload?.orderNumber,
    data.order_number,
    payload?.order_number,
    data.transaction_id,
    payload?.transaction_id,
    data.transactionId,
    payload?.transactionId,
  ])

  return {
    data,
    appReference,
    providerReference,
    providerOrderNumber,
    lookupCandidates,
    network: normalizeNetwork(data.network || payload?.network),
    phone: firstNonEmptyText([
      data.msisdn,
      payload?.msisdn,
      data.recipient,
      payload?.recipient,
      data.phone,
      payload?.phone,
      data.phoneNumber,
      payload?.phoneNumber,
    ]),
    volume: Number(
      firstNonEmptyText([data.volume, data.capacity, payload?.volume, payload?.capacity]),
    ) || undefined,
  }
}

app.post("/webhook", express.json(), async (req, res) => {
  try {
    if (!isWebhookIpAllowed(req.ip)) {
      logger.warn("Webhook rejected due to IP allowlist", { ip: req.ip })
      return res.status(403).json({ status: false, message: "Webhook not allowed" })
    }

    const webhookToken = req.headers["x-webhook-secret"] || req.query?.token
    if (!isValidWebhookToken(webhookToken)) {
      logger.warn("Webhook rejected due to invalid secret", { ip: req.ip })
      return res.status(403).json({ status: false, message: "Webhook not authorized" })
    }

    const payload = req.body && typeof req.body === "object" ? req.body : {}
    const explicitProvider = normalizeProvider(
      req.headers["x-provider"] || payload?.provider || payload?.source || req.query?.provider || req.query?.service,
      "",
    )
    const initialLookup = getWebhookLookupContext(payload, explicitProvider)
    let located = null
    let matchedLookupValue = ""

    for (const candidate of initialLookup.lookupCandidates) {
      located = await findOrderLocationByLookupValue(candidate, {
        includeOrder: true,
        provider: explicitProvider,
      })
      if (located) {
        matchedLookupValue = candidate
        break
      }
    }

    const provider = normalizeProvider(explicitProvider || located?.order?.provider, "hubnet")
    const lookup = getWebhookLookupContext(payload, provider)
    const reference = String(located?.order?.reference || lookup.appReference || "").trim()

    if (!reference) {
      return res.status(400).json({ status: false, message: "Invalid webhook format" })
    }

    const providerStatus =
      provider === "godsway"
        ? getGodswayStatusDetails(payload)
        : provider === "gigshub"
          ? getGigshubStatusDetails(payload)
          : getHubnetStatusDetails(payload, normalizeInternalOrderStatus(lookup.data.status, "processing"))
    const updatedAt = Date.now()
    const providerOrderNumber = resolveStoredProviderOrderNumber(
      provider,
      lookup.providerOrderNumber || located?.order?.providerOrderNumber || "",
      reference,
    )
    const providerReference = resolveStoredProviderReference(
      provider,
      lookup.providerReference || located?.order?.providerReference || "",
      reference,
      providerOrderNumber || "",
    )
    const result = await updateOrderByReference(reference, {
      provider,
      network: lookup.network || normalizeNetwork(located?.order?.network),
      phone: lookup.phone || located?.order?.phone,
      volume: lookup.volume || located?.order?.volume || undefined,
      providerReference,
      providerOrderNumber,
      providerStatusRaw: providerStatus.providerStatusRaw,
      providerStatusDescription: providerStatus.providerStatusDescription,
      status: providerStatus.normalizedStatus,
      statusSource: "webhook",
      statusUpdatedAt: updatedAt,
      updatedAt,
      sync: {
        lastAttemptAt: updatedAt,
        lastSuccessAt: updatedAt,
        lastError: "",
        lastProviderStatusRaw: providerStatus.providerStatusRaw,
      },
    })
    const canonicalReference = String(result.order?.reference || reference).trim()
    if (result.found && result.order) {
      await syncPurchaseIntentFromOrder(canonicalReference, result.order, {
        errorMessage: "",
      }).catch(() => null)
    }
    await upsertPurchaseIntent(canonicalReference, {
      provider,
      providerReference,
      providerOrderNumber: providerOrderNumber || "",
      providerStatusRaw: providerStatus.providerStatusRaw,
      providerStatusDescription: providerStatus.providerStatusDescription,
      statusSource: "webhook",
      orderStatus: providerStatus.normalizedStatus,
      providerSubmissionStatus: isTerminalOrderStatus(providerStatus.normalizedStatus) ? "completed" : "submitted",
      paymentStatus: "success",
      errorMessage: "",
    }).catch(() => null)

    processedTransactions.add(canonicalReference, {
      reference: canonicalReference,
      provider,
      phone: lookup.phone || null,
      network: lookup.network,
      volume: lookup.volume || null,
      status: providerStatus.normalizedStatus,
      providerStatusRaw: providerStatus.providerStatusRaw,
      providerReference,
      providerOrderNumber,
      matchedLookupValue: matchedLookupValue || null,
      updatedFrom: "webhook",
      updatedAt,
    })

    logger.info(`[WEBHOOK] Order ${canonicalReference} updated`, {
      provider,
      status: providerStatus.normalizedStatus,
      providerStatusRaw: providerStatus.providerStatusRaw,
      matchedLookupValue: matchedLookupValue || null,
      providerReference,
      providerOrderNumber,
      found: result.found,
    })

    res.status(200).json({
      status: true,
      message: result.found ? "Webhook processed and order updated" : "Order not found, no update performed",
    })
  } catch (error) {
    console.error("Webhook processing failed:", error)
    res.status(500).json({ status: false, message: "Webhook processing failed" })
  }
})

// GiGSHUB webhook - HMAC-SHA256 signature verification using API key as secret
app.post("/webhook/gigshub", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""), "utf8")
    const signature = String(req.headers["x-gigshub-signature"] || "").trim()

    if (!CONFIG.gigshubApiKey) {
      logger.warn("[GIGSHUB WEBHOOK] Rejected: GiGSHUB not configured")
      return res.status(400).json({ status: false, message: "GiGSHUB not configured" })
    }

    const expectedSignature = crypto
      .createHmac("sha256", CONFIG.gigshubApiKey)
      .update(rawBody)
      .digest("hex")

    const sigValid = (() => {
      if (!signature || signature.length !== expectedSignature.length) return false
      try {
        return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedSignature, "hex"))
      } catch {
        return false
      }
    })()

    if (!sigValid) {
      logger.warn("[GIGSHUB WEBHOOK] Rejected: invalid signature", { ip: req.ip })
      return res.status(403).json({ status: false, message: "Invalid webhook signature" })
    }

    let payload
    try {
      payload = JSON.parse(rawBody.toString("utf8"))
    } catch {
      return res.status(400).json({ status: false, message: "Invalid JSON payload" })
    }

    const event = String(payload?.event || "").trim()
    logger.info("[GIGSHUB WEBHOOK] Received event", { event, ip: req.ip })

    if (event === "order.completed") {
      const data = payload?.data || {}
      const gigshubReference = String(data.reference || "").trim()

      if (!gigshubReference) {
        return res.status(400).json({ status: false, message: "Missing order reference in webhook data" })
      }

      const rawStatus = String(data.status || "delivered").trim()
      const statusForNormalization = rawStatus === "partial_failure" ? "failed" : rawStatus
      const normalizedStatus = normalizeInternalOrderStatus(statusForNormalization, "delivered")
      const updatedAt = Date.now()

      const located = await findOrderLocationByLookupValue(gigshubReference, {
        includeOrder: true,
        provider: "gigshub",
      })

      if (!located) {
        logger.warn("[GIGSHUB WEBHOOK] Order not found for reference", { gigshubReference })
        return res.status(200).json({ status: true, message: "Order not found, no update performed" })
      }

      const reference = String(located.order?.reference || "").trim()
      if (!reference) {
        return res.status(200).json({ status: true, message: "Could not resolve app reference" })
      }

      const syncFields = {
        lastAttemptAt: updatedAt,
        lastSuccessAt: updatedAt,
        lastError: "",
        lastProviderStatusRaw: rawStatus,
      }

      await updateOrderByReference(reference, {
        provider: "gigshub",
        providerReference: reference,
        providerOrderNumber: gigshubReference,
        providerStatusRaw: rawStatus,
        providerStatusDescription: rawStatus,
        status: normalizedStatus,
        statusSource: "webhook",
        statusUpdatedAt: updatedAt,
        updatedAt,
        sync: syncFields,
      })

      await syncPurchaseIntentFromOrder(reference, located.order, { errorMessage: "" }).catch(() => null)
      await upsertPurchaseIntent(reference, {
        provider: "gigshub",
        providerReference: reference,
        providerOrderNumber: gigshubReference,
        providerStatusRaw: rawStatus,
        providerStatusDescription: rawStatus,
        statusSource: "webhook",
        orderStatus: normalizedStatus,
        providerSubmissionStatus: isTerminalOrderStatus(normalizedStatus) ? "completed" : "submitted",
        paymentStatus: "success",
        errorMessage: "",
      }).catch(() => null)

      processedTransactions.add(reference, {
        reference,
        provider: "gigshub",
        providerReference: reference,
        providerOrderNumber: gigshubReference,
        status: normalizedStatus,
        providerStatusRaw: rawStatus,
        updatedFrom: "webhook",
        updatedAt,
      })

      logger.info(`[GIGSHUB WEBHOOK] Order ${reference} updated`, {
        gigshubReference,
        status: normalizedStatus,
        providerStatusRaw: rawStatus,
      })

      return res.status(200).json({ status: true, message: "Webhook processed and order updated" })
    }

    return res.status(200).json({ status: true, message: "Event received" })
  } catch (error) {
    logger.error("GiGSHUB webhook processing failed", error)
    return res.status(500).json({ status: false, message: "Webhook processing failed" })
  }
})

// Update Hubnet payload to include webhook
async function processHubnetTransaction(payload, network) {
  // Enhanced duplicate prevention - check reference first
  if (processedTransactions.has(payload.reference)) {
    const metadata = processedTransactions.get(payload.reference)
    if (metadata && metadata.hubnetResponse) {
      logger.info(`Transaction already processed`, { reference: payload.reference })
      return metadata.hubnetResponse
    }
    return {
      status: true,
      reason: "Already processed",
      code: "transaction already processed",
      message: "0000",
      transaction_id: `TXN-${payload.reference}`,
      reference: payload.reference,
      data: {
        status: true,
        code: "0000",
        message: "Order already processed.",
      },
    }
  }

  // Check for duplicate attempts
  const duplicateCheck = checkDuplicateAttempts(`${payload.phone}_${payload.volume}_${network}`, 'phone_transaction')
  if (duplicateCheck.isSuspicious) {
    logger.error("Suspicious duplicate attempts detected", {
      reference: payload.reference,
      phone: payload.phone,
      volume: payload.volume,
      network,
      attempts: duplicateCheck.count
    })
    throw new Error("SUSPICIOUS_ACTIVITY_DETECTED")
  }

  // Acquire phone-specific lock to prevent duplicate processing for same phone+volume+network
  const phoneLockAcquired = acquirePhoneTransactionLock(payload.phone, payload.volume, network)
  if (!phoneLockAcquired) {
    logger.warn(`Phone transaction lock conflict`, { 
      reference: payload.reference, 
      phone: payload.phone, 
      volume: payload.volume, 
      network 
    })
    recordDuplicateAttempt(`${payload.phone}_${payload.volume}_${network}`, 'phone_transaction')
    throw new Error("DUPLICATE_TRANSACTION_ATTEMPT")
  }

  try {
    const apiUrl = `https://console.hubnet.app/live/api/context/business/transaction/${network}-new-transaction`

    logger.info(`Processing Hubnet transaction`, { reference: payload.reference, network, apiUrl })

    const hubnetPayload = { ...payload }
    const webhookUrl = resolveHubnetWebhookUrl()
    if (webhookUrl) {
      hubnetPayload.webhook = webhookUrl
    }

    let data
    try {
      data = await fetchWithRetry(
        apiUrl,
        {
          method: "POST",
          headers: {
            token: `Bearer ${CONFIG.hubnetApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(hubnetPayload),
        },
        {
          circuitBreaker: hubnetCircuitBreaker,
          timeout: 15000,
          maxRetries: CONFIG.providerSubmissionMaxRetries,
        },
      )
    } catch (error) {
      const failure = classifyHubnetFailure(error?.responseData, error?.message)
      logger.error("Hubnet request failed", error, {
        reference: payload.reference,
        network,
        statusCode: error?.statusCode || null,
        providerMessage: failure.message,
        response: error?.responseData || null,
      })
      throw createAppError(failure.code, {
        providerMessage: failure.message,
        providerResponse: error?.responseData || null,
        statusCode: error?.statusCode || null,
        upstreamCode: error?.code || null,
      })
    }

    if (!isHubnetSuccessfulResponse(data)) {
      const failure = classifyHubnetFailure(data)
      logger.error("Hubnet transaction failed", new Error(failure.message), {
        reference: payload.reference,
        network,
        code: failure.code,
        response: data,
      })
      throw createAppError(failure.code, {
        providerMessage: failure.message,
        providerResponse: data,
      })
    }

    processedTransactions.add(payload.reference, {
      provider: "hubnet",
      network,
      phone: payload.phone,
      volume: payload.volume,
      hubnetResponse: data,
      processedAt: new Date().toISOString(),
    })

    logger.info(`Hubnet transaction successful`, { reference: payload.reference, transactionId: data.transaction_id })

    return data
  } finally {
    // Always release the phone lock
    releasePhoneTransactionLock(payload.phone, payload.volume, network)
  }
}

async function processGodswayTransaction(payload) {
  const networkKey = String(payload.networkKey || "").trim().toUpperCase()
  const recipient = sanitizePhoneNumber(payload.recipient)
  const capacity = String(payload.capacity || "").trim()
  const duplicateKey = `${recipient}_${capacity}_${networkKey}`

  if (processedTransactions.has(payload.reference)) {
    const metadata = processedTransactions.get(payload.reference)
    if (metadata && metadata.godswayResponse) {
      logger.info(`Godsway transaction already processed`, { reference: payload.reference })
      return metadata.godswayResponse
    }

    const cachedProviderOrderNumber = resolveStoredProviderOrderNumber(
      "godsway",
      metadata?.providerOrderNumber || metadata?.providerReference || "",
      payload.reference,
    )

    return {
      success: true,
      message: "Already processed",
      data: {
        orderNumber: cachedProviderOrderNumber,
        reference: payload.reference,
        status: "INITIATED",
        network: networkKey,
        recipient,
        statusDescription: "Order already processed.",
      },
    }
  }

  const duplicateCheck = checkDuplicateAttempts(duplicateKey, "phone_transaction")
  if (duplicateCheck.isSuspicious) {
    logger.error("Suspicious duplicate attempts detected for Godsway", {
      reference: payload.reference,
      phone: recipient,
      volume: capacity,
      networkKey,
      attempts: duplicateCheck.count,
    })
    throw new Error("SUSPICIOUS_ACTIVITY_DETECTED")
  }

  const phoneLockAcquired = acquirePhoneTransactionLock(recipient, `${capacity}_${networkKey}`, "godsway")
  if (!phoneLockAcquired) {
    logger.warn("Godsway phone transaction lock conflict", {
      reference: payload.reference,
      phone: recipient,
      volume: capacity,
      networkKey,
    })
    recordDuplicateAttempt(duplicateKey, "phone_transaction")
    throw new Error("DUPLICATE_TRANSACTION_ATTEMPT")
  }

  try {
    const apiUrl = `${String(CONFIG.godswayBaseUrl || "").replace(/\/$/, "")}/data-purchase`
    const requestData = {
      networkKey,
      recipient,
      capacity,
    }

    // Add webhook URL if available - send Godsway status updates to our server
    const webhookUrl = resolveGodswayWebhookUrl()
    if (webhookUrl) {
      requestData.webhook = webhookUrl
      requestData.callbackUrl = webhookUrl
    }

    logger.info("Processing Godsway transaction", {
      reference: payload.reference,
      apiUrl,
      requestData: {
        ...requestData,
        webhook: webhookUrl ? "[CONFIGURED]" : undefined,
        callbackUrl: webhookUrl ? "[CONFIGURED]" : undefined,
      },
    })

    let data
    try {
      data = await fetchWithRetry(
        apiUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": CONFIG.godswayApiKey,
          },
          body: JSON.stringify(requestData),
        },
        {
          circuitBreaker: godswayCircuitBreaker,
          timeout: 15000,
          maxRetries: CONFIG.providerSubmissionMaxRetries,
        },
      )
    } catch (error) {
      const failure = classifyGodswayFailure(error?.responseData, error?.message)
      logger.error("Godsway request failed", error, {
        reference: payload.reference,
        statusCode: error?.statusCode || null,
        providerMessage: failure.message,
        response: error?.responseData || null,
      })
      throw createAppError(failure.code, {
        providerMessage: failure.message,
        providerResponse: error?.responseData || null,
        statusCode: error?.statusCode || null,
        upstreamCode: error?.code || null,
      })
    }

    if (!data?.success) {
      const failure = classifyGodswayFailure(data, data?.error || data?.message)
      logger.error("Godsway transaction failed", new Error(failure.message), {
        reference: payload.reference,
        code: failure.code,
        response: data,
      })
      throw createAppError(failure.code, {
        providerMessage: failure.message,
        providerResponse: data,
      })
    }

    processedTransactions.add(payload.reference, {
      provider: "godsway",
      network: payload.network || null,
      networkKey,
      phone: recipient,
      volume: capacity,
      providerReference: resolveStoredProviderReference("godsway", data?.data?.orderNumber, payload.reference),
      providerOrderNumber: resolveStoredProviderOrderNumber("godsway", data?.data?.orderNumber, payload.reference),
      godswayResponse: data,
      telecelResponse: data,
      processedAt: new Date().toISOString(),
    })

    logger.info("Godsway transaction successful", {
      reference: payload.reference,
      orderNumber: data?.data?.orderNumber || null,
    })

    return data
  } finally {
    releasePhoneTransactionLock(recipient, `${capacity}_${networkKey}`, "godsway")
  }
}

async function processGigshubTransaction(payload) {
  const packageId = String(payload.packageId || "").trim()
  const recipient = sanitizePhoneNumber(payload.recipient)
  const reference = String(payload.reference || "").trim()
  const duplicateKey = `${recipient}_${packageId}_gigshub`

  if (processedTransactions.has(reference)) {
    const metadata = processedTransactions.get(reference)
    if (metadata && metadata.gigshubResponse) {
      logger.info("GiGSHUB transaction already processed", { reference })
      return metadata.gigshubResponse
    }
    return {
      success: true,
      message: "Already processed",
      reference: metadata?.providerReference || reference,
      status: "processing",
    }
  }

  const duplicateCheck = checkDuplicateAttempts(duplicateKey, "phone_transaction")
  if (duplicateCheck.isSuspicious) {
    logger.error("Suspicious duplicate attempts detected for GiGSHUB", {
      reference,
      phone: recipient,
      packageId,
      attempts: duplicateCheck.count,
    })
    throw new Error("SUSPICIOUS_ACTIVITY_DETECTED")
  }

  const phoneLockAcquired = acquirePhoneTransactionLock(recipient, `${packageId}_gigshub`, "gigshub")
  if (!phoneLockAcquired) {
    logger.warn("GiGSHUB phone transaction lock conflict", { reference, phone: recipient, packageId })
    recordDuplicateAttempt(duplicateKey, "phone_transaction")
    throw new Error("DUPLICATE_TRANSACTION_ATTEMPT")
  }

  try {
    const baseUrl = String(CONFIG.gigshubBaseUrl || "").replace(/\/$/, "")
    const apiUrl = `${baseUrl}/purchase`
    const requestBody = {
      items: [{ packageId: Number(packageId), quantity: 1, recipient }],
      description: reference,
    }

    const webhookUrl = resolveGigshubWebhookUrl()

    logger.info("Processing GiGSHUB transaction", {
      reference,
      apiUrl,
      packageId,
      recipient,
      webhook: webhookUrl ? "[CONFIGURED]" : undefined,
    })

    let data
    try {
      data = await fetchWithRetry(
        apiUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CONFIG.gigshubApiKey}`,
          },
          body: JSON.stringify(requestBody),
        },
        {
          circuitBreaker: gigshubCircuitBreaker,
          timeout: 15000,
          maxRetries: CONFIG.providerSubmissionMaxRetries,
        },
      )
    } catch (error) {
      const failure = classifyGigshubFailure(error?.responseData, error?.message)
      logger.error("GiGSHUB request failed", error, {
        reference,
        statusCode: error?.statusCode || null,
        providerMessage: failure.message,
        response: error?.responseData || null,
      })
      throw createAppError(failure.code, {
        providerMessage: failure.message,
        providerResponse: error?.responseData || null,
        statusCode: error?.statusCode || null,
        upstreamCode: error?.code || null,
      })
    }

    if (!data?.success) {
      const failure = classifyGigshubFailure(data, data?.error || data?.message)
      logger.error("GiGSHUB transaction failed", new Error(failure.message), {
        reference,
        code: failure.code,
        response: data,
      })
      throw createAppError(failure.code, {
        providerMessage: failure.message,
        providerResponse: data,
      })
    }

    processedTransactions.add(reference, {
      provider: "gigshub",
      phone: recipient,
      packageId,
      providerReference: data?.reference || null,
      gigshubResponse: data,
      processedAt: new Date().toISOString(),
    })

    logger.info("GiGSHUB transaction successful", {
      reference,
      gigshubReference: data?.reference || null,
      status: data?.status || null,
    })

    return data
  } finally {
    releasePhoneTransactionLock(recipient, `${packageId}_gigshub`, "gigshub")
  }
}

async function getGigshubOrderStatus(gigshubReference) {
  const providerRef = String(gigshubReference || "").trim()
  if (!providerRef) {
    throw createAppError("GIGSHUB_REFERENCE_MISSING", {
      providerMessage: "GiGSHUB status check requires the provider order reference.",
    })
  }

  const baseUrl = String(CONFIG.gigshubBaseUrl || "").replace(/\/$/, "")
  const apiUrl = `${baseUrl}/orders/${encodeURIComponent(providerRef)}`

  let data
  try {
    data = await fetchWithRetry(
      apiUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${CONFIG.gigshubApiKey}`,
          "Content-Type": "application/json",
        },
      },
      {
        circuitBreaker: gigshubCircuitBreaker,
        timeout: 12000,
        maxRetries: 1,
      },
    )
  } catch (error) {
    const failure = classifyGigshubFailure(error?.responseData, error?.message)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: error?.responseData || null,
      statusCode: error?.statusCode || null,
    })
  }

  if (!data?.success) {
    const failure = classifyGigshubFailure(data, data?.error || data?.message)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: data,
    })
  }

  const statusDetails = getGigshubStatusDetails(data)
  return {
    supported: true,
    provider: "gigshub",
    providerReference: providerRef,
    providerOrderNumber: providerRef,
    providerStatusRaw: statusDetails.providerStatusRaw,
    providerStatusDescription: statusDetails.providerStatusDescription,
    status: statusDetails.normalizedStatus,
    providerMeta: sanitizeProviderMeta("gigshub", data),
    providerResponse: data,
  }
}

function createProviderPurchaseMetadata(provider, response, reference, fallbackNetwork = "") {
  const now = Date.now()

  if (provider === "godsway") {
    const statusDetails = getGodswayStatusDetails(response)
    const providerOrderNumber = resolveStoredProviderOrderNumber("godsway", response?.data?.orderNumber, reference)
    const providerReference = resolveStoredProviderReference("godsway", response?.data?.orderNumber, reference, providerOrderNumber || "")
    return {
      provider,
      providerReference,
      providerOrderNumber,
      providerStatusRaw: statusDetails.providerStatusRaw || "INITIATED",
      providerStatusDescription: statusDetails.providerStatusDescription || "Order accepted by provider",
      providerMeta: sanitizeProviderMeta(provider, response),
      providerResponse: response,
      status: "accepted",
      statusSource: "provider_purchase",
      statusUpdatedAt: now,
      updatedAt: now,
    }
  }

  if (provider === "gigshub") {
    const statusDetails = getGigshubStatusDetails(response)
    const providerOrderNumber = String(response?.reference || "").trim() || null
    return {
      provider,
      providerReference: reference,
      providerOrderNumber,
      providerStatusRaw: statusDetails.providerStatusRaw || "processing",
      providerStatusDescription: statusDetails.providerStatusDescription || "Order accepted by GiGSHUB",
      providerMeta: sanitizeProviderMeta(provider, response),
      providerResponse: response,
      status: "accepted",
      statusSource: "provider_purchase",
      statusUpdatedAt: now,
      updatedAt: now,
    }
  }

  const statusDetails = getHubnetStatusDetails(response, "accepted")
  return {
    provider,
    providerReference: reference,
    providerOrderNumber: response?.transaction_id || response?.data?.transaction_id || null,
    providerStatusRaw: statusDetails.providerStatusRaw || "accepted",
    providerStatusDescription: statusDetails.providerStatusDescription || "Order accepted by provider",
    providerMeta: sanitizeProviderMeta(provider, response),
    providerResponse: response,
    network: normalizeNetwork(fallbackNetwork),
    status: "accepted",
    statusSource: "provider_purchase",
    statusUpdatedAt: now,
    updatedAt: now,
  }
}

async function getGodswayOrderStatus(reference) {
  const providerOrderNumber = String(reference || "").trim()
  if (!providerOrderNumber) {
    throw createAppError("GODSWAY_REFERENCE_MISSING", {
      providerMessage: "Godsway status check requires the provider order reference.",
    })
  }

  const configuredStatusUrl = resolveGodswayStatusBaseUrl()
  if (!configuredStatusUrl) {
    return {
      supported: false,
      skippedReason: "Godsway status polling is not configured. Set GODSWAY_STATUS_URL to enable it.",
    }
  }

  const baseStatusUrl = configuredStatusUrl
  const apiUrl = baseStatusUrl.includes("{reference}")
    ? baseStatusUrl.replace("{reference}", encodeURIComponent(providerOrderNumber))
    : baseStatusUrl.includes("{providerOrderNumber}")
      ? baseStatusUrl.replace("{providerOrderNumber}", encodeURIComponent(providerOrderNumber))
    : baseStatusUrl.includes("{orderNumber}")
      ? baseStatusUrl.replace("{orderNumber}", encodeURIComponent(providerOrderNumber))
      : `${baseStatusUrl}${baseStatusUrl.includes("?") ? "&" : "?"}reference=${encodeURIComponent(providerOrderNumber)}`
  let data

  try {
    data = await fetchWithRetry(
      apiUrl,
      {
        method: "GET",
        headers: {
          "X-API-Key": CONFIG.godswayApiKey,
        },
      },
      {
        circuitBreaker: godswayCircuitBreaker,
        timeout: 12000,
        maxRetries: 1,
      },
    )
  } catch (error) {
    if (isGodswayStatusEndpointUnavailable(error)) {
      logger.warn("Godsway status polling skipped because the configured endpoint is unavailable", {
        providerOrderNumber,
        url: error?.url || apiUrl,
        statusCode: error?.statusCode || null,
      })

      return {
        supported: false,
        skippedReason: "Godsway status endpoint is unavailable",
      }
    }

    const failure = classifyGodswayFailure(error?.responseData, error?.message)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: error?.responseData || null,
      statusCode: error?.statusCode || null,
    })
  }

  if (!data?.success) {
    const failure = classifyGodswayFailure(data, data?.error || data?.message)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: data,
    })
  }

  const statusDetails = getGodswayStatusDetails(data)
  const resolvedProviderOrderNumber = resolveStoredProviderOrderNumber(
    "godsway",
    data?.data?.orderNumber || providerOrderNumber,
    "",
  )
  return {
    supported: true,
    provider: "godsway",
    providerReference: resolveStoredProviderReference(
      "godsway",
      data?.data?.orderNumber || "",
      "",
      resolvedProviderOrderNumber || "",
    ),
    providerOrderNumber: resolvedProviderOrderNumber,
    providerStatusRaw: statusDetails.providerStatusRaw,
    providerStatusDescription: statusDetails.providerStatusDescription,
    status: statusDetails.normalizedStatus,
    providerMeta: sanitizeProviderMeta("godsway", data),
    providerResponse: data,
  }
}

async function getHubnetOrderStatus(order = {}) {
  const baseStatusUrl = resolveHubnetStatusBaseUrl()
  if (!baseStatusUrl) {
    return {
      supported: false,
      skippedReason: "Hubnet status polling is not configured",
    }
  }

  const reference = String(order.reference || order.providerReference || "").trim()
  const apiUrl = baseStatusUrl.includes("{reference}")
    ? baseStatusUrl.replace("{reference}", encodeURIComponent(reference))
    : `${baseStatusUrl}${baseStatusUrl.includes("?") ? "&" : "?"}reference=${encodeURIComponent(reference)}`

  let data
  try {
    data = await fetchWithRetry(
      apiUrl,
      {
        method: "GET",
        headers: {
          token: `Bearer ${CONFIG.hubnetApiKey}`,
          "Content-Type": "application/json",
        },
      },
      {
        circuitBreaker: hubnetCircuitBreaker,
        timeout: 12000,
        maxRetries: 1,
      },
    )
  } catch (error) {
    const failure = classifyHubnetFailure(error?.responseData, error?.message)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: error?.responseData || null,
      statusCode: error?.statusCode || null,
    })
  }

  const statusDetails = getHubnetStatusDetails(data, normalizeInternalOrderStatus(order.status, "processing"))
  return {
    supported: true,
    provider: "hubnet",
    providerReference: reference,
    providerOrderNumber: order.providerOrderNumber || data?.transaction_id || data?.data?.transaction_id || null,
    providerStatusRaw: statusDetails.providerStatusRaw,
    providerStatusDescription: statusDetails.providerStatusDescription,
    status: statusDetails.normalizedStatus,
    providerMeta: sanitizeProviderMeta("hubnet", data),
    providerResponse: data,
  }
}

const providerAdapters = {
  hubnet: {
    async purchase({ network, phone, reference, catalogEntry }) {
      assertProviderConfigured("hubnet", "purchase")
      const mapping = getPackageProviderMapping(network, "hubnet", catalogEntry)
      const response = await processHubnetTransaction(
        {
          phone,
          volume: String(mapping.volume || catalogEntry.volume),
          reference,
          referrer: phone,
        },
        mapping.network || network,
      )

      return createProviderPurchaseMetadata("hubnet", response, reference, mapping.network || network)
    },
    async getOrderStatus(order) {
      assertProviderConfigured("hubnet", "status")
      return await getHubnetOrderStatus(order)
    },
    async health() {
      let balance = null
      let balanceError = ""

      try {
        assertProviderConfigured("hubnet", "health")
      } catch (error) {
        return {
          provider: "hubnet",
          supportsBalanceCheck: true,
          breaker: hubnetCircuitBreaker.getState(),
          balance: null,
          balanceError: error?.providerMessage || error?.message || "HubNet is not configured",
        }
      }

      try {
        balance = await checkHubnetBalance()
      } catch (error) {
        balanceError = error?.providerMessage || error?.message || "Failed to load Hubnet balance"
      }

      return {
        provider: "hubnet",
        supportsBalanceCheck: true,
        breaker: hubnetCircuitBreaker.getState(),
        balance,
        balanceError,
      }
    },
  },
  godsway: {
    async purchase({ network, phone, reference, catalogEntry }) {
      assertProviderConfigured("godsway", "purchase")
      const mapping = getPackageProviderMapping(network, "godsway", catalogEntry)
      const response = await processGodswayTransaction({
        network,
        recipient: phone,
        reference,
        networkKey: mapping.networkKey,
        capacity: mapping.capacity,
      })

      return createProviderPurchaseMetadata("godsway", response, reference, network)
    },
    async getOrderStatus(order) {
      assertProviderConfigured("godsway", "status")
      // STRICTLY use godsway's own order number - DO NOT fall back to main app reference
      const rawProviderOrderNumber = String(order.providerOrderNumber || order.orderNumber || "").trim()
      const providerOrderNumber = resolveStoredProviderOrderNumber("godsway", rawProviderOrderNumber, order.reference)
      if (!providerOrderNumber) {
        return {
          supported: false,
          skippedReason: rawProviderOrderNumber
            ? "Stored Godsway provider order number matched the app reference and was ignored"
            : "Godsway provider order number not available - cannot query status with app reference",
        }
      }
      return await getGodswayOrderStatus(providerOrderNumber)
    },
    async health() {
      try {
        assertProviderConfigured("godsway", "health")
      } catch (error) {
        return {
          provider: "godsway",
          supportsBalanceCheck: false,
          breaker: godswayCircuitBreaker.getState(),
          balance: null,
          balanceError: error?.providerMessage || error?.message || "CK-Godsway is not configured",
        }
      }

      return {
        provider: "godsway",
        supportsBalanceCheck: false,
        breaker: godswayCircuitBreaker.getState(),
        balance: null,
        balanceError: "",
      }
    },
  },
  gigshub: {
    async purchase({ network, phone, reference, catalogEntry }) {
      assertProviderConfigured("gigshub", "purchase")
      const mapping = getPackageProviderMapping(network, "gigshub", catalogEntry)
      const response = await processGigshubTransaction({
        packageId: mapping.packageId,
        recipient: phone,
        reference,
      })
      return createProviderPurchaseMetadata("gigshub", response, reference, network)
    },
    async getOrderStatus(order) {
      assertProviderConfigured("gigshub", "status")
      const providerOrderNumber = String(order.providerOrderNumber || "").trim()
      if (!providerOrderNumber) {
        return {
          supported: false,
          skippedReason: "GiGSHUB provider order number not available - cannot query status",
        }
      }
      return await getGigshubOrderStatus(providerOrderNumber)
    },
    async health() {
      let balance = null
      let balanceError = ""

      try {
        assertProviderConfigured("gigshub", "health")
      } catch (error) {
        return {
          provider: "gigshub",
          supportsBalanceCheck: true,
          breaker: gigshubCircuitBreaker.getState(),
          balance: null,
          balanceError: error?.providerMessage || error?.message || "GiGSHUB is not configured",
        }
      }

      try {
        balance = await checkGigshubBalance()
      } catch (error) {
        balanceError = error?.providerMessage || error?.message || "Failed to load GiGSHUB balance"
      }

      return {
        provider: "gigshub",
        supportsBalanceCheck: true,
        breaker: gigshubCircuitBreaker.getState(),
        balance,
        balanceError,
      }
    },
  },
}

function getProviderAdapter(provider) {
  const safeProvider = normalizeProvider(provider)
  const adapter = providerAdapters[safeProvider]
  if (!adapter) {
    throw createAppError("UNSUPPORTED_PROVIDER", { provider: safeProvider })
  }

  return adapter
}

async function getOrderSyncHealthSummary() {
  const ordersSnapshot = await db.ref("order_refs").once("value")
  const summary = {
    totalOpen: 0,
    staleOpen: 0,
    byProvider: {},
  }
  const now = Date.now()

  for (const provider of SUPPORTED_PROVIDERS) {
    summary.byProvider[provider] = {
      open: 0,
      stale: 0,
      lastError: "",
    }
  }

  if (!ordersSnapshot.exists()) {
    return summary
  }

  const ordersData = ordersSnapshot.val() || {}
  for (const reference of Object.keys(ordersData)) {
    const order = ordersData[reference] || {}
    if (isTerminalOrderStatus(order.status)) {
      continue
    }

    const provider = normalizeProvider(order.provider, "hubnet")
    const nextAttemptAt = toTimestampValue(order.nextAttemptAt, 0) || 0
    const isStale = nextAttemptAt > 0 ? nextAttemptAt <= now : true

    summary.totalOpen += 1
    summary.byProvider[provider] ??= { open: 0, stale: 0, lastError: "" }
    summary.byProvider[provider].open += 1

    if (isStale) {
      summary.staleOpen += 1
      summary.byProvider[provider].stale += 1
    }

    if (order?.lastError) {
      summary.byProvider[provider].lastError = order.lastError
    }
  }

  return summary
}

async function getProviderHealthSnapshot() {
  const [routing, sync, syncStateSnapshot, hubnetHealth, godswayHealth, gigshubHealth] = await Promise.all([
    getProviderRoutingConfig(),
    getOrderSyncHealthSummary(),
    db.ref(ORDER_SYNC_STATE_PATH).once("value"),
    providerAdapters.hubnet.health(),
    providerAdapters.godsway.health(),
    providerAdapters.gigshub.health(),
  ])

  return {
    routing,
    sync,
    syncState: syncStateSnapshot.exists() ? syncStateSnapshot.val() || {} : {},
    providers: {
      hubnet: hubnetHealth,
      godsway: godswayHealth,
      gigshub: gigshubHealth,
    },
    timestamp: new Date().toISOString(),
  }
}

function getProviderErrorHttpStatus(errorCode) {
  if (errorCode === "DUPLICATE_TRANSACTION_ATTEMPT" || errorCode === "WALLET_TRANSACTION_ABORTED") {
    return 409
  }

  if (errorCode === "HUBNET_RATE_LIMITED" || errorCode === "GODSWAY_RATE_LIMITED" || errorCode === "GIGSHUB_RATE_LIMITED") {
    return 429
  }

  if (errorCode === "HUBNET_AUTH_FAILED" || errorCode === "GODSWAY_AUTH_FAILED" || errorCode === "GIGSHUB_AUTH_FAILED") {
    return 502
  }

  if (errorCode === "INSUFFICIENT_HUBNET_BALANCE" || errorCode === "INSUFFICIENT_GODSWAY_BALANCE" || errorCode === "INSUFFICIENT_GIGSHUB_BALANCE") {
    return 503
  }

  if (errorCode === "PACKAGE_PROVIDER_MAPPING_MISSING") {
    return 400
  }

  if (errorCode === "PROVIDER_CONFIGURATION_MISSING") {
    return 500
  }

  if (errorCode === "GODSWAY_REFERENCE_MISSING" || errorCode === "GIGSHUB_REFERENCE_MISSING") {
    return 400
  }

  if (errorCode === "GIGSHUB_INVALID_PACKAGE") {
    return 400
  }

  return 500
}

function getProviderErrorMessage(error, errorCode, fallback = "Provider request failed") {
  if (error?.providerMessage) {
    return error.providerMessage
  }

  if (errorCode === "HUBNET_AUTH_FAILED") {
    return "Hubnet API authentication failed. Update HUBNET_API_KEY."
  }

  if (errorCode === "GODSWAY_AUTH_FAILED") {
    return "Godsway API authentication failed. Update GODSWAY_API_KEY."
  }

  if (errorCode === "GIGSHUB_AUTH_FAILED") {
    return "GiGSHUB API authentication failed. Update GIGSHUB_API_KEY."
  }

  if (errorCode === "HUBNET_RATE_LIMITED") {
    return "Hubnet API rate limit reached. Please try again shortly."
  }

  if (errorCode === "GODSWAY_RATE_LIMITED") {
    return "Godsway API rate limit reached. Please try again shortly."
  }

  if (errorCode === "GIGSHUB_RATE_LIMITED") {
    return "GiGSHUB API rate limit reached. Please try again shortly."
  }

  if (errorCode === "INSUFFICIENT_HUBNET_BALANCE" || errorCode === "INSUFFICIENT_GODSWAY_BALANCE" || errorCode === "INSUFFICIENT_GIGSHUB_BALANCE") {
    return "Service provider has insufficient balance"
  }

  if (errorCode === "PACKAGE_PROVIDER_MAPPING_MISSING") {
    return "Selected package is not configured for the active provider route."
  }

  if (errorCode === "GODSWAY_REFERENCE_MISSING" || errorCode === "GIGSHUB_REFERENCE_MISSING") {
    return "Provider status check requires the provider order reference."
  }

  if (errorCode === "GIGSHUB_INVALID_PACKAGE") {
    return "GiGSHUB rejected the selected package. Check the package ID configuration."
  }

  return fallback
}

function isIndeterminateProviderSubmissionError(error) {
  const errorCode = getErrorCode(error)
  const upstreamCode = String(error?.upstreamCode || "").trim().toUpperCase()
  const statusCode = Number(error?.statusCode || 0)

  if (["REQUEST_TIMEOUT", "NETWORK_ERROR"].includes(upstreamCode)) {
    return true
  }

  if (["HUBNET_API_ERROR", "GODSWAY_API_ERROR", "GIGSHUB_API_ERROR"].includes(errorCode) && (!statusCode || statusCode >= 500)) {
    return true
  }

  return false
}

function getIndeterminateProviderSubmissionMessage(provider = "") {
  const normalized = normalizeProvider(provider)
  const providerLabel =
    normalized === "godsway"
      ? "CK-Godsway"
      : normalized === "hubnet"
        ? "Hubnet"
        : normalized === "gigshub"
          ? "GiGSHUB"
          : "provider"

  return `${providerLabel} did not return a final confirmation. Do not retry this purchase yet; it is pending review.`
}

let reconciliationInFlight = false

function getOrderSyncBackoffDelay(attempt) {
  const multiplier = Math.max(0, Number(attempt || 1) - 1)
  return Math.min(CONFIG.orderSyncRetryDelayMs * Math.pow(2, multiplier), 15 * 60 * 1000)
}

async function acquireOrderSyncLease() {
  const leaseRef = db.ref(ORDER_SYNC_LEASE_PATH)
  for (let attempt = 1; attempt <= CONFIG.orderSyncLeaseRetryCount; attempt++) {
    const now = Date.now()
    let acquired = false

    try {
      await leaseRef.transaction((current) => {
        const existing = current && typeof current === "object" ? current : {}
        const expiresAt = Number(existing.expiresAt || 0)

        if (expiresAt > now && existing.instanceId && existing.instanceId !== INSTANCE_ID) {
          return
        }

        acquired = true
        return {
          instanceId: INSTANCE_ID,
          acquiredAt: now,
          expiresAt: now + CONFIG.orderSyncLeaseMs,
        }
      })

      return acquired
    } catch (error) {
      if (!isTransientRealtimeDisconnectError(error)) {
        throw error
      }

      logger.warn("Order sync lease acquire hit transient database error", {
        attempt,
        error: error.message || error,
      })

      if (attempt < CONFIG.orderSyncLeaseRetryCount) {
        const jitter = Math.floor(Math.random() * CONFIG.orderSyncLeaseRetryBaseMs)
        await sleep(CONFIG.orderSyncLeaseRetryBaseMs * attempt + jitter)
      }
    }
  }

  return false
}

async function releaseOrderSyncLease() {
  try {
    const leaseRef = db.ref(ORDER_SYNC_LEASE_PATH)
    const snapshot = await leaseRef.once("value").catch(() => null)
    if (!snapshot?.exists()) {
      return
    }

    const current = snapshot.val() || {}
    if (current.instanceId === INSTANCE_ID) {
      await leaseRef.remove().catch(() => null)
    }
  } catch (error) {
    logger.warn("Order sync lease release skipped after database error", {
      error: error?.message || error,
    })
  }
}

async function getOpenOrderLocationsForSync(limit = CONFIG.orderSyncMaxPerRun) {
  const indexSnapshot = await db.ref("order_refs").once("value")
  if (!indexSnapshot.exists()) {
    return []
  }

  const now = Date.now()
  const rows = []
  const indexRows = Object.entries(indexSnapshot.val() || {})
    .map(([reference, value]) => ({
      reference,
      ...(value || {}),
    }))
    .filter((item) => item.reference && !isTerminalOrderStatus(item.status))
    .sort((a, b) => {
      const aAttempt = toTimestampValue(a.lastAttemptAt, a.updatedAt || 0) || 0
      const bAttempt = toTimestampValue(b.lastAttemptAt, b.updatedAt || 0) || 0
      return aAttempt - bAttempt
    })

  for (const item of indexRows) {
    const nextAttemptAt = toTimestampValue(item.nextAttemptAt, 0) || 0
    if (nextAttemptAt && nextAttemptAt > now) {
      continue
    }

    const userId = String(item.userId || "").trim()
    const orderId = String(item.orderId || "").trim()
    if (!userId || !orderId) {
      continue
    }

    const orderSnapshot = await db.ref(`orders/${userId}/${orderId}`).once("value").catch(() => null)
    if (!orderSnapshot?.exists()) {
      await db.ref(`order_refs/${item.reference}`).remove().catch(() => null)
      continue
    }

    const order = normalizeStoredOrderRecord(orderSnapshot.val() || {})
    if (!order.reference || isTerminalOrderStatus(order.status)) {
      await setOrderReferenceIndex(item.reference, {
        userId,
        orderId,
        provider: order.provider,
        network: order.network,
        status: order.status,
        sync: order.sync,
      })
      continue
    }

    rows.push({
      userId,
      orderId,
      order,
    })

    if (rows.length >= Math.max(1, Number(limit || 1))) {
      break
    }
  }

  return rows
}

async function reconcileSingleOrderStatus(orderLocation) {
  const order = normalizeStoredOrderRecord(orderLocation?.order || {})
  if (!order.reference) {
    return { synced: false, skipped: true, reason: "Missing reference" }
  }

  const provider = normalizeProvider(order.provider, DEFAULT_PROVIDER_ROUTING[order.network] || "hubnet")
  const now = Date.now()
  const attempts = Number(order?.sync?.attempts || 0) + 1

  try {
    const adapter = getProviderAdapter(provider)
    const result = await adapter.getOrderStatus(order)

    if (result?.supported === false) {
      await updateOrderByReference(order.reference, {
        sync: {
          attempts,
          lastAttemptAt: now,
          nextAttemptAt: now + getOrderSyncBackoffDelay(attempts),
          skippedReason: result.skippedReason || "Status polling not supported",
          lastError: "",
        },
      })

      return { synced: false, skipped: true, reason: result.skippedReason || "Status polling not supported" }
    }

    const nextStatus = normalizeInternalOrderStatus(result?.status, order.status || "pending")
    const nextProviderOrderNumber = resolveStoredProviderOrderNumber(
      provider,
      result?.providerOrderNumber || order.providerOrderNumber || null,
      order.reference,
    )
    const nextProviderReference = resolveStoredProviderReference(
      provider,
      result?.providerReference || order.providerReference || "",
      order.reference,
      nextProviderOrderNumber || "",
    )
    const updateResult = await updateOrderByReference(order.reference, {
      provider,
      providerReference: nextProviderReference,
      providerOrderNumber: nextProviderOrderNumber,
      providerStatusRaw: result?.providerStatusRaw || order.providerStatusRaw || "",
      providerStatusDescription: result?.providerStatusDescription || order.providerStatusDescription || "",
      providerMeta: {
        ...(order.providerMeta || {}),
        ...(result?.providerMeta || {}),
      },
      providerResponse: result?.providerResponse || null,
      status: nextStatus,
      statusSource: "provider_status",
      statusUpdatedAt: now,
      updatedAt: now,
      sync: {
        attempts,
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastError: "",
        nextAttemptAt: isTerminalOrderStatus(nextStatus) ? null : now + getOrderSyncBackoffDelay(attempts),
        skippedReason: "",
        lastProviderStatusRaw: result?.providerStatusRaw || "",
      },
    })
    await syncPurchaseIntentFromOrder(order.reference, updateResult.order || {
      ...order,
      provider,
      providerReference: nextProviderReference,
      providerOrderNumber: nextProviderOrderNumber,
      providerStatusRaw: result?.providerStatusRaw || order.providerStatusRaw || "",
      providerStatusDescription: result?.providerStatusDescription || order.providerStatusDescription || "",
      status: nextStatus,
    }).catch(() => null)

    return { synced: true, status: nextStatus, provider }
  } catch (error) {
    const errorCode = getErrorCode(error)
    const message = getProviderErrorMessage(error, errorCode, "Failed to sync provider status")
    const nextAttemptAt =
      attempts >= CONFIG.orderSyncMaxAttempts ? now + 6 * 60 * 60 * 1000 : now + getOrderSyncBackoffDelay(attempts)

    await updateOrderByReference(order.reference, {
      sync: {
        attempts,
        lastAttemptAt: now,
        lastError: message,
        nextAttemptAt,
        skippedReason: attempts >= CONFIG.orderSyncMaxAttempts ? "Max sync attempts reached" : "",
      },
    })

    return { synced: false, error: message, provider, errorCode }
  }
}

async function runOrderStatusReconciliation() {
  if (reconciliationInFlight) {
    logger.warn("Order reconciliation skipped because the current instance is already running")
    return
  }

  reconciliationInFlight = true
  let leaseAcquired = false
  try {
    leaseAcquired = await acquireOrderSyncLease()
  } catch (error) {
    reconciliationInFlight = false
    throw error
  }

  if (!leaseAcquired) {
    await db.ref(ORDER_SYNC_STATE_PATH).update({
      instanceId: INSTANCE_ID,
      running: false,
      lastSkippedAt: Date.now(),
      skipReason: "Lease unavailable or database temporarily disconnected",
    }).catch(() => null)
    reconciliationInFlight = false
    return
  }

  const startedAt = Date.now()
  const stats = {
    instanceId: INSTANCE_ID,
    running: true,
    lastRunAt: startedAt,
    processed: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    lastError: "",
  }

  try {
    await db.ref(ORDER_SYNC_STATE_PATH).update(stats)
    const openOrders = await getOpenOrderLocationsForSync(CONFIG.orderSyncMaxPerRun)

    for (const orderLocation of openOrders) {
      const result = await reconcileSingleOrderStatus(orderLocation)
      stats.processed += 1

      if (result.synced) {
        stats.synced += 1
      } else if (result.skipped) {
        stats.skipped += 1
      } else {
        stats.failed += 1
        stats.lastError = result.error || stats.lastError
      }
    }
  } catch (error) {
    stats.failed += 1
    stats.lastError = error?.message || "Order reconciliation failed"
    logger.error("Order reconciliation failed", error)
  } finally {
    await db.ref(ORDER_SYNC_STATE_PATH).update({
      ...stats,
      running: false,
      lastCompletedAt: Date.now(),
    })
    await releaseOrderSyncLease()
    reconciliationInFlight = false
  }
}

app.get("/health", (req, res) => {
  const memUsage = process.memoryUsage()
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
    environment: CONFIG.nodeEnv,
    services: {
      paystack: paystackCircuitBreaker.getState(),
      hubnet: hubnetCircuitBreaker.getState(),
      godsway: godswayCircuitBreaker.getState(),
      gigshub: gigshubCircuitBreaker.getState(),
    },
    processedTransactions: processedTransactions._store.size,
    security: {
      activeTransactionLocks: transactionLocks.size,
      activePhoneLocks: phoneTransactionLocks.size,
      activeUserLocks: userTransactionLocks.size,
      duplicateAttempts: duplicateAttempts.size,
    },
  })
})

app.get("/", (req, res) => {
  res.json({
    name: "PBM DATA HUB API",
    version: "5.0.0",
    status: "running",
    timestamp: new Date().toISOString(),
  })
})

app.get("/api/packages/:network", async (req, res) => {
  const network = normalizeNetwork(req.params.network)

  if (!SUPPORTED_PACKAGE_NETWORKS.includes(network)) {
    return res.status(400).json({
      status: "error",
      message: "Unsupported network",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    const rows = await getCatalogPackages(network)
    return res.json({
      status: "success",
      data: rows.map((entry) => toPublicCatalogEntry(entry)),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load package catalog", error, { network })
    return res.status(500).json({
      status: "error",
      message: "Failed to load package catalog",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/admin/packages/:network", authenticateRequest, requirePrivilegedAccess, async (req, res) => {
  const network = normalizeNetwork(req.params.network)

  if (!SUPPORTED_PACKAGE_NETWORKS.includes(network)) {
    return res.status(400).json({
      status: "error",
      message: "Unsupported network",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    const activeProvider = await getActiveProviderForNetwork(network)
    const rows = await getCatalogPackages(network, { includeDisabled: true })
    return res.json({
      status: "success",
      data: rows,
      activeProvider,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load admin package catalog", error, { network, uid: req.authUser.uid })
    return res.status(500).json({
      status: "error",
      message: "Failed to load package catalog",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/admin/provider-routing", authenticateRequest, requirePrivilegedAccess, async (req, res) => {
  try {
    const snapshot = await getProviderRoutingRef().once("value")
    const current = snapshot.exists() ? snapshot.val() || {} : {}

    return res.json({
      status: "success",
      data: {
        routing: normalizeProviderRouting(current),
        updatedAt: toTimestampValue(current.updatedAt, null),
        updatedBy: current.updatedBy || null,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load provider routing", error, { uid: req.authUser.uid })
    return res.status(500).json({
      status: "error",
      message: "Failed to load provider routing",
      timestamp: new Date().toISOString(),
    })
  }
})

app.put("/api/admin/provider-routing", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  const requestedRouting = req.body?.routing
  const source = requestedRouting && typeof requestedRouting === "object" ? requestedRouting : req.body || {}

  for (const network of SUPPORTED_PACKAGE_NETWORKS) {
    const requestedProvider = source?.[network]
    if (requestedProvider != null && !normalizeProvider(requestedProvider)) {
      return res.status(400).json({
        status: "error",
        message: `Invalid provider for ${network}. Supported values: ${SUPPORTED_PROVIDERS.join(", ")}`,
        timestamp: new Date().toISOString(),
      })
    }
  }

  try {
    const routing = normalizeProviderRouting(source)
    await validateProviderSecretsForRouting(routing)

    for (const network of SUPPORTED_PACKAGE_NETWORKS) {
      const rows = await getCatalogPackages(network, { includeDisabled: true })
      const invalidEntry = rows.find((entry) => entry.enabled !== false && !isCompleteProviderMapping(network, routing[network], entry))
      if (invalidEntry) {
        return res.status(400).json({
          status: "error",
          message: `Cannot route ${network.toUpperCase()} to ${routing[network]} until package ${invalidEntry.label} has complete provider mapping.`,
          timestamp: new Date().toISOString(),
        })
      }
    }

    await getProviderRoutingRef().set({
      ...routing,
      updatedAt: Date.now(),
      updatedBy: req.authUser.uid,
    })
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.provider_routing.update",
      status: "success",
      metadata: { routing },
    }).catch(() => null)

    return res.json({
      status: "success",
      message: "Provider routing updated",
      data: {
        routing,
        updatedAt: Date.now(),
        updatedBy: req.authUser.uid,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to update provider routing", error, { uid: req.authUser.uid })
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.provider_routing.update",
      status: "failed",
      metadata: { error: error?.providerMessage || error?.message || "Unknown error" },
    }).catch(() => null)
    return res.status(getErrorCode(error) === "PROVIDER_CONFIGURATION_MISSING" ? 400 : 500).json({
      status: "error",
      message: error?.providerMessage || "Failed to update provider routing",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/admin/provider-health", authenticateRequest, requirePrivilegedAccess, async (req, res) => {
  try {
    const data = await getProviderHealthSnapshot()
    return res.json({
      status: "success",
      data,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load provider health", error, { uid: req.authUser.uid })
    return res.status(500).json({
      status: "error",
      message: "Failed to load provider health",
      timestamp: new Date().toISOString(),
    })
  }
})

app.put("/api/admin/packages/:network", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  const network = normalizeNetwork(req.params.network)
  const packages = Array.isArray(req.body?.packages) ? req.body.packages : []

  if (!SUPPORTED_PACKAGE_NETWORKS.includes(network)) {
    return res.status(400).json({
      status: "error",
      message: "Unsupported network",
      timestamp: new Date().toISOString(),
    })
  }

  if (!packages.length) {
    return res.status(400).json({
      status: "error",
      message: "At least one package row is required",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    const payload = {}
    const activeProvider = await getActiveProviderForNetwork(network)

    packages.forEach((entry) => {
      const normalized = normalizeCatalogEntry(
        {
          ...entry,
          updatedAt: Date.now(),
          updatedBy: req.authUser.uid,
        },
        entry?.id || `${entry?.volume || "pkg"}-${Math.round(Number(entry?.userPrice || 0) * 100)}`,
        network,
      )

      if (!normalized) {
        return
      }

      payload[normalized.id] = normalized
    })

    if (!Object.keys(payload).length) {
      return res.status(400).json({
        status: "error",
        message: "No valid package rows were provided",
        timestamp: new Date().toISOString(),
      })
    }

    const invalidEntry = Object.values(payload).find(
      (entry) => entry.enabled !== false && !isCompleteProviderMapping(network, activeProvider, entry),
    )
    if (invalidEntry) {
      return res.status(400).json({
        status: "error",
        message: `Package ${invalidEntry.label} is missing ${activeProvider} mapping for the current route.`,
        timestamp: new Date().toISOString(),
      })
    }

    await getCatalogRef(network).set(payload)
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.package_catalog.update",
      targetRef: network,
      status: "success",
      metadata: {
        network,
        totalPackages: Object.keys(payload).length,
        activeProvider,
      },
    }).catch(() => null)

    return res.json({
      status: "success",
      message: "Package catalog updated",
      data: Object.values(payload).sort((a, b) => Number(a.sortOrder || a.volume) - Number(b.sortOrder || b.volume)),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to update package catalog", error, { network, uid: req.authUser.uid })
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.package_catalog.update",
      targetRef: network,
      status: "failed",
      metadata: { error: error?.message || "Unknown error" },
    }).catch(() => null)
    return res.status(500).json({
      status: "error",
      message: "Failed to update package catalog",
      timestamp: new Date().toISOString(),
    })
  }
})

app.post("/api/admin/users/:userId/credit-wallet", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  const userId = String(req.params.userId || "").trim()
  const amount = toMoneyNumber(req.body?.amount, 0)
  const mutationId = sanitizeMutationId(`admin-credit:${userId}:${req.authUser.uid}:${Date.now()}`)

  if (!userId || amount <= 0) {
    return res.status(400).json({
      status: "error",
      message: "Valid userId and amount are required",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    const balance = await updateWalletBalance(userId, amount, {
      mutationId,
      reason: "admin_credit",
      details: {
        actorUid: req.authUser.uid,
      },
    })
    const transaction = await recordTransaction({
      userId,
      type: "admin_credit",
      amount,
      balance,
      mutationId,
      details: {
        creditedBy: req.authUser.uid,
        creditedByEmail: req.authUser.email || null,
      },
    })
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.wallet.credit",
      targetUid: userId,
      status: "success",
      metadata: { amount, mutationId, balance },
    }).catch(() => null)

    return res.json({
      status: "success",
      message: "Wallet credited successfully",
      data: {
        balance,
        transaction,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to credit wallet", error, { userId, adminUid: req.authUser.uid })
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.wallet.credit",
      targetUid: userId,
      status: "failed",
      metadata: { amount, error: error?.message || "Unknown error" },
    }).catch(() => null)
    return res.status(500).json({
      status: "error",
      message: "Failed to credit wallet",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/admin/overview", authenticateRequest, requirePrivilegedAccess, async (req, res) => {
  try {
    const data = await getAdminOverviewData()
    return res.json({
      status: "success",
      data,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load admin overview", error, { uid: req.authUser.uid })
    return res.status(500).json({
      status: "error",
      message: "Failed to load admin overview",
      timestamp: new Date().toISOString(),
    })
  }
})

app.patch("/api/admin/orders/bulk-status", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  const startDate = String(req.body?.startDate || "").trim()
  const endDate = String(req.body?.endDate || "").trim()
  const currentStatus = String(req.body?.currentStatus || "").trim()
  const nextStatus = String(req.body?.nextStatus || "").trim()

  try {
    const result = await bulkUpdateOrdersStatus({
      startDate,
      endDate,
      currentStatus,
      nextStatus,
      actorUid: req.authUser.uid,
    })

    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.order.bulk_status_update",
      status: "success",
      metadata: {
        startDate,
        endDate,
        currentStatus: result.currentStatus,
        nextStatus: result.nextStatus,
        matched: result.matched,
        updated: result.updated,
        byProvider: result.byProvider,
      },
    }).catch(() => null)

    return res.json({
      status: "success",
      message: `Updated ${result.updated} orders from ${result.currentStatus} to ${result.nextStatus}.`,
      data: result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to bulk update order statuses", error, {
      adminUid: req.authUser.uid,
      startDate,
      endDate,
      currentStatus,
      nextStatus,
    })
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.order.bulk_status_update",
      status: "failed",
      metadata: {
        startDate,
        endDate,
        currentStatus,
        nextStatus,
        error: error?.providerMessage || error?.message || "Unknown error",
      },
    }).catch(() => null)

    const errorCode = getErrorCode(error)
    const statusCode = String(errorCode || "").startsWith("ADMIN_ORDER_BULK_") ? 400 : 500
    return res.status(statusCode).json({
      status: "error",
      message: error?.providerMessage || "Failed to bulk update order statuses",
      timestamp: new Date().toISOString(),
    })
  }
})

app.patch("/api/admin/users/:userId/role", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  const userId = String(req.params.userId || "").trim()
  const hasAgentUpdate = Object.prototype.hasOwnProperty.call(req.body || {}, "isagent")
  const hasAdminUpdate = Object.prototype.hasOwnProperty.call(req.body || {}, "isadmin")
  const isAgent = req.body?.isagent === true
  const isAdmin = req.body?.isadmin === true

  if (!userId) {
    return res.status(400).json({
      status: "error",
      message: "Valid userId is required",
      timestamp: new Date().toISOString(),
    })
  }

  if (!hasAgentUpdate && !hasAdminUpdate) {
    return res.status(400).json({
      status: "error",
      message: "At least one role flag is required",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    const userSnapshot = await db.ref(`users/${userId}`).once("value")
    const existingUser = userSnapshot.exists() ? userSnapshot.val() || {} : {}
    if (hasAdminUpdate && isAdmin !== true && userId === req.authUser.uid) {
      const adminsSnapshot = await db.ref("users").orderByChild("isadmin").equalTo(true).once("value")
      const otherAdminIds = adminsSnapshot.exists()
        ? Object.keys(adminsSnapshot.val() || {}).filter((uid) => uid !== userId)
        : []

      if (!otherAdminIds.length) {
        return res.status(400).json({
          status: "error",
          message: "You cannot remove admin access from the last admin account.",
          timestamp: new Date().toISOString(),
        })
      }
    }

    const updates = {
      updatedAt: Date.now(),
      isagent: hasAgentUpdate ? isAgent : existingUser.isagent === true,
      isadmin: hasAdminUpdate ? isAdmin : existingUser.isadmin === true,
    }

    await db.ref(`users/${userId}`).update(updates)
    if (hasAdminUpdate) {
      if (isAdmin) {
        await db.ref(`admins/${userId}`).set(true).catch(() => null)
      } else {
        await db.ref(`admins/${userId}`).remove().catch(() => null)
      }
    }

    const messageParts = []
    if (hasAgentUpdate) {
      messageParts.push(isAgent ? "User promoted to agent" : "Agent role revoked")
    }
    if (hasAdminUpdate) {
      messageParts.push(isAdmin ? "Admin access granted" : "Admin access revoked")
    }
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.user.role_update",
      targetUid: userId,
      status: "success",
      metadata: {
        ...(hasAgentUpdate ? { isagent: isAgent } : {}),
        ...(hasAdminUpdate ? { isadmin: isAdmin } : {}),
      },
    }).catch(() => null)

    return res.json({
      status: "success",
      message: messageParts.join(". "),
      data: {
        userId,
        isagent: updates.isagent,
        isadmin: updates.isadmin,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to update user role", error, { userId, adminUid: req.authUser.uid })
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.user.role_update",
      targetUid: userId,
      status: "failed",
      metadata: {
        ...(hasAgentUpdate ? { isagent: isAgent } : {}),
        ...(hasAdminUpdate ? { isadmin: isAdmin } : {}),
        error: error?.message || "Unknown error",
      },
    }).catch(() => null)
    return res.status(500).json({
      status: "error",
      message: "Failed to update user role",
      timestamp: new Date().toISOString(),
    })
  }
})

app.delete("/api/admin/users/:userId", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  const userId = String(req.params.userId || "").trim()
  if (!userId) {
    return res.status(400).json({
      status: "error",
      message: "Valid userId is required",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    const ordersSnapshot = await db.ref(`orders/${userId}`).once("value")
    const orderRefs = ordersSnapshot.exists() ? Object.values(ordersSnapshot.val() || {}).map((item) => String(item?.reference || "").trim()).filter(Boolean) : []

    const [transactionsSnap, afaSnap, receiptsSnap] = await Promise.all([
      db.ref("transactions").orderByChild("userId").equalTo(userId).once("value"),
      db.ref("afa_registrations").orderByChild("userId").equalTo(userId).once("value"),
      db.ref("payment_receipts").orderByChild("userId").equalTo(userId).once("value"),
    ])

    const updates = {
      [`users/${userId}`]: null,
      [`admins/${userId}`]: null,
      [`wallets/${userId}`]: null,
      [`orders/${userId}`]: null,
      [`user_tokens/${userId}`]: null,
      [`wallet_mutations/${userId}`]: null,
      [`transaction_refs/${userId}`]: null,
      [`idempotency_keys/${userId}`]: null,
    }

    for (const reference of orderRefs) {
      updates[`order_refs/${reference}`] = null
      updates[`${PURCHASE_INTENT_PATH}/${reference}`] = null
    }

    if (transactionsSnap.exists()) {
      Object.keys(transactionsSnap.val() || {}).forEach((key) => {
        updates[`transactions/${key}`] = null
      })
    }

    if (afaSnap.exists()) {
      Object.keys(afaSnap.val() || {}).forEach((key) => {
        updates[`afa_registrations/${key}`] = null
      })
    }

    if (receiptsSnap.exists()) {
      Object.keys(receiptsSnap.val() || {}).forEach((key) => {
        updates[`payment_receipts/${key}`] = null
      })
    }

    await db.ref().update(updates)
    await admin.auth().deleteUser(userId).catch((error) => {
      if (error?.code !== "auth/user-not-found") {
        throw error
      }
    })
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.user.delete",
      targetUid: userId,
      status: "success",
      metadata: { deletedOrders: orderRefs.length },
    }).catch(() => null)

    return res.json({
      status: "success",
      message: "User deleted successfully",
      data: { userId },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to delete user", error, { userId, adminUid: req.authUser.uid })
    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.user.delete",
      targetUid: userId,
      status: "failed",
      metadata: { error: error?.message || "Unknown error" },
    }).catch(() => null)
    return res.status(500).json({
      status: "error",
      message: "Failed to delete user",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/afa/fee", async (req, res) => {
  try {
    const fee = await getAfaRegistrationFee()
    return res.json({
      status: "success",
      data: { fee },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load AFA fee", error)
    return res.status(500).json({
      status: "error",
      message: "Failed to load AFA registration fee",
      timestamp: new Date().toISOString(),
    })
  }
})

app.post("/api/afa/register", authenticateRequest, async (req, res) => {
  const userId = req.authUser.uid
  const fullname = String(req.body?.fullname || "").trim()
  const phone = sanitizePhoneNumber(req.body?.phone)
  const dob = String(req.body?.dob || "").trim()
  const ghanaCard = String(req.body?.ghanaCard || "").trim()
  const location = String(req.body?.location || "").trim()

  if (!fullname || phone.length !== 10 || !dob || !ghanaCard || !location) {
    return res.status(400).json({
      status: "error",
      message: "Valid registration details are required",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    await ensureUserAccountState(userId, req.authUser)
    const fee = await getAfaRegistrationFee()
    const reference = generateReference("AFA")
    const mutationId = sanitizeMutationId(`afa:${reference}`)
    const balance = await updateWalletBalance(userId, -fee, {
      requireSufficient: true,
      mutationId,
      reason: "afa_registration",
      reference,
      details: {
        fullname,
        phone,
        location,
      },
    })

    const registrationRef = db.ref("afa_registrations").push()
    const record = {
      fullname,
      phone,
      dob,
      ghanaCard,
      location,
      fee,
      reference,
      userId,
      timestamp: Date.now(),
    }

    await registrationRef.set(record)
    await recordTransaction({
      userId,
      type: "afa_registration",
      amount: -fee,
      balance,
      reference,
      mutationId,
      details: {
        fullname,
        phone,
        location,
      },
    })

    return res.json({
      status: "success",
      message: "AFA registration completed",
      data: {
        id: registrationRef.key,
        fee,
        balance,
        reference,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    const errorCode = getErrorCode(error)
    const message = errorCode === "INSUFFICIENT_WALLET_BALANCE"
      ? "Insufficient wallet balance"
      : errorCode === "WALLET_TRANSACTION_ABORTED"
        ? "Wallet update could not be completed. Please retry."
      : "Failed to complete AFA registration"
    const statusCode =
      errorCode === "INSUFFICIENT_WALLET_BALANCE" ? 400 : errorCode === "WALLET_TRANSACTION_ABORTED" ? 409 : 500

    logger.error("AFA registration failed", error, { userId })
    return res.status(statusCode).json({
      status: "error",
      errorCode: errorCode || undefined,
      message,
      availableBalance: error.availableBalance,
      requiredAmount: error.requiredAmount,
      shortfall: error.shortfall,
      timestamp: new Date().toISOString(),
    })
  }
})

app.post("/api/wallet/credit-deposit", authenticateRequest, async (req, res) => {
  const userId = req.authUser.uid
  const reference = String(req.body?.reference || "").trim()

  if (!reference) {
    return res.status(400).json({
      status: "error",
      message: "Payment reference is required",
      timestamp: new Date().toISOString(),
    })
  }

  const receiptRef = db.ref(`payment_receipts/${reference}`)
  const existingReceipt = await receiptRef.once("value")
  if (existingReceipt.exists()) {
    const value = existingReceipt.val() || {}
    if (value.status === "credited" && value.userId === userId) {
      return res.json({
        status: "success",
        message: "Deposit already credited",
        data: value,
        timestamp: new Date().toISOString(),
      })
    }

    if (value.status === "credited" && value.userId && value.userId !== userId) {
      return res.status(403).json({
        status: "error",
        message: "This payment reference belongs to another account",
        timestamp: new Date().toISOString(),
      })
    }
  }

  const lockAcquired = acquireTransactionLock(reference, 30000)
  if (!lockAcquired) {
    return res.status(409).json({
      status: "error",
      message: "Deposit verification already in progress",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    await ensureUserAccountState(userId, req.authUser)
    const verifyData = await verifyPaystackPayment(reference)
    const paymentData = verifyData?.data || {}
    const paymentType = paymentData.metadata?.paymentType || "bundle"
    const paymentUserId = paymentData.metadata?.userId || null

    if (!verifyData.status || paymentData.status !== "success" || paymentType !== "wallet") {
      return res.status(400).json({
        status: "error",
        message: "Payment is not eligible for wallet credit",
        timestamp: new Date().toISOString(),
      })
    }

    if (paymentUserId && paymentUserId !== userId) {
      return res.status(403).json({
        status: "error",
        message: "This payment reference belongs to another account",
        timestamp: new Date().toISOString(),
      })
    }

    const amount = Number(paymentData.amount || 0) / 100
    const mutationId = sanitizeMutationId(`deposit:${reference}`)
    const balance = await updateWalletBalance(userId, amount, {
      mutationId,
      reason: "wallet_deposit",
      reference,
      details: {
        channel: "paystack",
      },
    })
    const transaction = await recordTransaction({
      userId,
      type: "deposit",
      amount,
      balance,
      reference,
      mutationId,
      details: {
        channel: "paystack",
        paidAt: paymentData.paid_at || null,
      },
    })

    const receipt = {
      userId,
      reference,
      amount,
      balance,
      status: "credited",
      paymentType: "wallet",
      paidAt: paymentData.paid_at || null,
      updatedAt: Date.now(),
      transactionId: transaction.id,
    }

    await receiptRef.set(receipt)

    return res.json({
      status: "success",
      message: "Wallet credited successfully",
      data: receipt,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Wallet credit verification failed", error, { userId, reference })
    const errorCode = getErrorCode(error)

    if (errorCode === "WALLET_TRANSACTION_ABORTED") {
      return res.status(409).json({
        status: "error",
        errorCode: "WALLET_TRANSACTION_ABORTED",
        message: "Wallet credit could not be completed. Please retry.",
        timestamp: new Date().toISOString(),
      })
    }

    return res.status(500).json({
      status: "error",
      message: "Failed to credit wallet deposit",
      timestamp: new Date().toISOString(),
    })
  } finally {
    releaseTransactionLock(reference)
  }
})

app.post("/api/wallet-purchase", authenticateRequest, purchaseActionRateLimit, async (req, res) => {
  const userId = req.authUser.uid
  const network = normalizeNetwork(req.body?.network)
  const phone = sanitizePhoneNumber(req.body?.phone)
  const packageId = String(req.body?.packageId || "").trim()
  const requestedVolume = Number(req.body?.volume || 0)
  const forbiddenClientFields = ["amount", "price", "provider", "providerReference", "providerOrderNumber"].filter(
    (field) => req.body?.[field] != null && String(req.body?.[field]).trim?.() !== "",
  )

  if (!SUPPORTED_PACKAGE_NETWORKS.includes(network)) {
    return res.status(400).json({
      status: "error",
      message: "Unsupported network",
      timestamp: new Date().toISOString(),
    })
  }

  if (!packageId) {
    return res.status(400).json({
      status: "error",
      message: "Package selection is required",
      timestamp: new Date().toISOString(),
    })
  }

  if (phone.length !== 10) {
    return res.status(400).json({
      status: "error",
      message: "Invalid phone number",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    await ensureUserAccountState(userId, req.authUser)
    const catalogEntry = await getCatalogPackage(network, { packageId })
    if (!catalogEntry || catalogEntry.enabled === false) {
      return res.status(400).json({
        status: "error",
        message: "Selected package is not available",
        timestamp: new Date().toISOString(),
      })
    }

    if ((requestedVolume && Number(catalogEntry.volume) !== requestedVolume) || forbiddenClientFields.length) {
      await recordAuditEvent({
        actorUid: userId,
        actorEmail: req.authUser.email || null,
        action: "security.purchase_tamper_rejected",
        targetRef: packageId,
        status: "rejected",
        metadata: {
          network,
          phone,
          requestedVolume,
          expectedVolume: Number(catalogEntry.volume),
          forbiddenClientFields,
        },
      }).catch(() => null)
      return res.status(400).json({
        status: "error",
        message: "Request payload did not match the authorized package configuration",
        timestamp: new Date().toISOString(),
      })
    }

    const amount = await getEffectivePackagePrice(catalogEntry, userId)
    if (!amount || amount <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Selected package has an invalid price",
        timestamp: new Date().toISOString(),
      })
    }

    const provider = await getActiveProviderForNetwork(network)
    assertProviderConfigured(provider, `wallet_purchase:${network}`)
    const activeIntent = await findMatchingActivePurchaseIntent({
      userId,
      network,
      phone,
      packageId: catalogEntry.id,
      maxAgeMs: CONFIG.purchaseIntentMaxAgeMs,
    })
    if (activeIntent?.reference) {
      const existingPurchase = await buildWalletPurchaseStateResponse(userId, activeIntent.reference, {
        amount,
        phone,
        network,
        volume: catalogEntry.volume,
        label: catalogEntry.label,
        packageId: catalogEntry.id,
        orderStatus: activeIntent.orderStatus || "pending",
        providerSubmissionStatus: activeIntent.providerSubmissionStatus || "pending",
      })

      return res.status(202).json({
        status: "success",
        message: existingPurchase.message,
        data: existingPurchase.data,
        timestamp: new Date().toISOString(),
      })
    }

    const idempotencyKey = hashStableKey(`${userId}:${network}:${phone}:${packageId}`)
    const idempotencyClaim = await claimIdempotencyKey(
      userId,
      idempotencyKey,
      {
        path: "/api/wallet-purchase",
        network,
        phone,
        packageId,
      },
      CONFIG.idempotencyWindowMs,
    )
    if (!idempotencyClaim.claimed) {
      const existingReference = String(idempotencyClaim.existing?.reference || "").trim()
      const existingStatus = String(idempotencyClaim.existing?.status || "").trim().toLowerCase()
      if (existingReference && ["accepted", "success", "indeterminate", "processing"].includes(existingStatus)) {
        const existingPurchase = await buildWalletPurchaseStateResponse(userId, existingReference, {
          amount,
          phone,
          network,
          volume: catalogEntry.volume,
          label: catalogEntry.label,
          packageId: catalogEntry.id,
        })

        return res.status(202).json({
          status: "success",
          message: existingPurchase.message,
          data: existingPurchase.data,
          timestamp: new Date().toISOString(),
        })
      }

      return res.status(409).json({
        status: "error",
        message: "Duplicate purchase request detected. Please wait.",
        timestamp: new Date().toISOString(),
      })
    }

    const lockAcquired = acquireUserTransactionLock(userId)
    if (!lockAcquired) {
      return res.status(409).json({
        status: "error",
        message: "You have a transaction in progress. Please wait.",
        timestamp: new Date().toISOString(),
      })
    }

    const reference = generateReference(network === "telecel" ? "TELECEL_PBM" : `${network.toUpperCase()}_PBM`)
    const debitMutationId = sanitizeMutationId(`purchase-debit:${reference}`)
    const refundMutationId = sanitizeMutationId(`purchase-refund:${reference}`)
    let balance = 0
    let debited = false
    let vendorCompleted = false
    await upsertPurchaseIntent(reference, {
      reference,
      userId,
      type: "wallet_purchase",
      network,
      phone,
      packageId: catalogEntry.id,
      volume: catalogEntry.volume,
      label: catalogEntry.label,
      amount,
      paymentStatus: "wallet_debited_pending",
      orderStatus: "pending",
      provider,
      providerSubmissionStatus: "pending",
      metadata: {
        origin: "wallet_purchase",
      },
    })
    await updateIdempotencyKey(userId, idempotencyKey, {
      reference,
      status: "accepted",
    }).catch(() => null)

    try {
      balance = await updateWalletBalance(userId, -amount, {
        requireSufficient: true,
        mutationId: debitMutationId,
        reason: "wallet_purchase_debit",
        reference,
        details: {
          network,
          phone,
          packageId: catalogEntry.id,
        },
      })
      debited = true

      let vendorMeta = {}
      const providerAdapter = getProviderAdapter(provider)
      const providerResult = await providerAdapter.purchase({
        network,
        phone,
        reference,
        catalogEntry,
        amount,
      })

      vendorCompleted = true
      const storedProviderOrderNumber = resolveStoredProviderOrderNumber(
        provider,
        providerResult.providerOrderNumber || null,
        reference,
      )
      const storedProviderReference = resolveStoredProviderReference(
        provider,
        providerResult.providerReference || "",
        reference,
        storedProviderOrderNumber || "",
      )
      vendorMeta = {
        providerReference: storedProviderReference,
        providerOrderNumber: storedProviderOrderNumber,
        providerStatusRaw: providerResult.providerStatusRaw || "accepted",
        providerStatusDescription: providerResult.providerStatusDescription || "",
        providerMeta: providerResult.providerMeta || {},
        status: providerResult.status || "accepted",
      }

      vendorMeta.provider = provider
      if (provider === "hubnet") {
        vendorMeta.transaction_id = providerResult.providerOrderNumber || "N/A"
        vendorMeta.hubnetResponse = providerResult.providerResponse || null
      }

      if (provider === "godsway") {
        vendorMeta.orderNumber = storedProviderOrderNumber || null
        vendorMeta.godswayResponse = providerResult.providerResponse || null
        vendorMeta.telecelResponse = providerResult.providerResponse || null
      }

      const latestIntent = await getPurchaseIntent(reference).catch(() => null)
      const orderPayload = mergeOrderPayloadWithPurchaseIntent({
        userId,
        reference,
        packageId: catalogEntry.id,
        label: catalogEntry.label,
        volume: catalogEntry.volume,
        amount,
        network,
        phone,
        status: vendorMeta.status || "accepted",
        paymentStatus: "success",
        createdAt: Date.now(),
        ...vendorMeta,
      }, latestIntent)
      const order = await createOrderRecord(userId, orderPayload)

      await recordTransaction({
        userId,
        type: "purchase",
        amount: -amount,
        balance,
        reference,
        mutationId: debitMutationId,
        details: {
          network,
          phone,
          volume: catalogEntry.volume,
          label: catalogEntry.label,
          packageId: catalogEntry.id,
        },
      })
      await syncPurchaseIntentFromOrder(reference, order, {
        paymentStatus: "wallet_debited",
        errorMessage: "",
      }).catch(() => null)
      await updateIdempotencyKey(userId, idempotencyKey, {
        status: "success",
        reference,
      }).catch(() => null)

      return res.json({
        status: "success",
        message: "Order accepted and awaiting provider update",
        data: {
          reference,
          orderId: order.id,
          orderStatus: order.status,
          amount,
          phone,
          network,
          volume: catalogEntry.volume,
          label: catalogEntry.label,
          packageId: catalogEntry.id,
          balance,
        },
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      const errorCode = getErrorCode(error)
      const indeterminateProviderFailure = debited && !vendorCompleted && isIndeterminateProviderSubmissionError(error)
      if (indeterminateProviderFailure) {
        const pendingMessage = getIndeterminateProviderSubmissionMessage(provider)
        const currentWallet = await getUserWalletRecord(userId).catch(() => ({ balance }))

        await recordTransaction({
          userId,
          type: "purchase",
          amount: -amount,
          balance: currentWallet.balance,
          reference,
          mutationId: debitMutationId,
          details: {
            network,
            phone,
            volume: catalogEntry.volume,
            label: catalogEntry.label,
            packageId: catalogEntry.id,
            provider,
            pendingConfirmation: true,
          },
        }).catch((transactionError) => {
          logger.error("Failed to record pending purchase transaction", transactionError, { userId, reference })
        })

        const pendingOrderPayload = {
          userId,
          reference,
          packageId: catalogEntry.id,
          label: catalogEntry.label,
          volume: catalogEntry.volume,
          amount,
          network,
          provider,
          phone,
          status: "processing",
          paymentStatus: "wallet_debited",
          retryEligible: false,
          errorMessage: pendingMessage,
          providerStatusDescription: pendingMessage,
          statusSource: "provider_submission_pending",
          statusUpdatedAt: Date.now(),
          updatedAt: Date.now(),
          sync: {
            attempts: 1,
            lastAttemptAt: Date.now(),
            lastError: pendingMessage,
            nextAttemptAt: null,
            skippedReason: "provider_submission_indeterminate",
          },
        }

        let pendingOrder = null
        try {
          pendingOrder = await createOrderRecord(userId, {
            ...pendingOrderPayload,
            createdAt: Date.now(),
          })
        } catch (orderError) {
          logger.error("Failed to store indeterminate purchase order", orderError, { userId, reference })
        }

        await upsertPurchaseIntent(reference, {
          paymentStatus: "wallet_debited",
          orderStatus: "processing",
          providerSubmissionStatus: "processing",
          provider,
          retryEligible: false,
          errorMessage: pendingMessage,
        }).catch(() => null)
        await updateIdempotencyKey(userId, idempotencyKey, {
          status: "indeterminate",
          reference,
        }).catch(() => null)

        return res.status(202).json({
          status: "success",
          message: pendingMessage,
          data: {
            reference,
            orderId: pendingOrder?.id || null,
            orderStatus: "processing",
            amount,
            phone,
            network,
            volume: catalogEntry.volume,
            label: catalogEntry.label,
            packageId: catalogEntry.id,
            balance: currentWallet.balance,
          },
          timestamp: new Date().toISOString(),
        })
      }

      if (debited && !vendorCompleted) {
        try {
          balance = await updateWalletBalance(userId, amount, {
            mutationId: refundMutationId,
            reason: "wallet_purchase_refund",
            reference,
            details: {
              network,
              phone,
              packageId: catalogEntry.id,
            },
          })
        } catch (refundError) {
          logger.error("Wallet refund failed after purchase error", refundError, { userId, reference })
        }

        await createOrderRecord(userId, {
          userId,
          reference,
          packageId: catalogEntry.id,
          label: catalogEntry.label,
          volume: catalogEntry.volume,
          amount,
          network,
          provider,
          phone,
          status: "failed",
          refunded: true,
          errorMessage: error.message,
          createdAt: Date.now(),
        }).catch((orderError) => {
          logger.error("Failed to store failed order record", orderError, { userId, reference })
        })
        await upsertPurchaseIntent(reference, {
          paymentStatus: "wallet_refunded",
          orderStatus: "failed",
          providerSubmissionStatus: "failed",
          errorMessage: error?.message || "Purchase failed before provider confirmation",
        }).catch(() => null)
      }

      if (vendorCompleted) {
        logger.error("Purchase completed but local persistence failed", error, { userId, network, reference })
        return res.status(500).json({
          status: "error",
          message: `Purchase completed but confirmation storage failed. Contact support with reference ${reference}.`,
          timestamp: new Date().toISOString(),
        })
      }

      if (errorCode === "INSUFFICIENT_WALLET_BALANCE") {
        return res.status(400).json({
          status: "error",
          errorCode: "INSUFFICIENT_WALLET_BALANCE",
          message: "Insufficient wallet balance",
          availableBalance: error.availableBalance,
          requiredAmount: error.requiredAmount,
          shortfall: error.shortfall,
          timestamp: new Date().toISOString(),
        })
      }

      if (errorCode === "WALLET_TRANSACTION_ABORTED") {
        return res.status(409).json({
          status: "error",
          errorCode: "WALLET_TRANSACTION_ABORTED",
          message: "Wallet update could not be completed. Please retry.",
          availableBalance: error.availableBalance,
          requiredAmount: error.requiredAmount,
          shortfall: error.shortfall,
          timestamp: new Date().toISOString(),
        })
      }

      if (errorCode === "INSUFFICIENT_HUBNET_BALANCE") {
        return res.status(503).json({
          status: "error",
          errorCode: "INSUFFICIENT_HUBNET_BALANCE",
          message: "Service provider has insufficient balance",
          timestamp: new Date().toISOString(),
        })
      }

      if (errorCode === "INSUFFICIENT_GODSWAY_BALANCE") {
        return res.status(503).json({
          status: "error",
          errorCode: "INSUFFICIENT_GODSWAY_BALANCE",
          message: "Service provider has insufficient balance",
          timestamp: new Date().toISOString(),
        })
      }

      if (errorCode === "HUBNET_AUTH_FAILED") {
        return res.status(502).json({
          status: "error",
          errorCode: "HUBNET_AUTH_FAILED",
          message: error.providerMessage || "Hubnet API authentication failed. Update HUBNET_API_KEY.",
          timestamp: new Date().toISOString(),
        })
      }

      if (errorCode === "GODSWAY_AUTH_FAILED") {
        return res.status(502).json({
          status: "error",
          errorCode: "GODSWAY_AUTH_FAILED",
          message: error.providerMessage || "Godsway API authentication failed. Update GODSWAY_API_KEY.",
          timestamp: new Date().toISOString(),
        })
      }

      if (errorCode === "HUBNET_RATE_LIMITED") {
        return res.status(429).json({
          status: "error",
          errorCode: "HUBNET_RATE_LIMITED",
          message: error.providerMessage || "Hubnet API rate limit reached. Please try again shortly.",
          timestamp: new Date().toISOString(),
        })
      }

      if (errorCode === "GODSWAY_RATE_LIMITED") {
        return res.status(429).json({
          status: "error",
          errorCode: "GODSWAY_RATE_LIMITED",
          message: error.providerMessage || "Godsway API rate limit reached. Please try again shortly.",
          timestamp: new Date().toISOString(),
        })
      }

      if (errorCode === "PACKAGE_PROVIDER_MAPPING_MISSING") {
        return res.status(400).json({
          status: "error",
          errorCode: "PACKAGE_PROVIDER_MAPPING_MISSING",
          message: "Selected package is not configured for the active provider route.",
          timestamp: new Date().toISOString(),
        })
      }

      if (errorCode === "DUPLICATE_TRANSACTION_ATTEMPT") {
        return res.status(409).json({
          status: "error",
          message: "Duplicate transaction attempt detected",
          timestamp: new Date().toISOString(),
        })
      }

      logger.error("Wallet purchase failed", error, { userId, network, reference })
      await updateIdempotencyKey(userId, idempotencyKey, {
        status: "failed",
      }).catch(() => null)
      return res.status(500).json({
        status: "error",
        message: "Failed to process data bundle",
        timestamp: new Date().toISOString(),
      })
    } finally {
      releaseUserTransactionLock(userId)
    }
  } catch (error) {
    logger.error("Wallet purchase setup failed", error, { userId, network })
    return res.status(500).json({
      status: "error",
      message: "Failed to process purchase request",
      timestamp: new Date().toISOString(),
    })
  }
})

app.post("/api/me/bootstrap", authenticateRequest, purchaseActionRateLimit, async (req, res) => {
  const userId = req.authUser.uid
  const username = String(req.body?.username || "").trim()
  const phone = sanitizePhoneNumber(req.body?.phone)

  if (username.length < 2 || phone.length !== 10) {
    return res.status(400).json({
      status: "error",
      message: "Valid username and phone are required",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    const result = await ensureUserAccountState(userId, req.authUser, { username, phone })
    return res.json({
      status: "success",
      data: {
        profile: sanitizeUserProfileForClient(result.profile, req.authUser),
        balance: toMoneyNumber(result.wallet?.balance, 0),
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to bootstrap user account", error, { userId })
    return res.status(500).json({
      status: "error",
      message: "Failed to initialize user account",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/me/profile", authenticateRequest, async (req, res) => {
  const userId = req.authUser.uid

  try {
    await ensureUserAccountState(userId, req.authUser)
    const profile = await getUserProfileRecord(userId)
    return res.json({
      status: "success",
      data: sanitizeUserProfileForClient(profile, req.authUser),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load user profile", error, { userId })
    return res.status(500).json({
      status: "error",
      message: "Failed to load profile",
      timestamp: new Date().toISOString(),
    })
  }
})

app.patch("/api/me/profile", authenticateRequest, purchaseActionRateLimit, async (req, res) => {
  const userId = req.authUser.uid
  const username = String(req.body?.username || "").trim()
  const phone = sanitizePhoneNumber(req.body?.phone)

  if (username.length < 2 || phone.length !== 10) {
    return res.status(400).json({
      status: "error",
      message: "Valid username and phone are required",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    await ensureUserAccountState(userId, req.authUser, { username, phone })
    const profile = await getUserProfileRecord(userId)
    return res.json({
      status: "success",
      message: "Profile updated",
      data: sanitizeUserProfileForClient(profile, req.authUser),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to update user profile", error, { userId })
    return res.status(500).json({
      status: "error",
      message: "Failed to update profile",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/me/role", authenticateRequest, async (req, res) => {
  try {
    await ensureUserAccountState(req.authUser.uid, req.authUser)
    const data = await getUserRoleSummary(req.authUser.uid)
    return res.json({
      status: "success",
      data,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load user role", error, { userId: req.authUser.uid })
    return res.status(500).json({
      status: "error",
      message: "Failed to load account role",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/me/afa-registrations", authenticateRequest, async (req, res) => {
  const userId = req.authUser.uid
  const limit = Number(req.query?.limit || 30)

  try {
    const rows = await getUserAfaRegistrations(userId, { limit })
    return res.json({
      status: "success",
      data: rows,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load user AFA registrations", error, { userId })
    return res.status(500).json({
      status: "error",
      message: "Failed to load AFA registrations",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/me/wallet", authenticateRequest, async (req, res) => {
  const userId = req.authUser.uid
  const limit = Number(req.query?.limit || 50)

  try {
    await ensureUserAccountState(userId, req.authUser)
    const [wallet, transactions] = await Promise.all([
      getUserWalletRecord(userId),
      getUserTransactionsList(userId, { limit }),
    ])

    return res.json({
      status: "success",
      data: {
        ...wallet,
        transactions,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load wallet data", error, { userId })
    return res.status(500).json({
      status: "error",
      message: "Failed to load wallet data",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/me/orders", authenticateRequest, async (req, res) => {
  const userId = req.authUser.uid
  const limit = Number(req.query?.limit || 100)

  try {
    await ensureUserAccountState(userId, req.authUser)
    const orders = await getUserOrdersList(userId, { limit })
    return res.json({
      status: "success",
      data: orders.map((item) => toPublicOrderRecord(item)),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load user orders", error, { userId })
    return res.status(500).json({
      status: "error",
      message: "Failed to load orders",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/me/dashboard", authenticateRequest, async (req, res) => {
  const userId = req.authUser.uid

  try {
    await ensureUserAccountState(userId, req.authUser)
    const data = await getUserDashboardData(userId)
    return res.json({
      status: "success",
      data,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to load dashboard data", error, { userId })
    return res.status(500).json({
      status: "error",
      message: "Failed to load dashboard data",
      timestamp: new Date().toISOString(),
    })
  }
})

app.get("/api/check-balance", authenticateRequest, requirePrivilegedAccess, async (req, res) => {
  const provider = normalizeProvider(req.query?.provider, "hubnet")

  try {
    if (provider !== "hubnet") {
      return res.status(400).json({
        status: "error",
        message: "Balance check is currently available for Hubnet only.",
        timestamp: new Date().toISOString(),
      })
    }

    const balanceData = await checkHubnetBalance()
    res.json({
      status: "success",
      data: balanceData,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Failed to check balance", error)

    const errorCode = getErrorCode(error)
    const statusCode = errorCode === "HUBNET_RATE_LIMITED" ? 429 : errorCode === "HUBNET_AUTH_FAILED" ? 502 : 500
    const message =
      error.providerMessage ||
      (errorCode === "HUBNET_AUTH_FAILED"
        ? "Hubnet API authentication failed. Update HUBNET_API_KEY."
        : errorCode === "HUBNET_RATE_LIMITED"
          ? "Hubnet API rate limit reached. Please try again shortly."
          : "Failed to retrieve balance")

    res.status(statusCode).json({
      status: "error",
      errorCode: errorCode || undefined,
      message,
      timestamp: new Date().toISOString(),
    })
  }
})

app.post("/api/reset-circuit-breaker/:service", authenticateRequest, requirePrivilegedAccess, (req, res) => {
  const requestedService = String(req.params.service || "").trim().toLowerCase()
  const service = requestedService === "telecel" ? "godsway" : requestedService

  const breakers = {
    paystack: paystackCircuitBreaker,
    hubnet: hubnetCircuitBreaker,
    godsway: godswayCircuitBreaker,
    gigshub: gigshubCircuitBreaker,
  }

  const breaker = breakers[service]
  if (!breaker) {
    return res.status(400).json({
      status: "error",
      message: "Invalid service. Supported services: paystack, hubnet, godsway, gigshub",
      timestamp: new Date().toISOString(),
    })
  }

  breaker.state = "CLOSED"
  breaker.failureCount = 0
  breaker.lastFailureTime = null
  breaker.successCount = 0

  logger.info(`${service} circuit breaker manually reset`)

  res.json({
    status: "success",
    message: `${service} circuit breaker reset successfully`,
    service,
    state: breaker.getState(),
    timestamp: new Date().toISOString(),
  })
})

app.post("/api/initiate-payment", authenticateRequest, purchaseActionRateLimit, async (req, res) => {
  const authUserId = req.authUser.uid
  const authEmail = String(req.authUser.email || "").trim()
  const { network, phone, volume, amount, email, fcmToken, paymentType, reference, packageId } = req.body

  logger.info("Payment initiation request", { paymentType, amount, email, reference })

  const paymentOwnerEmail = authEmail || String(email || "").trim()
  if (!paymentOwnerEmail) {
    return res.status(400).json({
      status: "error",
      message: "An email address is required for payment",
      timestamp: new Date().toISOString(),
    })
  }

  await ensureUserAccountState(authUserId, req.authUser).catch(() => null)

  let normalizedNetwork = normalizePurchaseNetwork(network)
  let normalizedPhone = sanitizePhoneNumber(phone)
  let normalizedVolume = Number(volume || 0)
  let normalizedAmount = Number(amount || 0)
  let normalizedLabel = ""
  let normalizedPackageId = String(packageId || "").trim()

  if (paymentType === "wallet") {
    if (!amount) {
      return res.status(400).json({
        status: "error",
        message: "Missing required payment data",
      })
    }
  } else {
    if (!normalizedNetwork || !normalizedPhone || !normalizedPackageId) {
      return res.status(400).json({
        status: "error",
        message: "Missing required payment data",
      })
    }

    if (!SUPPORTED_PACKAGE_NETWORKS.includes(normalizedNetwork)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid network",
      })
    }

    if (!/^\d{10}$/.test(normalizedPhone)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid phone number format",
      })
    }

    const catalogEntry = await getCatalogPackage(normalizedNetwork, { packageId: normalizedPackageId })
    if (!catalogEntry || catalogEntry.enabled === false) {
      return res.status(400).json({
        status: "error",
        message: "Selected package is not available",
        timestamp: new Date().toISOString(),
      })
    }

    normalizedLabel = catalogEntry.label
    normalizedVolume = Number(catalogEntry.volume || 0)
    normalizedAmount = await getEffectivePackagePrice(catalogEntry, authUserId)

    if (Number(volume || 0) && Number(volume || 0) !== normalizedVolume) {
      await recordAuditEvent({
        actorUid: authUserId,
        actorEmail: req.authUser.email || null,
        action: "security.payment_tamper_rejected",
        targetRef: normalizedPackageId,
        status: "rejected",
        metadata: {
          requestedVolume: Number(volume || 0),
          expectedVolume: normalizedVolume,
          network: normalizedNetwork,
        },
      }).catch(() => null)
      return res.status(400).json({
        status: "error",
        message: "Package volume mismatch detected",
        timestamp: new Date().toISOString(),
      })
    }

    if (Number.isFinite(Number(amount)) && Number(amount) > 0 && toMoneyNumber(amount, 0) !== toMoneyNumber(normalizedAmount, 0)) {
      await recordAuditEvent({
        actorUid: authUserId,
        actorEmail: req.authUser.email || null,
        action: "security.payment_tamper_rejected",
        targetRef: normalizedPackageId,
        status: "rejected",
        metadata: {
          requestedAmount: toMoneyNumber(amount, 0),
          expectedAmount: toMoneyNumber(normalizedAmount, 0),
          network: normalizedNetwork,
        },
      }).catch(() => null)
      return res.status(400).json({
        status: "error",
        message: "Package price mismatch detected",
        timestamp: new Date().toISOString(),
      })
    }
  }

  const numAmount = Number(normalizedAmount)
  if (isNaN(numAmount) || numAmount <= 0 || numAmount > 10000) {
    return res.status(400).json({
      status: "error",
      message: "Invalid amount",
    })
  }

  try {
    const prefix =
      paymentType === "wallet"
        ? "WALLET_DEPOSIT"
        : normalizedNetwork === "mtn"
          ? "MTN_DATA"
          : normalizedNetwork === "at"
            ? "AT_DATA"
            : "TELECEL_DATA"

    const paymentReference = reference || generateReference(prefix)
    const amountInKobo = Math.round(numAmount * 100)

    const payload = {
      amount: amountInKobo,
      email: paymentOwnerEmail,
      reference: paymentReference,
      callback_url: paymentType === "wallet" ? buildFrontendUrl("/wallet.html") : buildFrontendUrl("/buy.html"),
      metadata: {
        paymentType: paymentType || "bundle",
        fcmToken: fcmToken || null,
        userId: authUserId,
        custom_fields: [
          {
            display_name: paymentType === "wallet" ? "Wallet Deposit" : "Data Bundle",
            variable_name: paymentType === "wallet" ? "wallet_deposit" : "data_bundle",
            value:
              paymentType === "wallet"
                ? `GHS ${numAmount} Wallet Deposit`
                : `${normalizedVolume}MB for ${normalizedPhone} (${normalizedNetwork.toUpperCase()})`,
          },
        ],
      },
    }

    if (paymentType !== "wallet") {
      payload.metadata.network = normalizedNetwork
      payload.metadata.phone = normalizedPhone
      payload.metadata.volume = normalizedVolume
      payload.metadata.packageId = normalizedPackageId
      payload.metadata.label = normalizedLabel
      payload.metadata.amount = toMoneyNumber(numAmount, 0)
      await upsertPurchaseIntent(paymentReference, {
        reference: paymentReference,
        userId: authUserId,
        type: "bundle",
        network: normalizedNetwork,
        phone: normalizedPhone,
        packageId: normalizedPackageId,
        volume: normalizedVolume,
        label: normalizedLabel,
        amount: toMoneyNumber(numAmount, 0),
        paymentStatus: "initialized",
        orderStatus: "pending",
        providerSubmissionStatus: "pending",
        metadata: {
          paymentOwnerEmail,
          fcmToken: fcmToken || null,
        },
      })
    }

    const data = await initializePaystackPayment(payload)

    if (!data.status || !data.data) {
      throw new Error("Payment initialization failed")
    }

    logger.info("Payment initialized successfully", { reference: paymentReference, amount: numAmount })

    res.json({
      status: "success",
      data: data.data,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Payment initialization failed", error, { amount: numAmount, paymentType })
    res.status(500).json({
      status: "error",
      message: "Payment initialization failed",
      timestamp: new Date().toISOString(),
    })
  }
})

app.post("/api/process-wallet-purchase", authenticateRequest, async (req, res) => {
  logger.warn("Deprecated wallet purchase endpoint blocked", {
    userId: req.authUser.uid,
    path: req.path,
  })

  return res.status(410).json({
    status: "error",
    errorCode: "DEPRECATED_ENDPOINT",
    message: "This endpoint has been disabled. Use /api/wallet-purchase.",
    timestamp: new Date().toISOString(),
  })
})

app.post("/api/process-telecel-purchase", authenticateRequest, async (req, res) => {
  logger.warn("Deprecated Telecel purchase endpoint blocked", {
    userId: req.authUser.uid,
    path: req.path,
  })

  return res.status(410).json({
    status: "error",
    errorCode: "DEPRECATED_ENDPOINT",
    message: "This endpoint has been disabled. Use /api/wallet-purchase with network=telecel.",
    timestamp: new Date().toISOString(),
  })
})

// FIXED: Single, comprehensive payment verification endpoint
app.get("/api/verify-payment/:reference", authenticateRequest, paymentVerificationRateLimit, async (req, res) => {
  const { reference } = req.params

  if (!reference) {
    return res.status(400).json({
      status: "error",
      message: "Missing payment reference",
    })
  }

  logger.info("Payment verification request", { reference })

  const existingOrderLocation = await findOrderLocationByReference(reference, { includeOrder: true }).catch(() => null)
  const purchaseIntent = await getPurchaseIntent(reference).catch(() => null)
  const requesterRole = await getUserRoleSummary(req.authUser.uid).catch(() => ({ privileged: false }))
  const initialOwnerUid = String(existingOrderLocation?.userId || purchaseIntent?.userId || "").trim()
  if (initialOwnerUid && initialOwnerUid !== req.authUser.uid && requesterRole.admin !== true) {
    return res.status(403).json({
      status: "error",
      message: "You are not allowed to verify this payment",
      timestamp: new Date().toISOString(),
    })
  }

  if (processedTransactions.has(reference)) {
    const metadata = processedTransactions.get(reference)
    logger.info("Transaction already processed (memory)", { reference })
    return res.json({
      status: "success",
      message: "Transaction already processed",
      data: {
        reference,
        alreadyProcessed: true,
        processedAt: metadata.processedAt || new Date().toISOString(),
        orderStatus: existingOrderLocation?.order?.status || purchaseIntent?.orderStatus || "processing",
      },
      timestamp: new Date().toISOString(),
    })
  }

  // Acquire transaction lock to prevent race conditions
  if (!acquireTransactionLock(reference)) {
    logger.warn("Transaction lock conflict", { reference })
    return res.status(409).json({
      status: "error",
      message: "Transaction is currently being processed",
      retryAfter: 3,
    })
  }

  try {
    logger.debug("Verifying payment with Paystack", { reference })
    const verifyData = await verifyPaystackPayment(reference)

    if (!verifyData.status) {
      logger.error("Paystack verification failed", { reference, response: verifyData })
      return res.json({
        status: "failed",
        message: "Payment verification failed",
        timestamp: new Date().toISOString(),
      })
    }

    const paymentData = verifyData.data
    logger.info("Paystack verification successful", {
      reference,
      status: paymentData.status,
      amount: paymentData.amount,
    })

    if (paymentData.status === "success") {
      const paymentType = paymentData.metadata?.paymentType || "bundle"
      const paymentAmount = paymentData.amount / 100
      const paymentUserId = String(purchaseIntent?.userId || paymentData.metadata?.userId || "").trim()

      if (paymentUserId && paymentUserId !== req.authUser.uid && requesterRole.admin !== true) {
        return res.status(403).json({
          status: "error",
          message: "This payment belongs to another account",
          timestamp: new Date().toISOString(),
        })
      }

      if (paymentType === "wallet") {
        processedTransactions.add(reference, {
          type: "wallet_deposit",
          amount: paymentAmount,
          status: "success",
          processedAt: new Date().toISOString(),
          metadata: paymentData.metadata,
        })

        logger.info("Wallet deposit verified", { reference, amount: paymentAmount })

        return res.json({
          status: "success",
          message: "Wallet deposit completed successfully",
          data: {
            reference: paymentData.reference,
            amount: paymentAmount,
            paymentType: "wallet",
            timestamp: new Date(paymentData.paid_at).getTime(),
          },
          timestamp: new Date().toISOString(),
        })
      }

      const metadata = paymentData.metadata || {}
      const phone = sanitizePhoneNumber(purchaseIntent?.phone || metadata.phone)
      const volume = Number(purchaseIntent?.volume || metadata.volume || 0)
      const network = normalizePurchaseNetwork(purchaseIntent?.network || metadata.network)
      const packageId = String(purchaseIntent?.packageId || metadata.packageId || "").trim()
      const userId = String(purchaseIntent?.userId || metadata.userId || "").trim()
      if (!phone || !volume || !network) {
        logger.error("Missing metadata for data bundle", { reference, metadata: paymentData.metadata })
        return res.status(400).json({
          status: "error",
          message: "Invalid payment metadata",
          timestamp: new Date().toISOString(),
        })
      }

      if (purchaseIntent) {
        const intentAmount = toMoneyNumber(purchaseIntent.amount, 0)
        if (intentAmount > 0 && toMoneyNumber(paymentAmount, 0) !== intentAmount) {
          await upsertPurchaseIntent(reference, {
            paymentStatus: "verification_failed",
            errorMessage: "Paystack amount did not match server payment intent",
          }).catch(() => null)
          return res.status(400).json({
            status: "error",
            message: "Payment amount did not match the authorized package",
            timestamp: new Date().toISOString(),
          })
        }
      }

      const catalogEntry = await getCatalogPackage(network, { packageId, volume })
      if (!catalogEntry) {
        return res.status(400).json({
          status: "error",
          errorCode: "PACKAGE_NOT_FOUND",
          message: "No package catalog entry matched this payment.",
          timestamp: new Date().toISOString(),
        })
      }

      const provider = existingOrderLocation?.order?.provider || (await getActiveProviderForNetwork(network))
      const providerAdapter = getProviderAdapter(provider)
      const intentClaim = await claimPurchaseIntentProcessing(reference, `verify:${INSTANCE_ID}`)
      if (purchaseIntent && !intentClaim.claimed && ["submitted", "completed", "processing"].includes(intentClaim.intent?.providerSubmissionStatus)) {
        if (existingOrderLocation?.order) {
          return res.json({
            status: "success",
            message: "Transaction already processed",
            data: {
              reference,
              amount: paymentAmount,
              orderStatus: existingOrderLocation.order.status,
              phone,
              volume: catalogEntry.volume,
              network,
              timestamp: new Date(paymentData.paid_at).getTime(),
            },
            timestamp: new Date().toISOString(),
          })
        }

        return res.status(409).json({
          status: "error",
          message: "Payment is already being processed",
          retryAfter: 3,
          timestamp: new Date().toISOString(),
        })
      }

      try {
        logger.debug("Processing provider transaction for verified payment", { reference, network, provider })
        const providerResult = await providerAdapter.purchase({
          network,
          phone,
          reference,
          catalogEntry,
          amount: paymentAmount,
        })

        const storedProviderOrderNumber = resolveStoredProviderOrderNumber(
          provider,
          providerResult.providerOrderNumber || null,
          reference,
        )
        const storedProviderReference = resolveStoredProviderReference(
          provider,
          providerResult.providerReference || "",
          reference,
          storedProviderOrderNumber || "",
        )

        const latestIntent = await getPurchaseIntent(reference).catch(() => null)
        const orderPayload = mergeOrderPayloadWithPurchaseIntent({
          userId,
          reference,
          packageId: catalogEntry.id,
          label: catalogEntry.label,
          volume: catalogEntry.volume,
          amount: paymentAmount,
          network,
          provider,
          phone,
          paymentStatus: "success",
          createdAt: Date.now(),
          status: providerResult.status || "accepted",
          providerReference: storedProviderReference,
          providerOrderNumber: storedProviderOrderNumber,
          providerStatusRaw: providerResult.providerStatusRaw || "accepted",
          providerStatusDescription: providerResult.providerStatusDescription || "",
          providerMeta: providerResult.providerMeta || {},
          providerResponse: providerResult.providerResponse || null,
          statusSource: "payment_verify",
          statusUpdatedAt: Date.now(),
          sync: {
            lastAttemptAt: Date.now(),
            lastSuccessAt: Date.now(),
            lastError: "",
            nextAttemptAt: Date.now() + CONFIG.orderSyncRetryDelayMs,
            lastProviderStatusRaw: providerResult.providerStatusRaw || "",
          },
        }, latestIntent)

        let savedOrder = null
        if (existingOrderLocation?.found) {
          const updatedOrder = await updateOrderByReference(reference, orderPayload)
          savedOrder = updatedOrder.order || null
        } else if (userId) {
          savedOrder = await createOrderRecord(userId, orderPayload)
        }

        processedTransactions.add(reference, {
          provider,
          processedAt: new Date().toISOString(),
          [getProviderLegacyResponseField(provider)]: providerResult.providerResponse || null,
        })
        await syncPurchaseIntentFromOrder(reference, savedOrder || orderPayload, {
          paymentStatus: "success",
          errorMessage: "",
        }).catch(() => null)

        return res.json({
          status: "success",
          message: "Transaction completed successfully",
          data: {
            reference: paymentData.reference,
            amount: paymentAmount,
            phone,
            volume: catalogEntry.volume,
            network,
            orderStatus: savedOrder?.status || orderPayload.status || providerResult.status || "accepted",
            timestamp: new Date(paymentData.paid_at).getTime(),
          },
          timestamp: new Date().toISOString(),
        })
      } catch (providerError) {
        logger.error("Provider processing failed for verified payment", providerError, { reference, provider })
        const errorCode = getErrorCode(providerError)
        const indeterminateProviderFailure = isIndeterminateProviderSubmissionError(providerError)
        const message = indeterminateProviderFailure
          ? getIndeterminateProviderSubmissionMessage(provider)
          : getProviderErrorMessage(
              providerError,
              errorCode,
              "Payment successful but data bundle processing failed",
            )
        const nextAttemptAt = indeterminateProviderFailure ? null : Date.now() + CONFIG.orderSyncRetryDelayMs
        const pendingPayload = {
          userId,
          reference,
          packageId: catalogEntry.id,
          label: catalogEntry.label,
          volume: catalogEntry.volume,
          amount: paymentAmount,
          network,
          provider,
          phone,
          status: indeterminateProviderFailure ? "processing" : "pending",
          paymentStatus: "success",
          retryEligible: indeterminateProviderFailure ? false : true,
          errorMessage: message,
          providerStatusDescription: message,
          statusSource: indeterminateProviderFailure ? "provider_submission_pending" : "payment_verify",
          statusUpdatedAt: Date.now(),
          updatedAt: Date.now(),
          sync: {
            attempts: Number(existingOrderLocation?.order?.sync?.attempts || 0) + 1,
            lastAttemptAt: Date.now(),
            lastError: message,
            nextAttemptAt,
            skippedReason: indeterminateProviderFailure ? "provider_submission_indeterminate" : "",
          },
        }

        if (existingOrderLocation?.found) {
          await updateOrderByReference(reference, pendingPayload)
        } else if (userId) {
          await createOrderRecord(userId, pendingPayload)
        }
        await upsertPurchaseIntent(reference, {
          paymentStatus: "success",
          orderStatus: indeterminateProviderFailure ? "processing" : "pending",
          providerSubmissionStatus: indeterminateProviderFailure ? "processing" : "failed",
          provider,
          retryEligible: indeterminateProviderFailure ? false : true,
          errorMessage: message,
        }).catch(() => null)

        return res.status(indeterminateProviderFailure ? 202 : 200).json({
          status: "pending",
          paymentStatus: "success",
          errorCode: errorCode || undefined,
          message,
          data: {
            reference: paymentData.reference,
            amount: paymentAmount,
            phone,
            volume: catalogEntry.volume,
            network,
            orderStatus: indeterminateProviderFailure ? "processing" : "pending",
            timestamp: new Date(paymentData.paid_at).getTime(),
          },
          timestamp: new Date().toISOString(),
        })
      }
    } else if (paymentData.status === "pending") {
      logger.info("Payment still pending", { reference })
      if (purchaseIntent) {
        await upsertPurchaseIntent(reference, {
          paymentStatus: "pending",
        }).catch(() => null)
      }
      return res.json({
        status: "pending",
        paymentStatus: "pending",
        message: "Payment is being processed",
        timestamp: new Date().toISOString(),
      })
    } else {
      logger.info("Payment failed", { reference, status: paymentData.status })
      if (purchaseIntent) {
        await upsertPurchaseIntent(reference, {
          paymentStatus: "failed",
          orderStatus: "failed",
          errorMessage: "Payment failed",
        }).catch(() => null)
      }
      return res.json({
        status: "failed",
        paymentStatus: "failed",
        message: "Payment failed",
        data: {
          reference,
          paymentStatus: paymentData.status,
        },
        timestamp: new Date().toISOString(),
      })
    }
  } catch (error) {
    logger.error("Payment verification error", error, { reference })

    // Check if it's a circuit breaker error
    if (error.message.includes("Service temporarily unavailable")) {
      return res.status(503).json({
        status: "error",
        message: "Payment verification service temporarily unavailable. Please try again in a few minutes.",
        timestamp: new Date().toISOString(),
      })
    }

    res.status(500).json({
      status: "error",
      message: "Payment verification failed",
      timestamp: new Date().toISOString(),
    })
  } finally {
    releaseTransactionLock(reference)
  }
})

app.post("/api/retry-transaction/:reference", authenticateRequest, purchaseActionRateLimit, async (req, res) => {
  const { reference } = req.params
  const { network, phone, volume } = req.body

  logger.info("Transaction retry request", { reference, network, phone, volume })

  if (!reference) {
    return res.status(400).json({
      status: "error",
      message: "Missing required reference",
    })
  }

  // Acquire lock for retry
  if (!acquireTransactionLock(reference)) {
    return res.status(409).json({
      status: "error",
      message: "Transaction is currently being processed",
      retryAfter: 3,
    })
  }

  try {
    const existingOrderLocation = await findOrderLocationByReference(reference, { includeOrder: true })
    const purchaseIntent = await getPurchaseIntent(reference)
    const requesterRole = await getUserRoleSummary(req.authUser.uid)
    const ownerUid = String(existingOrderLocation?.userId || purchaseIntent?.userId || "").trim()
    const retryEligible =
      (existingOrderLocation?.order?.retryEligible ?? purchaseIntent?.retryEligible ?? true) !== false
    if (ownerUid && ownerUid !== req.authUser.uid && requesterRole.admin !== true) {
      return res.status(403).json({
        status: "error",
        message: "You are not allowed to retry this transaction",
        timestamp: new Date().toISOString(),
      })
    }

    if (!retryEligible) {
      return res.status(409).json({
        status: "error",
        message: "This transaction is awaiting confirmation already and cannot be retried yet.",
        timestamp: new Date().toISOString(),
      })
    }

    const verifyData = await verifyPaystackPayment(reference)

    if (!verifyData.status || verifyData.data.status !== "success") {
      return res.status(400).json({
        status: "error",
        message: "Cannot retry transaction - payment not successful",
      })
    }

    const paymentData = verifyData.data
    const metadata = paymentData.metadata || {}
    const safeNetwork = normalizePurchaseNetwork(existingOrderLocation?.order?.network || purchaseIntent?.network || network || metadata.network)
    const safePhone = sanitizePhoneNumber(existingOrderLocation?.order?.phone || purchaseIntent?.phone || phone || metadata.phone)
    const safeVolume = Number(existingOrderLocation?.order?.volume || purchaseIntent?.volume || volume || metadata.volume || 0)

    if (!safeNetwork || !safePhone || !safeVolume) {
      return res.status(400).json({
        status: "error",
        message: "Missing required retry parameters",
      })
    }

    const provider = existingOrderLocation?.order?.provider || (await getActiveProviderForNetwork(safeNetwork))
    const intentClaim = await claimPurchaseIntentProcessing(reference, `retry:${INSTANCE_ID}`)
    if (purchaseIntent && !intentClaim.claimed && ["submitted", "completed", "processing"].includes(intentClaim.intent?.providerSubmissionStatus)) {
      return res.status(409).json({
        status: "error",
        message: "This transaction is already being processed",
        retryAfter: 3,
        timestamp: new Date().toISOString(),
      })
    }
    const catalogEntry =
      (await getCatalogPackage(safeNetwork, {
        packageId: existingOrderLocation?.order?.packageId || purchaseIntent?.packageId || metadata.packageId || "",
        volume: safeVolume,
      })) || normalizeCatalogEntry(
        {
          id: existingOrderLocation?.order?.packageId || purchaseIntent?.packageId || `${safeNetwork}-${safeVolume}`,
          label: existingOrderLocation?.order?.label || purchaseIntent?.label || defaultPackageLabel(safeVolume),
          volume: safeVolume,
          userPrice: paymentData.amount / 100,
          agentPrice: paymentData.amount / 100,
          providerMappings: existingOrderLocation?.order?.providerMappings || {},
        },
        existingOrderLocation?.order?.packageId || purchaseIntent?.packageId || `${safeNetwork}-${safeVolume}`,
        safeNetwork,
      )

    if (!catalogEntry) {
      return res.status(400).json({
        status: "error",
        message: "No matching package configuration was found for this retry.",
      })
    }

    let existingData = null
    if (processedTransactions.has(reference)) {
      existingData = processedTransactions.get(reference)
      processedTransactions.add(reference, {
        ...existingData,
        retryAttempted: true,
        retryTimestamp: Date.now(),
      })
    }

    const providerResult = await getProviderAdapter(provider).purchase({
      network: safeNetwork,
      phone: safePhone,
      reference,
      catalogEntry,
      amount: paymentData.amount / 100,
    })

    const storedProviderOrderNumber = resolveStoredProviderOrderNumber(
      provider,
      providerResult.providerOrderNumber || null,
      reference,
    )
    const storedProviderReference = resolveStoredProviderReference(
      provider,
      providerResult.providerReference || "",
      reference,
      storedProviderOrderNumber || "",
    )

    logger.info("Transaction retry successful", {
      reference,
      provider,
      providerOrderNumber: storedProviderOrderNumber,
    })

    const retryOrderPayload = mergeOrderPayloadWithPurchaseIntent({
      network: safeNetwork,
      provider,
      phone: safePhone,
      volume: catalogEntry.volume,
      label: catalogEntry.label,
      packageId: catalogEntry.id,
      amount: paymentData.amount / 100,
      status: providerResult.status || "accepted",
      providerReference: storedProviderReference,
      providerOrderNumber: storedProviderOrderNumber,
      providerStatusRaw: providerResult.providerStatusRaw || "accepted",
      providerStatusDescription: providerResult.providerStatusDescription || "",
      providerMeta: providerResult.providerMeta || {},
      providerResponse: providerResult.providerResponse || null,
      statusSource: "retry",
      statusUpdatedAt: Date.now(),
      updatedAt: Date.now(),
      sync: {
        attempts: Number(existingOrderLocation?.order?.sync?.attempts || 0) + 1,
        lastAttemptAt: Date.now(),
        lastSuccessAt: Date.now(),
        lastError: "",
        nextAttemptAt: Date.now() + CONFIG.orderSyncRetryDelayMs,
        lastProviderStatusRaw: providerResult.providerStatusRaw || "",
      },
    }, purchaseIntent)
    const retryUpdateResult = await updateOrderByReference(reference, retryOrderPayload)
    await syncPurchaseIntentFromOrder(reference, retryUpdateResult.order || retryOrderPayload, {
      paymentStatus: "success",
      retryEligible: true,
      errorMessage: "",
    }).catch(() => null)

    res.json({
      status: "success",
      message: "Transaction retry completed",
      data: {
        reference,
        phone: safePhone,
        volume: catalogEntry.volume,
        network: safeNetwork,
        orderStatus: retryUpdateResult.order?.status || retryOrderPayload.status || providerResult.status || "accepted",
        timestamp: Date.now(),
        previousAttempt: existingData ? true : false,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error("Transaction retry failed", error, { reference })
    const errorCode = getErrorCode(error)
    const statusCode = getProviderErrorHttpStatus(errorCode)
    const message = getProviderErrorMessage(error, errorCode, "Transaction retry failed")
    await upsertPurchaseIntent(reference, {
      providerSubmissionStatus: "failed",
      errorMessage: message,
    }).catch(() => null)

    res.status(statusCode).json({
      status: "error",
      errorCode: errorCode || undefined,
      message,
      timestamp: new Date().toISOString(),
    })
  } finally {
    releaseTransactionLock(reference)
  }
})

app.get("/api/transaction-status/:reference", authenticateRequest, purchaseActionRateLimit, async (req, res) => {
  const { reference } = req.params

  if (!reference) {
    return res.status(400).json({
      status: "error",
      message: "Missing transaction reference",
    })
  }

  logger.info("Transaction status check", { reference })

  try {
    const requesterRole = await getUserRoleSummary(req.authUser.uid)
    const existingOrder = await findOrderLocationByReference(reference, { includeOrder: true })
    const purchaseIntent = await getPurchaseIntent(reference)
    const ownerUid = String(existingOrder?.userId || purchaseIntent?.userId || "").trim()
    if (ownerUid && ownerUid !== req.authUser.uid && requesterRole.admin !== true) {
      return res.status(403).json({
        status: "error",
        message: "You are not allowed to view this transaction",
        timestamp: new Date().toISOString(),
      })
    }

    if (existingOrder?.order) {
      const order = normalizeStoredOrderRecord(existingOrder.order)
      return res.json({
        status: "success",
        message: "Transaction status retrieved",
        data: {
          reference,
          processed: true,
          orderStatus: order.status,
          processedAt: new Date(order.statusUpdatedAt || order.updatedAt || order.timestamp).toISOString(),
          details: toPublicOrderRecord(order),
        },
        timestamp: new Date().toISOString(),
      })
    }

    if (processedTransactions.has(reference)) {
      const metadata = processedTransactions.get(reference)

      return res.json({
        status: "success",
        message: "Transaction status retrieved",
        data: {
          reference,
          processed: true,
          processedAt: metadata.processedAt || new Date(metadata.timestamp).toISOString(),
          orderStatus: purchaseIntent?.orderStatus || "processing",
        },
        timestamp: new Date().toISOString(),
      })
    } else if (purchaseIntent) {
      return res.json({
        status: purchaseIntent.paymentStatus === "success" ? "pending" : purchaseIntent.paymentStatus || "pending",
        message: "Transaction status retrieved",
        data: {
          reference,
          processed: false,
          paymentStatus: purchaseIntent.paymentStatus,
          orderStatus: purchaseIntent.orderStatus || "pending",
          paymentDetails: {
            amount: toMoneyNumber(purchaseIntent.amount, 0),
            phone: purchaseIntent.phone,
            volume: purchaseIntent.volume,
            network: purchaseIntent.network,
          },
        },
        timestamp: new Date().toISOString(),
      })
    } else {
      try {
        const verifyData = await verifyPaystackPayment(reference)

        if (verifyData.status && verifyData.data.status === "success") {
          return res.json({
            status: "pending",
            message: "Payment successful but data bundle not processed",
            data: {
              reference,
              processed: false,
              paymentStatus: "success",
              paymentDetails: {
                amount: verifyData.data.amount / 100,
                phone: sanitizePhoneNumber(verifyData.data.metadata?.phone),
                volume: Number(verifyData.data.metadata?.volume || 0),
                network: normalizePurchaseNetwork(verifyData.data.metadata?.network),
                paidAt: verifyData.data.paid_at,
              },
            },
            timestamp: new Date().toISOString(),
          })
        } else {
          return res.json({
            status: "pending",
            message: "Payment not successful or pending",
            data: {
              reference,
              processed: false,
              paymentStatus: verifyData.data.status,
            },
            timestamp: new Date().toISOString(),
          })
        }
      } catch (paymentError) {
        logger.error("Error checking payment status", paymentError, { reference })
        return res.json({
          status: "unknown",
          message: "Transaction reference not found",
          data: {
            reference,
            processed: false,
          },
          timestamp: new Date().toISOString(),
        })
      }
    }
  } catch (error) {
    logger.error("Error checking transaction status", error, { reference })
    res.status(500).json({
      status: "error",
      message: "Failed to check transaction status",
      timestamp: new Date().toISOString(),
    })
  }
})

app.use("*", (req, res) => {
  res.status(404).json({
    status: "error",
    message: "Endpoint not found",
    path: req.originalUrl,
  })
})

app.use((err, req, res, next) => {
  logger.error("Unhandled error", err, { url: req.url, method: req.method })
  res.status(err.status || 500).json({
    status: "error",
    message: "Server error occurred",
  })
})

// Enhanced cleanup with better error handling
setInterval(() => {
  try {
    const now = Date.now()
    const windowStart = now - CONFIG.rateLimitWindow

    // Cleanup rate limiting
    for (const [clientId, requests] of rateLimitStore.entries()) {
      const validRequests = requests.filter((time) => time > windowStart)
      if (validRequests.length === 0) {
        rateLimitStore.delete(clientId)
      } else {
        rateLimitStore.set(clientId, validRequests)
      }
    }

    for (const [scopeKey, requests] of scopedRateLimitStore.entries()) {
      const validRequests = requests.filter((time) => time > windowStart)
      if (validRequests.length === 0) {
        scopedRateLimitStore.delete(scopeKey)
      } else {
        scopedRateLimitStore.set(scopeKey, validRequests)
      }
    }

    // Cleanup duplicate attempts
    let cleanedDuplicateAttempts = 0
    for (const [key, attempts] of duplicateAttempts.entries()) {
      const validAttempts = attempts.filter((time) => now - time < DUPLICATE_ATTEMPT_WINDOW)
      if (validAttempts.length === 0) {
        duplicateAttempts.delete(key)
        cleanedDuplicateAttempts++
      } else {
        duplicateAttempts.set(key, validAttempts)
      }
    }

    // Cleanup processed transactions
    const cleanedTransactions = processedTransactions.cleanup()
    if (cleanedTransactions > 0 || cleanedDuplicateAttempts > 0) {
      logger.debug(`Cleanup: ${cleanedTransactions} expired transactions, ${cleanedDuplicateAttempts} duplicate attempt records`)
    }
  } catch (error) {
    logger.error("Error during cleanup", error)
  }
}, CONFIG.cacheCleanupInterval)

async function initializeRuntimeState() {
  try {
    await normalizeCatalogPackages()
    const routing = await ensureProviderRoutingSettings()
    await validateProviderSecretsForRouting(routing)
    await normalizeExistingOrdersAndIndexes()
    await backfillPurchaseIntentsFromOrders()
  } catch (error) {
    logger.error("Startup normalization failed", error)
    if (getErrorCode(error) === "PROVIDER_CONFIGURATION_MISSING") {
      process.exit(1)
    }
  }
}

setInterval(() => {
  runOrderStatusReconciliation().catch((error) => {
    if (isTransientRealtimeDisconnectError(error)) {
      logger.warn("Scheduled order reconciliation skipped after transient database disconnect", {
        error: error?.message || error,
      })
      return
    }
    logger.error("Scheduled order reconciliation failed", error)
  })
}, CONFIG.orderSyncIntervalMs)

setTimeout(() => {
  runOrderStatusReconciliation().catch((error) => {
    if (isTransientRealtimeDisconnectError(error)) {
      logger.warn("Initial order reconciliation skipped after transient database disconnect", {
        error: error?.message || error,
      })
      return
    }
    logger.error("Initial order reconciliation failed", error)
  })
}, 5000)

const server = app.listen(CONFIG.port, "0.0.0.0", () => {
  logger.info(`🚀 DataWise API Server v5.0 running on port ${CONFIG.port}`)
  logger.info(`🌍 Environment: ${CONFIG.nodeEnv}`)
  logger.info(`⚡ Optimized for Render hosting`)
})

initializeRuntimeState().catch((error) => {
  logger.error("Runtime initialization failed", error)
})

server.keepAliveTimeout = CONFIG.keepAliveTimeout
server.headersTimeout = CONFIG.headersTimeout
server.timeout = CONFIG.requestTimeout

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully")
  server.close(() => {
    logger.info("Process terminated")
    process.exit(0)
  })
})

export default app