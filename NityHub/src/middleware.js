import express from "express"
import cors from "cors"
import compression from "compression"
import helmet from "helmet"
import fs from "fs"
import { CONFIG } from "./config.js"
import { logger } from "./logger.js"

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
 * headers → global rate limit → transaction signature validation → static.
 */
export function installBaseMiddleware(app, publicDir) {
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

  app.use(validateRequestSignature)

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
}
