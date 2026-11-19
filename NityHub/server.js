import { CONFIG, assertRequiredConfig } from "./src/config.js"
import { logger } from "./src/logger.js"
import { getErrorCode } from "./src/lib/errors.js"
import {
  processedTransactions,
  duplicateAttempts,
  DUPLICATE_ATTEMPT_WINDOW,
} from "./src/state.js"
import { rateLimitStore, scopedRateLimitStore } from "./src/middleware.js"
import { createApp } from "./src/app.js"
import {
  normalizeCatalogPackages,
  ensureProviderRoutingSettings,
  validateProviderSecretsForRouting,
  normalizeExistingOrdersAndIndexes,
  backfillPurchaseIntentsFromOrders,
  isTransientRealtimeDisconnectError,
} from "./src/domain.js"
import { runOrderStatusReconciliation } from "./src/providers-sync.js"
import { runRefundQueue } from "./src/refund-queue.js"
import { runRepairNotificationQueue } from "./src/repair-notifications.js"
import { runFulfillmentQueue } from "./src/fulfillment-queue.js"

assertRequiredConfig()

const app = createApp()

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

// Drain the refund outbox: retries wallet refunds that failed inline, so a
// debited user is never left waiting on manual intervention.
setInterval(() => {
  runRefundQueue().catch((error) => {
    logger.error("Scheduled refund queue sweep failed", error)
  })
}, CONFIG.refundWorkerIntervalMs)

setTimeout(() => {
  runRefundQueue().catch((error) => {
    logger.error("Initial refund queue sweep failed", error)
  })
}, 10000)

setInterval(() => {
  runRepairNotificationQueue().catch((error) => logger.error("Repair notification sweep failed", error))
}, 30_000)

setTimeout(() => {
  runRepairNotificationQueue().catch((error) => logger.error("Initial repair notification sweep failed", error))
}, 6000)

// Safety net for buyers who paid and closed the tab: fulfils paid bundle orders
// that no browser ever came back to confirm. See src/fulfillment-queue.js.
setInterval(() => {
  runFulfillmentQueue().catch((error) => logger.error("Fulfillment queue sweep failed", error))
}, 20_000)

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
