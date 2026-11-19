import express from "express"
import cors from "cors"
import compression from "compression"
import helmet from "helmet"
import { CONFIG } from "./config.js"
import { logger } from "./logger.js"
import { registerCacheReset } from "./lib/runtime-cache.js"

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
const storefrontDomain = String(process.env.STOREFRONT_BASE_DOMAIN || "").trim().toLowerCase()

function isStorefrontOrigin(origin) {
  if (!storefrontDomain) return false
  try {
    const url = new URL(origin)
    const suffix = `.${storefrontDomain}`
    const slug = url.hostname.toLowerCase().endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : ""
    return url.protocol === "https:" && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)
  } catch { return false }
}

// Extra synchronous origin checks registered by feature modules (custom store
// domains live in the database, so storefronts.js owns that list).
const originAllowances = []
export function registerOriginAllowance(check) {
  if (typeof check === "function") originAllowances.push(check)
}
function isAllowedByRegistry(origin) {
  return originAllowances.some((check) => {
    try { return check(origin) === true } catch { return false }
  })
}

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin) || isStorefrontOrigin(origin) || isAllowedByRegistry(origin) || CONFIG.nodeEnv === "development") {
      callback(null, true)
    } else {
      callback(null, false)
    }
  },
  // PATCH must be listed: the admin role update, the order status updates and
  // the profile update are all PATCH routes. Omitting it here makes the browser
  // preflight fail, so those calls never reach the server at all.
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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

export const rateLimitStore = new Map()
export const scopedRateLimitStore = new Map()
const publicIpWindows = new Map()
registerCacheReset(() => { rateLimitStore.clear(); scopedRateLimitStore.clear(); publicIpWindows.clear() })

function rateLimit(req, res, next) {
  if (isRateLimitExemptPath(req.path)) return next()
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

export const purchaseActionRateLimit = createScopedRateLimit("purchase_action", {
  windowMs: 60 * 1000,
  max: 10,
  keyFn: (req) => req.authUser?.uid || req.ip || "unknown",
})

export const purchaseVelocityRateLimit = createScopedRateLimit("purchase_velocity", {
  windowMs: 10 * 1000,
  max: 3,
  keyFn: (req) => req.authUser?.uid || req.ip || "unknown",
})

// Per-IP budget for anonymous API traffic. Writes (checkout, repair) get the
// blueprint's 60/min. Reads get more headroom because Ghanaian mobile carriers
// put many shoppers behind one CGNAT address, and a single storefront visit
// already reads availability, banners, proof and a catalog.
export const PUBLIC_WRITE_LIMIT_PER_MINUTE = 60
export const PUBLIC_READ_LIMIT_PER_MINUTE = 240

export function isRateLimitExemptPath(path) {
  // Signature-verified provider and gateway callbacks must never be throttled:
  // a dropped deposit webhook is a customer left waiting for their money.
  return /^\/(?:api\/)?webhook(?:\/|$)/.test(String(path || ""))
}

function publicIpRateLimit(req, res, next) {
  if (!req.path.startsWith("/api/") || req.headers.authorization || isRateLimitExemptPath(req.path)) return next()
  const write = !["GET", "HEAD", "OPTIONS"].includes(req.method)
  const key = `${write ? "w" : "r"}:${req.ip || "unknown"}`
  const limit = write ? PUBLIC_WRITE_LIMIT_PER_MINUTE : PUBLIC_READ_LIMIT_PER_MINUTE
  const now = Date.now()
  const times = (publicIpWindows.get(key) || []).filter((at) => at > now - 60_000)
  if (times.length >= limit) {
    res.set("Retry-After", "30")
    return res.status(429).json({ status: "error", errorCode: "RATE_LIMITED", message: "Too many requests. Please wait a moment and try again." })
  }
  times.push(now)
  publicIpWindows.set(key, times)
  if (publicIpWindows.size > 20_000) {
    for (const [ip, entries] of publicIpWindows) if (entries.at(-1) < now - 60_000) publicIpWindows.delete(ip)
  }
  next()
}

export const paymentVerificationRateLimit = createScopedRateLimit("payment_verification", {
  windowMs: 60 * 1000,
  max: 20,
  keyFn: (req) => req.params?.reference || req.ip || "unknown",
})

export const adminMutationRateLimit = createScopedRateLimit("admin_mutation", {
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

/**
 * Install the base middleware stack on the app, in the exact original order:
 * helmet → compression → CORS → JSON/urlencoded body parsing → security
 * headers → global rate limit → transaction signature validation.
 */
export function installBaseMiddleware(app) {
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

  app.use(
    cors(corsOptions),
  )
  app.options("*", cors(corsOptions))

  app.use(
    express.json({
      limit: "256kb",
      strict: true,
      type: "application/json",
      // Signature-verified webhooks need the exact bytes that were signed. This
      // parser runs before every route, so a later express.raw() on the webhook
      // path is a no-op (body-parser skips an already-parsed request) and the
      // HMAC would be computed over "[object Object]". Stash the buffer here.
      verify: (req, _res, buf) => {
        if (buf && buf.length) {
          req.rawBody = Buffer.from(buf)
        }
      },
    }),
  )

  app.use(
    express.urlencoded({
      extended: false,
      limit: "256kb",
      parameterLimit: 100,
    }),
  )

  app.use((req, res, next) => {
    Object.entries(securityHeaders).forEach(([key, value]) => {
      res.setHeader(key, value)
    })
    next()
  })

  app.use(rateLimit)
  app.use(publicIpRateLimit)

  app.use(validateRequestSignature)
}
