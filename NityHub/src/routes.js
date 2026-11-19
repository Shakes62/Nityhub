import crypto from "crypto"
import express from "express"
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
  WEBHOOK_SECRET_REQUIRED,
} from "./config.js"
import { admin, db } from "./firebase.js"
import { logger } from "./logger.js"
import { createAppError, getErrorCode, parseJsonText } from "./lib/errors.js"
import {
  fetchWithRetry,
  paystackCircuitBreaker,
  hubnetCircuitBreaker,
  godswayCircuitBreaker,
  gigshubCircuitBreaker,
  pbmhubCircuitBreaker,
} from "./lib/http.js"
import { generateReference } from "./lib/reference.js"
import { verifiedWalletDepositMatchesOwner } from "./lib/payment-verification.js"
import {
  verifyPaystackWebhookSignature,
  paystackWebhookReplayCache,
  settleWalletDeposit,
} from "./lib/deposit-settlement.js"
import { computeDeliveryEstimates } from "./lib/social-proof-rules.js"
import { getDeliveryProofs, getDeliveryEstimates } from "./delivery-feed.js"
import { normalizeBanner, sortBanners, getDefaultBanners, isValidBannerId } from "./lib/banner-rules.js"
import { WALLET_MUTATION } from "./lib/wallet-core.js"
import {
  processedTransactions,
  duplicateAttempts,
  DUPLICATE_ATTEMPT_WINDOW,
  recordDuplicateAttempt,
  checkDuplicateAttempts,
  transactionLocks,
  phoneTransactionLocks,
  userTransactionLocks,
  acquireTransactionLock,
  acquirePhoneTransactionLock,
  acquireUserTransactionLock,
  releaseTransactionLock,
  releasePhoneTransactionLock,
  releaseUserTransactionLock,
} from "./state.js"
import { purchaseActionRateLimit, purchaseVelocityRateLimit, paymentVerificationRateLimit, adminMutationRateLimit } from "./middleware.js"
import { registerStorefrontRoutes, settleStorefrontProfit } from "./storefronts.js"
import { maskPhoneNumber } from "./lib/storefront-rules.js"
import { registerCacheReset } from "./lib/runtime-cache.js"
import {
  startBlacklistSync, isRecipientBlocked, isIdentityBlocked, assessRecipientVelocity, changeBlacklist,
  getBlacklistStatus, getBlacklistCounts, listRiskFlags, clearRiskFlag,
} from "./security-controls.js"
import { claimRepairLease, releaseRepairLease, claimRepairDispatch } from "./repair-lock.js"
import { classifyRepairState, canRedispatchAfterStatus, hasDefinitiveProviderFailure, hasProviderSubmissionEvidence, isValidRepairReference } from "./lib/repair-rules.js"
import { queueRepairConfirmation, runRepairNotificationQueue } from "./repair-notifications.js"
import { enqueueFulfillment, setFulfillmentRunner } from "./fulfillment-queue.js"
import { registerRealtimeRoutes } from "./realtime.js"
import {
  getVendingControls, saveVendingControls, isNetworkAvailable,
  getProviderCosts, saveProviderCosts, checkPriceFloor, evaluateSaleGuard,
  claimProviderDispatch, recordProviderDispatch, getDispatchHealth, resetProviderDispatchHealth,
} from "./lib/vending-controls.js"
import {
  normalizeHubnetSuccessValue,
  isHubnetSuccessfulResponse,
  getHubnetResponseSummary,
  classifyHubnetFailure,
  resolveHubnetWebhookUrl,
  normalizeUrlPathname,
  parseUrlSafe,
  isKnownAppOriginUrl,
  resolveHubnetStatusBaseUrl,
  resolveGodswayStatusBaseUrl,
  resolveGodswayWebhookUrl,
  resolveGigshubWebhookUrl,
  checkGigshubBalance,
  initializePaystackPayment,
  verifyPaystackPayment,
  checkHubnetBalance,
  normalizeNetwork,
  normalizePurchaseNetwork,
  normalizeProvider,
  normalizeProviderRoutingValue,
  formatGodswayCapacityFromVolume,
  buildDefaultProviderMappings,
  normalizeProviderMappings,
  isCompleteProviderMapping,
  describeProviderMappingGaps,
  describeProviderMappingGapMessage,
  getPackageProviderMapping,
  isTerminalOrderStatus,
  normalizeInternalOrderStatus,
  getOrderStatusPriority,
  sanitizeGodswayProviderOrderNumber,
  resolveStoredProviderOrderNumber,
  resolveStoredProviderReference,
  parseUtcDateBoundary,
  getPurchaseIntentSubmissionStatusForOrderStatus,
  getProviderLegacyResponseField,
  getGodswayResponseSummary,
  getGigshubResponseSummary,
  classifyGigshubFailure,
  getGigshubStatusDetails,
  getPbmhubStatusDetails,
  classifyGodswayFailure,
  getGodswayStatusDetails,
  isGodswayStatusEndpointUnavailable,
  getHubnetStatusDetails,
  getWebhookEventStatus,
  getHubnetWebhookStatusDetails,
  isHubnetTransactionNotFoundResponse,
  sanitizeProviderMeta,
  toMoneyNumber,
  toMoneyUnits,
  fromMoneyUnits,
  sanitizeCatalogId,
  defaultPackageLabel,
  normalizeCatalogEntry,
  getCatalogRef,
  toPublicCatalogEntry,
  getProviderRoutingRef,
  normalizeProviderRouting,
  ensureProviderRoutingSettings,
  getProviderRoutingConfig,
  getActiveProviderForNetwork,
  getProviderRouteForNetwork,
  resolvePurchaseProviderCandidates,
  isProviderConfigured,
  hasCandidateAfter,
  listRoutableProviders,
  normalizeCatalogPackages,
  getCatalogPackages,
  getCatalogPackage,
  getUserProfileRecord,
  getUserWalletRecord,
  getUserOrdersList,
  getUserTransactionsList,
  getUserDashboardData,
  getAdminOverviewData,
  isPrivilegedUser,
  getEffectivePackagePrice,
  resolveProviderPricePair,
  resolveUserPrice,
  resolveAgentPrice,
  resolveEffectivePackagePrice,
  getAfaRegistrationFee,
  setAfaRegistrationFee,
  sleep,
  isTransientRealtimeDisconnectError,
  hashStableKey,
  sanitizeMutationId,
  trimWalletMutationHistory,
  assertProviderConfigured,
  validateProviderSecretsForRouting,
  sanitizeUserProfileForClient,
  ensureUserAccountState,
  getUserRoleSummary,
  listAdminUserIds,
  setUserRoles,
  getUserAfaRegistrations,
  recordAuditEvent,
  getPurchaseIntentRef,
  normalizePurchaseIntent,
  getPurchaseIntent,
  upsertPurchaseIntent,
  claimPurchaseIntentProcessing,
  claimIdempotencyKey,
  updateIdempotencyKey,
  isPurchaseIntentActivelyProcessing,
  findMatchingActivePurchaseIntent,
  buildWalletPurchaseStateResponse,
  isWebhookIpAllowed,
  isValidWebhookToken,
  extractGodswayOrderNumber,
  verifyGodswayWebhookSignature,
  authenticateRequest,
  optionalAuthenticateRequest,
  requirePrivilegedAccess,
  sanitizePhoneNumber,
  buildFrontendUrl,
  updateWalletBalance,
  holdWalletBalance,
  captureWalletHold,
  releaseWalletHold,
  recordTransaction,
  toTimestampValue,
  normalizeOrderSyncState,
  normalizeStoredOrderRecord,
  toPublicOrderRecord,
  toPublicTransactionRecord,
  orderRecordsDiffer,
  toLookupKey,
  getProviderOrderLookupEntries,
  setProviderOrderLookupIndex,
  removeProviderOrderLookupIndex,
  syncProviderOrderLookupIndexes,
  setOrderReferenceIndex,
  getOrderLocationFromIndexData,
  findOrderLocationByReference,
  findOrderLocationByProviderLookup,
  findOrderLocationByLookupValue,
  createOrderRecord,
  canApplyOrderStatus,
  updateOrderByReference,
  syncPurchaseIntentFromOrder,
  mergeOrderPayloadWithPurchaseIntent,
  setOrderStatusManually,
  bulkUpdateOrdersStatus,
  normalizeExistingOrdersAndIndexes,
  backfillPurchaseIntentsFromOrders,
  firstNonEmptyText,
  uniqueTextValues,
  getWebhookLookupContext,
} from "./domain.js"
import {
  processHubnetTransaction,
  processGodswayTransaction,
  processGigshubTransaction,
  getGigshubOrderStatus,
  createProviderPurchaseMetadata,
  getGodswayOrderStatus,
  getHubnetOrderStatus,
  providerAdapters,
  getProviderAdapter,
  getOrderSyncHealthSummary,
  getProviderHealthSnapshot,
  getProviderErrorHttpStatus,
  isIndeterminateProviderSubmissionError,
  getIndeterminateProviderSubmissionMessage,
  preferInformativeProviderFailure,
  reconciliationInFlight,
  getOrderSyncBackoffDelay,
  acquireOrderSyncLease,
  releaseOrderSyncLease,
  getOpenOrderLocationsForSync,
  reconcileSingleOrderStatus,
  runOrderStatusReconciliation,
} from "./providers-sync.js"

export function registerRoutes(app) {
startBlacklistSync()
setFulfillmentRunner(runRepairPipeline)
registerRealtimeRoutes(app)
registerStorefrontRoutes(app)
function normalizeBlacklistValue(kind, raw) {
  if (kind === "phone") {
    const phone = sanitizePhoneNumber(raw)
    return /^0\d{9}$/.test(phone) ? phone : ""
  }
  if (kind === "identity") {
    const value = String(raw || "").trim().toLowerCase()
    return value.length >= 3 && value.length <= 254 ? value : ""
  }
  return ""
}

app.get("/api/admin/security/overview", authenticateRequest, requirePrivilegedAccess, async (_req, res) => {
  try {
    const [counts, flags] = await Promise.all([getBlacklistCounts(), listRiskFlags(50)])
    return res.json({ status: "success", data: { blacklist: counts, riskFlags: flags } })
  } catch (error) {
    logger.error("Failed to load security overview", error)
    return res.status(503).json({ status: "error", message: "Security data could not be loaded." })
  }
})

app.get("/api/admin/blacklist/:kind", authenticateRequest, requirePrivilegedAccess, async (req, res) => {
  const value = normalizeBlacklistValue(req.params.kind, req.query?.value)
  if (!value) return res.status(400).json({ status: "error", message: "Enter a valid 10-digit phone number, email or user id." })
  try {
    return res.json({ status: "success", data: await getBlacklistStatus(req.params.kind, value) })
  } catch {
    return res.status(400).json({ status: "error", message: "Invalid blacklist entry" })
  }
})

app.put("/api/admin/blacklist/:kind", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  const kind = req.params.kind
  const value = normalizeBlacklistValue(kind, req.body?.value)
  if (!value) return res.status(400).json({ status: "error", message: "Enter a valid 10-digit phone number, email or user id." })
  try {
    const active = req.body?.active === true
    const hash = await changeBlacklist(kind, value, active, req.authUser.uid, req.body?.note)
    await recordAuditEvent({
      actorUid: req.authUser.uid, action: active ? "admin.blacklist.add" : "admin.blacklist.remove",
      targetRef: hash.slice(0, 16), status: "success", metadata: { kind },
    }).catch(() => null)
    return res.json({ status: "success", data: { hash, active } })
  } catch {
    return res.status(400).json({ status: "error", message: "Invalid blacklist entry" })
  }
})

app.delete("/api/admin/risk-flags/:id", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  try {
    await clearRiskFlag(req.params.id)
    return res.json({ status: "success", data: { cleared: true } })
  } catch {
    return res.status(400).json({ status: "error", message: "Invalid flag" })
  }
})

async function dispatchGuarded({ provider, network, catalogEntry, amount, purchase }) {
  const floor = await evaluateSaleGuard({ network, packageId: catalogEntry.id, provider, price: amount })
  if (floor.reason === "network_paused") {
    throw createAppError("NETWORK_PAUSED", { upstreamCode: "PROVIDER_ROUTE_LOCKED" })
  }
  if (!floor.allowed) {
    logger.error("Provider route blocked by price floor", new Error(floor.reason), {
      network, packageId: catalogEntry.id, provider, amount, cost: floor.cost,
    })
    throw createAppError("PRICE_FLOOR_BLOCKED", { upstreamCode: "PRICE_FLOOR_BLOCKED" })
  }
  const token = crypto.randomUUID()
  if (!(await claimProviderDispatch(provider, token))) {
    throw createAppError("PROVIDER_COOLDOWN", { upstreamCode: "CIRCUIT_OPEN" })
  }
  try {
    const result = await purchase()
    await recordProviderDispatch(provider, token, "success").catch((error) => logger.error("Dispatch health update failed", error))
    return result
  } catch (error) {
    const code = getErrorCode(error)
    const hardFail = /AUTH_FAILED|INSUFFICIENT_.*_BALANCE|WALLET_FROZEN/.test(code)
    await recordProviderDispatch(provider, token, hardFail ? "hard_fail" : isIndeterminateProviderSubmissionError(error) ? "uncertain" : "failed")
      .catch((healthError) => logger.error("Dispatch health update failed", healthError))
    throw error
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

    // The `event` name is the authoritative signal on every provider that sends
    // one — Hubnet's own `transfer.delivered` callback carries
    // `data.status: "Processing"`, so trusting the body alone leaves delivered
    // orders stuck on processing forever.
    const eventStatus = getWebhookEventStatus(payload?.event)
    const bodyStatus =
      provider === "godsway"
        ? getGodswayStatusDetails(payload)
        : provider === "gigshub"
          ? getGigshubStatusDetails(payload)
          : provider === "pbmhub"
            ? // PBM HUB does not publish webhooks — its orders advance by
              // polling. Parsing its envelope here anyway costs nothing and
              // stops a hand-configured `?provider=pbmhub` delivery from being
              // read with Hubnet's field names.
              getPbmhubStatusDetails(payload)
            : getHubnetWebhookStatusDetails(payload, normalizeInternalOrderStatus(lookup.data.status, "processing"))
    const providerStatus = eventStatus
      ? {
          providerStatusRaw: String(payload?.event || bodyStatus.providerStatusRaw || "").trim(),
          providerStatusDescription:
            bodyStatus.providerStatusDescription || String(payload?.message || "").trim(),
          normalizedStatus: eventStatus,
        }
      : bodyStatus
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
    // The monotonic guard may have kept the stored status (replayed or
    // out-of-order callback). Everything downstream must mirror what is
    // actually stored, otherwise the purchase intent and the order disagree.
    const appliedStatus = result.found
      ? normalizeInternalOrderStatus(result.order?.status, providerStatus.normalizedStatus)
      : providerStatus.normalizedStatus

    await upsertPurchaseIntent(canonicalReference, {
      provider,
      providerReference,
      providerOrderNumber: providerOrderNumber || "",
      providerStatusRaw: providerStatus.providerStatusRaw,
      providerStatusDescription: providerStatus.providerStatusDescription,
      statusSource: "webhook",
      orderStatus: appliedStatus,
      providerSubmissionStatus: isTerminalOrderStatus(appliedStatus) ? "completed" : "submitted",
      paymentStatus: "success",
      errorMessage: "",
    }).catch(() => null)
    if (appliedStatus === "delivered" && result.order?.storefrontSlug) {
      await settleStorefrontProfit(result.order).catch((error) => logger.error("Store profit settlement failed", error, { reference: canonicalReference }))
    }

    processedTransactions.add(canonicalReference, {
      reference: canonicalReference,
      provider,
      phone: lookup.phone || null,
      network: lookup.network,
      volume: lookup.volume || null,
      status: appliedStatus,
      providerStatusRaw: providerStatus.providerStatusRaw,
      providerReference,
      providerOrderNumber,
      matchedLookupValue: matchedLookupValue || null,
      updatedFrom: "webhook",
      updatedAt,
    })

    logger.info(`[WEBHOOK] Order ${canonicalReference} updated`, {
      provider,
      event: String(payload?.event || "").trim() || null,
      requestedStatus: providerStatus.normalizedStatus,
      status: appliedStatus,
      statusApplied: result.statusApplied !== false,
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
app.post("/webhook/gigshub", async (req, res) => {
  try {
    // req.rawBody is captured by the global JSON parser's verify hook. It has
    // to be: that parser runs first, so express.raw() here would be skipped and
    // the HMAC would end up computed over the string "[object Object]".
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : null
    const signature = String(req.headers["x-gigshub-signature"] || "").trim()

    if (!rawBody) {
      logger.warn("[GIGSHUB WEBHOOK] Rejected: raw body unavailable", { ip: req.ip })
      return res.status(400).json({ status: false, message: "Invalid webhook payload" })
    }

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

      const updateResult = await updateOrderByReference(reference, {
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

      // Mirror what was actually stored, not what we asked for: the monotonic
      // guard drops replayed or out-of-order callbacks.
      const appliedStatus = normalizeInternalOrderStatus(updateResult.order?.status, normalizedStatus)

      await upsertPurchaseIntent(reference, {
        provider: "gigshub",
        providerReference: reference,
        providerOrderNumber: gigshubReference,
        providerStatusRaw: rawStatus,
        providerStatusDescription: rawStatus,
        statusSource: "webhook",
        orderStatus: appliedStatus,
        providerSubmissionStatus: isTerminalOrderStatus(appliedStatus) ? "completed" : "submitted",
        paymentStatus: "success",
        errorMessage: "",
      }).catch(() => null)
      if (appliedStatus === "delivered" && updateResult.order?.storefrontSlug) {
        await settleStorefrontProfit(updateResult.order).catch((error) => logger.error("Store profit settlement failed", error, { reference }))
      }

      processedTransactions.add(reference, {
        reference,
        provider: "gigshub",
        providerReference: reference,
        providerOrderNumber: gigshubReference,
        status: appliedStatus,
        providerStatusRaw: rawStatus,
        updatedFrom: "webhook",
        updatedAt,
      })

      logger.info(`[GIGSHUB WEBHOOK] Order ${reference} updated`, {
        gigshubReference,
        requestedStatus: normalizedStatus,
        status: appliedStatus,
        statusApplied: updateResult.statusApplied !== false,
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

/**
 * CK-Godsway webhook — HMAC-SHA256 over the raw body, per CK's published spec.
 *
 * CK registers ONE endpoint per account from its API Keys page. It does not
 * carry the `?token=` query or the `x-webhook-secret` header that the generic
 * /webhook route requires, so pointing CK at /webhook gets every delivery
 * rejected 403 — and CK disables an endpoint after 10 consecutive failures.
 *
 * Because of that auto-disable rule, this route answers 200 for anything it
 * simply cannot act on (an order we do not recognise, a replayed event) and
 * reserves non-2xx for "we could not authenticate you" and genuine faults.
 */
app.post("/webhook/godsway", async (req, res) => {
  try {
    // Captured by the global JSON parser's verify hook — that parser runs
    // first, so an express.raw() here would be skipped and the HMAC would be
    // computed over the string "[object Object]".
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : null
    if (!rawBody) {
      logger.warn("[CK WEBHOOK] Rejected: raw body unavailable", { ip: req.ip })
      return res.status(400).json({ status: false, message: "Invalid webhook payload" })
    }

    const secret = String(CONFIG.godswayWebhookSecret || "").trim()
    if (!secret) {
      // Fail closed in production: an unauthenticated endpoint lets anyone mark
      // any Telecel order delivered, which suppresses reconciliation and blocks
      // the refund that a genuinely failed order is owed.
      if (WEBHOOK_SECRET_REQUIRED) {
        logger.error("[CK WEBHOOK] Rejected: GODSWAY_WEBHOOK_SECRET is not configured")
        return res.status(403).json({ status: false, message: "Webhook not authorized" })
      }
      logger.warn("[CK WEBHOOK] Accepting unsigned delivery: GODSWAY_WEBHOOK_SECRET is not set")
    } else if (!verifyGodswayWebhookSignature(rawBody, req.headers["x-webhook-signature"], secret)) {
      logger.warn("[CK WEBHOOK] Rejected: invalid signature", {
        ip: req.ip,
        deliveryId: String(req.headers["x-webhook-delivery"] || "").trim() || null,
      })
      return res.status(403).json({ status: false, message: "Invalid webhook signature" })
    }

    let payload
    try {
      payload = JSON.parse(rawBody.toString("utf8"))
    } catch {
      return res.status(400).json({ status: false, message: "Invalid JSON payload" })
    }

    const event = String(payload?.event || req.headers["x-webhook-event"] || "").trim()
    // CK's own docs say to dedupe on the top-level id, which is stable across
    // its retries (attempt increments, id does not).
    const eventId = String(payload?.id || req.headers["x-webhook-event-id"] || "").trim()
    const dedupeKey = eventId ? `godsway_event:${eventId}` : ""
    if (dedupeKey && processedTransactions.has(dedupeKey)) {
      logger.info("[CK WEBHOOK] Duplicate delivery ignored", { eventId, event })
      return res.status(200).json({ status: true, message: "Duplicate event ignored" })
    }

    const data = payload?.data && typeof payload.data === "object" ? payload.data : {}
    // data.reference is OUR reference (we send it on /data-purchase); orderNumber
    // is CK's. Try ours first, then theirs.
    const appReference = String(data.reference || "").trim()
    const godswayOrderNumber = extractGodswayOrderNumber(payload)

    let located = null
    for (const candidate of [appReference, godswayOrderNumber].filter(Boolean)) {
      located = await findOrderLocationByLookupValue(candidate, {
        includeOrder: true,
        provider: "godsway",
      })
      if (located) break
    }

    if (!located) {
      logger.warn("[CK WEBHOOK] Order not found", { appReference, godswayOrderNumber, event })
      if (dedupeKey) processedTransactions.add(dedupeKey, { event, matched: false })
      return res.status(200).json({ status: true, message: "Order not found, no update performed" })
    }

    const reference = String(located.order?.reference || "").trim()
    if (!reference) {
      if (dedupeKey) processedTransactions.add(dedupeKey, { event, matched: false })
      return res.status(200).json({ status: true, message: "Could not resolve app reference" })
    }

    // The event name is authoritative; data.status is the fallback for an event
    // we do not recognise.
    const statusDetails = getGodswayStatusDetails(payload)
    const eventStatus = getWebhookEventStatus(event)
    const normalizedStatus = eventStatus || statusDetails.normalizedStatus
    const providerStatusRaw = event || statusDetails.providerStatusRaw || ""
    const providerStatusDescription =
      statusDetails.providerStatusDescription || String(payload?.message || "").trim()
    const updatedAt = Date.now()

    const providerOrderNumber = resolveStoredProviderOrderNumber(
      "godsway",
      godswayOrderNumber || located.order?.providerOrderNumber || "",
      reference,
    )
    const providerReference = resolveStoredProviderReference(
      "godsway",
      godswayOrderNumber || located.order?.providerReference || "",
      reference,
      providerOrderNumber || "",
    )

    const updateResult = await updateOrderByReference(reference, {
      provider: "godsway",
      providerReference,
      providerOrderNumber,
      providerStatusRaw,
      providerStatusDescription,
      status: normalizedStatus,
      statusSource: "webhook",
      statusUpdatedAt: updatedAt,
      updatedAt,
      sync: {
        lastAttemptAt: updatedAt,
        lastSuccessAt: updatedAt,
        lastError: "",
        lastProviderStatusRaw: providerStatusRaw,
      },
    })

    // Mirror what was actually stored: the monotonic guard drops replayed or
    // out-of-order callbacks, so the order may not hold the status we asked for.
    const appliedStatus = normalizeInternalOrderStatus(updateResult.order?.status, normalizedStatus)

    await upsertPurchaseIntent(reference, {
      provider: "godsway",
      providerReference,
      providerOrderNumber: providerOrderNumber || "",
      providerStatusRaw,
      providerStatusDescription,
      statusSource: "webhook",
      orderStatus: appliedStatus,
      providerSubmissionStatus: isTerminalOrderStatus(appliedStatus) ? "completed" : "submitted",
      paymentStatus: "success",
      errorMessage: "",
    }).catch(() => null)
    if (appliedStatus === "delivered" && updateResult.order?.storefrontSlug) {
      await settleStorefrontProfit(updateResult.order).catch((error) => logger.error("Store profit settlement failed", error, { reference }))
    }

    processedTransactions.add(reference, {
      reference,
      provider: "godsway",
      providerReference,
      providerOrderNumber,
      status: appliedStatus,
      providerStatusRaw,
      updatedFrom: "webhook",
      updatedAt,
    })
    if (dedupeKey) processedTransactions.add(dedupeKey, { event, matched: true, reference })

    logger.info(`[CK WEBHOOK] Order ${reference} updated`, {
      event,
      eventId: eventId || null,
      attempt: Number(payload?.attempt || req.headers["x-webhook-attempt"] || 0) || null,
      requestedStatus: normalizedStatus,
      status: appliedStatus,
      statusApplied: updateResult.statusApplied !== false,
      providerOrderNumber,
    })

    return res.status(200).json({ status: true, message: "Webhook processed and order updated" })
  } catch (error) {
    logger.error("CK-Godsway webhook processing failed", error)
    return res.status(500).json({ status: false, message: "Webhook processing failed" })
  }
})

/**
 * Paystack Webhook Handler (Dual-Ingestion Push Stream - Module 3)
 * Verifies HMAC-SHA512 raw body signature against PAYSTACK_SECRET_KEY.
 * Applies 15-minute anti-replay cache to deduplicate retries without database queries.
 * Settles wallet deposits atomically via settleWalletDeposit with instant SSE broadcast.
 */
async function handlePaystackWebhook(req, res) {
  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : null
  if (!rawBody) {
    logger.warn("[PAYSTACK WEBHOOK] Rejected: raw body unavailable", { ip: req.ip })
    return res.status(400).json({ status: false, message: "Invalid webhook payload" })
  }

  const signature = req.headers["x-paystack-signature"]
  const secret = String(CONFIG.paystackSecretKey || "").trim()

  if (!secret) {
    logger.error("[PAYSTACK WEBHOOK] Rejected: PAYSTACK_SECRET_KEY is not configured")
    return res.status(500).json({ status: false, message: "Webhook secret not configured" })
  }

  // HMAC over the exact bytes received, never a re-serialised object.
  if (!verifyPaystackWebhookSignature(rawBody, signature, secret)) {
    logger.warn("[PAYSTACK WEBHOOK] Rejected: invalid signature", { ip: req.ip })
    return res.status(401).json({ status: false, message: "Invalid webhook signature" })
  }

  // 15-minute anti-replay cache. The key is recorded only after the event has
  // been handled successfully: recording it up front meant a delivery that
  // failed mid-settlement was acknowledged as a "duplicate" on Paystack's
  // retry, and that deposit was never credited by the webhook at all.
  const cacheKey = `paystack:${crypto.createHash("sha256").update(rawBody).digest("hex")}`
  if (paystackWebhookReplayCache.isDuplicate(cacheKey)) {
    logger.info("[PAYSTACK WEBHOOK] Replay ignored (cached)", { ip: req.ip })
    return res.status(200).json({ status: true, message: "Duplicate webhook delivery acknowledged" })
  }

  let payload = null
  try {
    payload = JSON.parse(rawBody.toString("utf8"))
  } catch (err) {
    logger.warn("[PAYSTACK WEBHOOK] JSON parse failed", { ip: req.ip, error: err.message })
    return res.status(400).json({ status: false, message: "Malformed JSON" })
  }

  const event = String(payload?.event || "").trim()
  logger.info("[PAYSTACK WEBHOOK] Received event", { event, ip: req.ip })

  if (event !== "charge.success") {
    paystackWebhookReplayCache.record(cacheKey)
    return res.status(200).json({ status: true, message: "Event ignored" })
  }

  const data = payload?.data || {}
  const reference = String(data.reference || "").trim()
  const amountUnits = Number(data.amount || 0)
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {}
  const paymentType = String(metadata.paymentType || "bundle").toLowerCase()

  if (!reference || !Number.isSafeInteger(amountUnits) || amountUnits <= 0 || String(data.currency || "").toUpperCase() !== "GHS") {
    logger.warn("[PAYSTACK WEBHOOK] Invalid charge data", { reference, amount: data.amount, currency: data.currency })
    // Acknowledge: retrying a structurally invalid event cannot succeed.
    paystackWebhookReplayCache.record(cacheKey)
    return res.status(200).json({ status: true, message: "Charge ignored" })
  }

  if (paymentType === "wallet") {
    const userId = String(metadata.userId || "").trim()
    if (!userId) {
      logger.warn("[PAYSTACK WEBHOOK] Missing userId in wallet deposit metadata", { reference })
      paystackWebhookReplayCache.record(cacheKey)
      return res.status(200).json({ status: true, message: "Charge ignored" })
    }

    try {
      const result = await settleWalletDeposit({
        reference,
        userId,
        amount: amountUnits / 100,
        paidAt: data.paid_at || null,
        channel: String(data.channel || "paystack"),
        source: "webhook",
      })
      if (result.inProgress) {
        // The client verify call is crediting right now. Ask Paystack to retry
        // so this delivery confirms the outcome instead of assuming it.
        return res.status(409).json({ status: false, message: "Settlement in progress" })
      }
      paystackWebhookReplayCache.record(cacheKey)
      logger.info("[PAYSTACK WEBHOOK] Wallet deposit settled", { reference, userId, alreadyCredited: result.alreadyCredited })
      return res.status(200).json({ status: true, message: result.message })
    } catch (error) {
      if (/another account/i.test(error.message || "")) {
        logger.error("[PAYSTACK WEBHOOK] Deposit ownership conflict", error, { reference, userId })
        paystackWebhookReplayCache.record(cacheKey)
        return res.status(200).json({ status: true, message: "Charge flagged for review" })
      }
      logger.error("[PAYSTACK WEBHOOK] Wallet settlement failed", error, { reference, userId })
      return res.status(500).json({ status: false, message: "Deposit settlement failed" })
    }
  }

  if (!["bundle", "guest_bundle"].includes(paymentType)) {
    paystackWebhookReplayCache.record(cacheKey)
    return res.status(200).json({ status: true, message: "Event ignored" })
  }

  // Data bundle: note the confirmed payment on the intent (never downgrading a
  // later state such as refunded), then make sure it gets fulfilled even if
  // the buyer never comes back to the site.
  try {
    await getPurchaseIntentRef(reference).transaction((current) => {
      if (!current) return current
      const status = String(current.paymentStatus || "").toLowerCase()
      if (status && !["initialized", "pending"].includes(status)) return current
      return { ...current, paymentStatus: "success", updatedAt: Date.now() }
    })
    await enqueueFulfillment(reference, {
      requesterUid: paymentType === "guest_bundle" ? "" : String(metadata.userId || ""),
      // Guests land on the receipt page, which fulfils immediately; the queue
      // only needs to catch the ones who closed the tab.
      delayMs: paymentType === "guest_bundle" ? 20_000 : 45_000,
    })
    paystackWebhookReplayCache.record(cacheKey)
    logger.info("[PAYSTACK WEBHOOK] Bundle payment confirmed", { reference, paymentType })
    return res.status(200).json({ status: true, message: "Bundle payment confirmed" })
  } catch (error) {
    logger.error("[PAYSTACK WEBHOOK] Bundle payment update failed", error, { reference })
    return res.status(500).json({ status: false, message: "Bundle update failed" })
  }
}

app.post("/webhook/paystack", handlePaystackWebhook)
app.post("/api/webhook/paystack", handlePaystackWebhook)

// Update Hubnet payload to include webhook
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
      pbmhub: pbmhubCircuitBreaker.getState(),
    },
    processedTransactions: processedTransactions._store.size,
    security: {
      activeTransactionLocks: transactionLocks.size,
      activePhoneLocks: phoneTransactionLocks.size,
      activeUserLocks: userTransactionLocks.size,
      duplicateAttempts: duplicateAttempts.size,
      // Surfaced so a misconfigured deployment is obvious without digging
      // through logs: when this is false in production every inbound provider
      // webhook is rejected and order statuses only advance via polling.
      webhookSecretConfigured: Boolean(CONFIG.providerWebhookSecret),
      // Separate from the above: CK-Godsway signs with its own dashboard
      // secret. Without it, /webhook/godsway rejects every delivery and CK
      // disables the endpoint after 10 consecutive failures.
      godswayWebhookSecretConfigured: Boolean(CONFIG.godswayWebhookSecret),
      webhookIpAllowlist: CONFIG.providerWebhookAllowedIps.length,
    },
    orderStatusSync: {
      hubnetStatusUrl: resolveHubnetStatusBaseUrl() || null,
      godswayStatusUrl: resolveGodswayStatusBaseUrl() || null,
      hubnetWebhookConfigured: Boolean(resolveHubnetWebhookUrl()),
      godswayWebhookConfigured: Boolean(resolveGodswayWebhookUrl()),
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

/**
 * Public package catalog.
 *
 * Optionally authenticated: when a valid token is supplied the caller's price
 * tier is resolved HERE and each entry carries a single `price` field. The
 * browser is never sent both prices, so it cannot pick the wrong one — and a
 * non-agent has no way to be shown or charged agent pricing. The response shape
 * is identical for every tier, which is also what keeps agent status invisible.
 */
app.get("/api/network-availability", async (req, res) => {
  try {
    const controls = await getVendingControls()
    // Estimates are decoupled from availability: a paused network keeps its
    // measured delivery time, and the card says "paused" separately.
    const estimates = await getDeliveryEstimates().catch(() => computeDeliveryEstimates([]))
    res.set("Cache-Control", "no-store")
    return res.json({ status: "success", data: { enabled: controls.enabled, networks: controls.networks, estimates } })
  } catch (error) {
    logger.error("Failed to load network availability", error)
    return res.status(503).json({ status: "error", message: "Network availability could not be checked" })
  }
})

let publicBannerCache = { at: 0, data: null }
registerCacheReset(() => { publicBannerCache = { at: 0, data: null } })

/**
 * Banners from the database, seeded with the defaults exactly once. The seed
 * is recorded under settings/, so an admin who deletes every banner gets an
 * empty carousel rather than the defaults springing back.
 */
async function getStoredBanners() {
  const snap = await db.ref("banners").once("value")
  if (snap.exists()) {
    const stored = snap.val() || {}
    // An earlier build seeded a made-up promo and an uptime claim. Retire them,
    // but only while untouched - an admin-edited copy is theirs to keep.
    const legacy = ["banner-default-promo", "banner-default-operational"]
      .filter((id) => stored[id] && Number(stored[id].updatedAt) === 1729200000000)
    if (legacy.length) {
      await db.ref().update(Object.fromEntries(legacy.map((id) => [`banners/${id}`, null]))).catch(() => null)
      for (const id of legacy) delete stored[id]
    }
    return Object.values(stored)
  }
  // Only the call that creates the flag seeds; every later call sees it.
  const seeded = await db.ref("settings/banners_seeded").transaction((current) => (current ? undefined : { at: Date.now() }))
  if (!seeded.committed) {
    return []
  }
  const defaults = getDefaultBanners()
  const updates = {}
  for (const b of defaults) {
    updates[`banners/${b.id}`] = b
  }
  await db.ref().update(updates)
  return defaults
}

app.get("/api/social-proof/deliveries", async (_req, res) => {
  try {
    const data = await getDeliveryProofs(10)
    res.set("Cache-Control", "public, max-age=30")
    return res.json({ status: "success", data, timestamp: new Date().toISOString() })
  } catch (error) {
    // No proof is better than invented proof: the ticker hides itself.
    logger.warn("Failed to fetch social proof deliveries", { message: error?.message })
    return res.json({ status: "success", data: [], timestamp: new Date().toISOString() })
  }
})

app.get("/api/banners", async (_req, res) => {
  try {
    const now = Date.now()
    if (!publicBannerCache.data || now - publicBannerCache.at > 30_000) {
      publicBannerCache = { at: now, data: await getStoredBanners() }
    }
    res.set("Cache-Control", "public, max-age=60")
    return res.json({ status: "success", data: sortBanners(publicBannerCache.data, true, now), timestamp: new Date().toISOString() })
  } catch (error) {
    logger.error("Failed to load public banners", error)
    return res.json({ status: "success", data: [], timestamp: new Date().toISOString() })
  }
})

app.get("/api/packages/:network", optionalAuthenticateRequest, async (req, res) => {
  const network = normalizeNetwork(req.params.network)

  if (!SUPPORTED_PACKAGE_NETWORKS.includes(network)) {
    return res.status(400).json({
      status: "error",
      message: "Unsupported network",
      timestamp: new Date().toISOString(),
    })
  }

  try {
    res.set("Cache-Control", "no-store")
    const controls = await getVendingControls()
    if (!isNetworkAvailable(controls, network)) {
      return res.json({ status: "success", data: [], availability: "maintenance" })
    }
    const uid = String(req.authUser?.uid || "").trim()
    // Anonymous callers and failed role lookups both fall back to regular
    // pricing: a discount is only ever granted on an explicit true.
    const agentPricing = uid ? await isPrivilegedUser(uid).catch(() => false) : false
    // Priced against the primary provider for this network — the same one the
    // purchase will be quoted and charged at, so the shelf price and the till
    // price cannot disagree.
    const route = await getProviderRouteForNetwork(network)
    const activeProvider = route[0] || ""
    const rows = await getCatalogPackages(network)
    const costs = await getProviderCosts(network)
    return res.json({
      status: "success",
      data: rows.filter((entry) => route.some((provider) =>
        isProviderConfigured(provider) && isCompleteProviderMapping(network, provider, entry) &&
        checkPriceFloor({
          costs, packageId: entry.id, provider,
          price: resolveEffectivePackagePrice(entry, { agentPricing, provider: activeProvider }),
          minimumMargin: controls.minimumMargin,
          requireCost: controls.requireProviderCosts,
        }).allowed,
      )).map((entry) => toPublicCatalogEntry(entry, { agentPricing, provider: activeProvider })),
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
    const route = await getProviderRouteForNetwork(network)
    const activeProvider = route[0] || ""
    const rows = await getCatalogPackages(network, { includeDisabled: true })
    // Ship the completeness verdict with each row. The admin editor used to
    // infer it from "does providerMappings[provider] exist", which is not the
    // rule the save path enforces - a row with an empty networkKey rendered as
    // "Mapped" and was then rejected on save with no indication of which row.
    //
    // `providerPrices` is resolved the same way the till resolves it, so the
    // number shown against each provider is the number a customer would be
    // charged if that provider served the order - not a raw, possibly blank,
    // override.
    const data = rows.map((entry) => ({
      ...entry,
      mappingMissing: describeProviderMappingGaps(network, activeProvider, entry).missing,
      providerPrices: Object.fromEntries(
        listRoutableProviders().map((provider) => [provider, resolveProviderPricePair(entry, provider)]),
      ),
    }))

    return res.json({
      status: "success",
      data,
      activeProvider,
      route,
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

  // Each network now carries an ordered list: position 0 is the primary and the
  // rest are failover. A single string is still accepted, so an older client
  // (or a saved config) keeps working.
  for (const network of SUPPORTED_PACKAGE_NETWORKS) {
    const requested = source?.[network]
    if (requested == null) {
      continue
    }

    const entries = Array.isArray(requested) ? requested : [requested]
    const invalidProvider = entries.find((entry) => entry != null && entry !== "" && !normalizeProvider(entry))
    if (invalidProvider !== undefined) {
      return res.status(400).json({
        status: "error",
        message: `Invalid provider "${invalidProvider}" for ${network}. Supported values: ${SUPPORTED_PROVIDERS.join(", ")}`,
        timestamp: new Date().toISOString(),
      })
    }
  }

  try {
    const routing = normalizeProviderRouting(source)
    await validateProviderSecretsForRouting(routing)

    // Every provider in the route is validated, not just the primary: a
    // fallback that cannot fulfil the catalog is not a fallback at all, and the
    // first time anyone finds out would be mid-outage.
    for (const network of SUPPORTED_PACKAGE_NETWORKS) {
      const rows = await getCatalogPackages(network, { includeDisabled: true })
      for (const routedProvider of routing[network]) {
        const invalidEntry = rows.find(
          (entry) => entry.enabled !== false && !isCompleteProviderMapping(network, routedProvider, entry),
        )
        if (invalidEntry) {
          return res.status(400).json({
            status: "error",
            message: `Cannot route ${network.toUpperCase()} to ${routedProvider}. ${describeProviderMappingGapMessage(network, routedProvider, invalidEntry)}`,
            timestamp: new Date().toISOString(),
          })
        }
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
    data.dispatch = await getDispatchHealth()
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

app.get("/api/admin/vending-controls", authenticateRequest, requirePrivilegedAccess, async (req, res) => {
  try {
    return res.json({ status: "success", data: await getVendingControls({ fresh: true }) })
  } catch (error) {
    logger.error("Failed to load vending controls", error)
    return res.status(503).json({ status: "error", message: "Could not load vending controls" })
  }
})

app.put("/api/admin/vending-controls", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  let data
  try {
    data = await saveVendingControls(req.body, req.authUser.uid)
  } catch (error) {
    return res.status(400).json({ status: "error", message: error.message || "Invalid vending controls" })
  }
  await recordAuditEvent({ actorUid: req.authUser.uid, action: "admin.vending_controls.update", status: "success", metadata: data })
    .catch((error) => logger.warn("Vending controls audit failed", { message: error.message }))
  return res.json({ status: "success", data })
})

app.post("/api/admin/provider-health/:provider/reset", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  try {
    await resetProviderDispatchHealth(req.params.provider)
    await recordAuditEvent({ actorUid: req.authUser.uid, action: "admin.provider_dispatch.reset", targetRef: req.params.provider, status: "success" })
      .catch(() => null)
    return res.json({ status: "success", data: await getDispatchHealth() })
  } catch (error) {
    return res.status(400).json({ status: "error", message: error.message || "Could not reset provider" })
  }
})

app.get("/api/admin/provider-costs/:network", authenticateRequest, requirePrivilegedAccess, async (req, res) => {
  const network = normalizeNetwork(req.params.network)
  if (!SUPPORTED_PACKAGE_NETWORKS.includes(network)) return res.status(400).json({ status: "error", message: "Unsupported network" })
  try {
    return res.json({ status: "success", data: await getProviderCosts(network) })
  } catch (error) {
    logger.error("Failed to load provider costs", error, { network })
    return res.status(503).json({ status: "error", message: "Could not load provider costs" })
  }
})

app.put("/api/admin/provider-costs/:network", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  try {
    const data = await saveProviderCosts(req.params.network, req.body?.costs, req.authUser.uid)
    await recordAuditEvent({ actorUid: req.authUser.uid, action: "admin.provider_costs.update", targetRef: req.params.network, status: "success" })
    return res.json({ status: "success", data })
  } catch (error) {
    return res.status(400).json({ status: "error", message: error.message || "Invalid provider costs" })
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
        message: describeProviderMappingGapMessage(network, activeProvider, invalidEntry),
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

app.get("/api/admin/banners", authenticateRequest, requirePrivilegedAccess, async (_req, res) => {
  try {
    const raw = await getStoredBanners()
    const banners = sortBanners(raw, false)
    return res.json({ status: "success", data: banners, timestamp: new Date().toISOString() })
  } catch (error) {
    logger.error("Failed to load admin banners", error)
    return res.status(500).json({ status: "error", message: "Failed to load banners" })
  }
})

app.put("/api/admin/banners", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  try {
    const requestedId = String(req.body?.id || "").trim()
    if (requestedId && !isValidBannerId(requestedId)) {
      return res.status(400).json({ status: "error", message: "Invalid banner id" })
    }
    const existing = requestedId ? (await db.ref(`banners/${requestedId}`).once("value")).val() : null
    const normalized = normalizeBanner(req.body, requestedId || null, existing)
    await db.ref(`banners/${normalized.id}`).set(normalized)
    publicBannerCache = { at: 0, data: null }
    logger.info("Admin updated banner", { bannerId: normalized.id, adminUid: req.authUser.uid })
    return res.json({ status: "success", data: normalized, timestamp: new Date().toISOString() })
  } catch (error) {
    logger.error("Failed to update banner", error)
    return res.status(400).json({ status: "error", message: error?.message || "Failed to save banner" })
  }
})

app.delete("/api/admin/banners/:id", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  try {
    const bannerId = String(req.params.id || "").trim()
    if (!isValidBannerId(bannerId)) {
      return res.status(400).json({ status: "error", message: "Banner ID is required" })
    }
    await db.ref(`banners/${bannerId}`).remove()
    publicBannerCache = { at: 0, data: null }
    logger.info("Admin deleted banner", { bannerId, adminUid: req.authUser.uid })
    return res.json({ status: "success", message: "Banner deleted", bannerId, timestamp: new Date().toISOString() })
  } catch (error) {
    logger.error("Failed to delete banner", error)
    return res.status(500).json({ status: "error", message: "Failed to delete banner" })
  }
})

/**
 * Manually set the status of a single order. Idempotent — re-sending the status
 * the order already has is a success with `changed: false`.
 */
app.patch("/api/admin/orders/:reference/status", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  const reference = String(req.params.reference || "").trim()
  const nextStatus = String(req.body?.status || req.body?.nextStatus || "").trim()
  const note = String(req.body?.note || "").trim().slice(0, 300)

  try {
    const result = await setOrderStatusManually(reference, nextStatus, {
      actorUid: req.authUser.uid,
      note,
    })

    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.order.status_update",
      targetUid: result.userId || null,
      targetRef: reference,
      status: "success",
      metadata: {
        previousStatus: result.previousStatus,
        nextStatus: result.status,
        changed: result.changed,
        provider: result.provider,
        note: note || undefined,
      },
    }).catch(() => null)

    return res.json({
      status: "success",
      message: result.changed
        ? `Order ${reference} moved from ${result.previousStatus || "unknown"} to ${result.status}.`
        : `Order ${reference} is already ${result.status}.`,
      data: result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    const errorCode = getErrorCode(error)
    const notFound = errorCode === "ADMIN_ORDER_NOT_FOUND"
    const isClientError =
      notFound ||
      ["ADMIN_ORDER_REFERENCE_REQUIRED", "ADMIN_ORDER_STATUS_INVALID"].includes(errorCode)

    if (!isClientError) {
      logger.error("Failed to update order status", error, {
        reference,
        nextStatus,
        adminUid: req.authUser.uid,
      })
    }

    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.order.status_update",
      targetRef: reference,
      status: "failed",
      metadata: {
        nextStatus,
        error: error?.providerMessage || error?.message || "Unknown error",
      },
    }).catch(() => null)

    return res.status(notFound ? 404 : isClientError ? 400 : 500).json({
      status: "error",
      errorCode: errorCode || undefined,
      message: isClientError ? error.providerMessage : "Failed to update order status",
      timestamp: new Date().toISOString(),
    })
  }
})

app.patch("/api/admin/orders/bulk-status", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  const startDate = String(req.body?.startDate || "").trim()
  const endDate = String(req.body?.endDate || "").trim()
  const currentStatus = String(req.body?.currentStatus || "").trim()
  const nextStatus = String(req.body?.nextStatus || "").trim()
  const references = Array.isArray(req.body?.references)
    ? req.body.references.map((value) => String(value || "").trim()).filter(Boolean)
    : []

  try {
    const result = await bulkUpdateOrdersStatus({
      startDate,
      endDate,
      currentStatus,
      nextStatus,
      references,
      actorUid: req.authUser.uid,
    })

    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.order.bulk_status_update",
      status: "success",
      metadata: {
        mode: result.mode,
        startDate,
        endDate,
        currentStatus: result.currentStatus,
        nextStatus: result.nextStatus,
        matched: result.matched,
        updated: result.updated,
        skipped: result.skipped,
        failed: result.failures.length,
        byProvider: result.byProvider,
      },
    }).catch(() => null)

    const failureNote = result.failures.length ? ` ${result.failures.length} failed.` : ""
    return res.json({
      status: "success",
      message: `Updated ${result.updated} of ${result.matched} matched orders to ${result.nextStatus}.${failureNote}`,
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
    const result = await setUserRoles(
      userId,
      {
        ...(hasAgentUpdate ? { isagent: isAgent } : {}),
        ...(hasAdminUpdate ? { isadmin: isAdmin } : {}),
      },
      { actorUid: req.authUser.uid },
    )

    const messageParts = []
    if (hasAgentUpdate) {
      messageParts.push(result.isagent ? "User promoted to agent" : "Agent role revoked")
    }
    if (hasAdminUpdate) {
      messageParts.push(result.isadmin ? "Admin access granted" : "Admin access revoked")
    }
    if (!result.changed) {
      messageParts.push("(no change)")
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
        changed: result.changed,
      },
    }).catch(() => null)

    return res.json({
      status: "success",
      message: messageParts.join(". "),
      data: {
        userId,
        isagent: result.isagent,
        isadmin: result.isadmin,
        changed: result.changed,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    const errorCode = getErrorCode(error)
    const clientErrorCodes = [
      "ADMIN_ROLE_USER_REQUIRED",
      "ADMIN_ROLE_NO_CHANGES",
      "ADMIN_ROLE_USER_NOT_FOUND",
      "ADMIN_ROLE_LAST_ADMIN",
    ]
    const isClientError = clientErrorCodes.includes(errorCode)

    if (!isClientError) {
      logger.error("Failed to update user role", error, { userId, adminUid: req.authUser.uid })
    }

    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.user.role_update",
      targetUid: userId,
      status: "failed",
      metadata: {
        ...(hasAgentUpdate ? { isagent: isAgent } : {}),
        ...(hasAdminUpdate ? { isadmin: isAdmin } : {}),
        error: error?.providerMessage || error?.message || "Unknown error",
      },
    }).catch(() => null)

    return res.status(isClientError ? (errorCode === "ADMIN_ROLE_USER_NOT_FOUND" ? 404 : 400) : 500).json({
      status: "error",
      errorCode: errorCode || undefined,
      message: isClientError ? error.providerMessage : "Failed to update user role",
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

/**
 * Set the AFA registration fee. The public GET /api/afa/fee above serves the
 * current value, so there is no admin-only read counterpart.
 */
app.put("/api/admin/afa/fee", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
  const requestedFee = req.body?.fee

  try {
    const result = await setAfaRegistrationFee(requestedFee, { actorUid: req.authUser.uid })

    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.afa_fee.update",
      status: "success",
      metadata: { fee: result.fee, previous: result.previous, changed: result.changed },
    }).catch(() => null)

    return res.json({
      status: "success",
      message: result.changed
        ? `AFA registration fee set to GHS ${result.fee.toFixed(2)}`
        : "AFA registration fee is already that amount",
      data: result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    const errorCode = getErrorCode(error)
    const isClientError = ["ADMIN_AFA_FEE_INVALID", "ADMIN_AFA_FEE_TOO_LARGE"].includes(errorCode)

    if (!isClientError) {
      logger.error("Failed to update AFA fee", error, { uid: req.authUser.uid, requestedFee })
    }

    await recordAuditEvent({
      actorUid: req.authUser.uid,
      actorEmail: req.authUser.email || null,
      action: "admin.afa_fee.update",
      status: "failed",
      metadata: { requestedFee, error: error?.providerMessage || error?.message || "Unknown error" },
    }).catch(() => null)

    return res.status(isClientError ? 400 : 500).json({
      status: "error",
      errorCode: errorCode || undefined,
      message: isClientError ? error.providerMessage : "Failed to update the AFA registration fee",
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

  try {
    await ensureUserAccountState(userId, req.authUser)
    const verifyData = await verifyPaystackPayment(reference)
    const paymentData = verifyData?.data || {}
    const paymentType = paymentData.metadata?.paymentType || "bundle"

    // Mobile Money approvals can outlast the redirect back to the site. That is
    // not a failure: the webhook credits the wallet the moment it settles.
    if (verifyData.status && paymentType === "wallet" &&
      ["pending", "ongoing", "processing", "queued", "send_otp", "send_birthday", "send_pin"].includes(String(paymentData.status || "").toLowerCase())) {
      return res.status(202).json({
        status: "pending",
        message: "Your payment is still being confirmed. Your wallet will update automatically.",
        timestamp: new Date().toISOString(),
      })
    }

    if (!verifyData.status || paymentData.status !== "success" || paymentType !== "wallet") {
      return res.status(400).json({
        status: "error",
        message: "Payment is not eligible for wallet credit",
        timestamp: new Date().toISOString(),
      })
    }

    if (!verifiedWalletDepositMatchesOwner(paymentData, reference, userId)) {
      return res.status(403).json({
        status: "error",
        message: "Payment details do not match this wallet deposit",
        timestamp: new Date().toISOString(),
      })
    }

    const amount = Number(paymentData.amount || 0) / 100
    const result = await settleWalletDeposit({
      reference,
      userId,
      amount,
      paidAt: paymentData.paid_at || null,
      channel: String(paymentData.channel || "paystack"),
      source: "client_polling",
    })

    if (result.inProgress) {
      return res.status(202).json({
        status: "pending",
        message: "Your deposit is being credited. Your balance will update in a moment.",
        timestamp: new Date().toISOString(),
      })
    }

    return res.json({
      status: "success",
      message: result.message,
      data: result.receipt,
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
  }
})

app.post("/api/wallet-purchase", authenticateRequest, purchaseActionRateLimit, purchaseVelocityRateLimit, async (req, res) => {
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
  if (isRecipientBlocked(phone) || isIdentityBlocked(userId) || assessRecipientVelocity(userId, phone)) {
    return res.status(403).json({ status: "error", message: "This recipient number cannot be processed at this time." })
  }

  try {
    await ensureUserAccountState(userId, req.authUser)
    if (!isNetworkAvailable(await getVendingControls(), network)) {
      return res.status(503).json({ status: "error", message: "This network is back shortly. Please try another network." })
    }
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

    // Resolved before the price, because the price is the PRIMARY provider's.
    // Filtered to who can actually serve this package, so an unconfigured or
    // unmapped provider is out of the running before any money is reserved.
    const { route, candidates, skipped } = await resolvePurchaseProviderCandidates(network, catalogEntry)
    if (!candidates.length) {
      // A distinct outcome, not a generic failure: it says the routing cannot
      // serve this order, which is a config mistake rather than an outage.
      logger.error("Purchase has no provider routed", new Error("NO_PROVIDER_ROUTED"), {
        userId,
        network,
        packageId: catalogEntry.id,
        route,
        skipped,
      })
      return res.status(503).json({
        status: "error",
        errorCode: "NO_PROVIDER_ROUTED",
        message: "This bundle cannot be delivered right now. Please try again shortly.",
        timestamp: new Date().toISOString(),
      })
    }

    // Tracks whichever provider is currently being attempted: the primary at
    // first, then each failover in turn. Everything downstream - the order
    // record, the error message, the parked-order note - refers to the provider
    // the order actually reached, not the one it started at.
    let provider = candidates[0].provider
    const primaryProvider = provider
    const amount = await getEffectivePackagePrice(catalogEntry, userId, { provider: primaryProvider })
    if (!amount || amount <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Selected package has an invalid price",
        timestamp: new Date().toISOString(),
      })
    }
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
      await updateIdempotencyKey(userId, idempotencyKey, { status: "failed" }).catch(() => null)
      return res.status(409).json({
        status: "error",
        message: "You have a transaction in progress. Please wait.",
        timestamp: new Date().toISOString(),
      })
    }

    const reference = generateReference(network === "telecel" ? "TELECEL_PBM" : `${network.toUpperCase()}_PBM`)
    // One id for the whole reservation lifecycle. Holding, capturing and
    // releasing all key on it, so every one of them is safe to replay.
    const holdId = sanitizeMutationId(`purchase-hold:${reference}`)
    // Still needed for the ledger entry a capture writes. There is no refund
    // mutation any more: a purchase no provider took releases its reservation
    // instead, which never moved the balance and so has nothing to reverse.
    const debitMutationId = sanitizeMutationId(`purchase-debit:${reference}`)
    let balance = 0
    let held = false
    let captured = false
    let vendorCompleted = false
    let providerResult = null
    try {
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

      // RESERVE, do not charge. The funds stop being spendable so a second
      // purchase cannot claim them, but the balance does not move until a
      // provider has actually taken the order.
      const holdResult = await holdWalletBalance(userId, amount, {
        holdId,
        reference,
        reason: "wallet_purchase_hold",
        details: {
          network,
          phone,
          packageId: catalogEntry.id,
        },
      })
      held = true
      balance = holdResult.balance

      // Walk the route. A definitive refusal moves to the next provider; an
      // uncertain one (timeout, connection reset) must NOT - the order may
      // already be live upstream, and attempting it elsewhere would deliver and
      // charge for the same bundle twice.
      let lastFailure = null
      const providerAttempts = []

      for (const [index, candidate] of candidates.entries()) {
        provider = candidate.provider
        try {
          providerResult = await dispatchGuarded({ provider, network, catalogEntry, amount, purchase: () => getProviderAdapter(provider).purchase({
            network,
            phone,
            reference,
            catalogEntry,
            amount,
            hasNextProvider: hasCandidateAfter(candidates, index),
          }) })
          break
        } catch (error) {
          const errorCode = getErrorCode(error)
          const uncertain = isIndeterminateProviderSubmissionError(error)
          providerAttempts.push({
            provider,
            position: candidate.position,
            errorCode,
            uncertain,
          })

          logger.warn("Provider refused a purchase", {
            reference,
            provider,
            position: candidate.position,
            errorCode,
            uncertain,
            remaining: uncertain ? 0 : candidates.length - index - 1,
            providerMessage: error?.providerMessage || error?.message || "",
          })

          if (uncertain) {
            // Stop the chain and let the catch below hold the charge and park
            // the order. Failing over here is the double-delivery bug.
            error.providerAttempts = providerAttempts
            throw error
          }

          // Keep the most informative reason: a trailing candidate that fails
          // for a dull reason must not overwrite the real refusal.
          lastFailure = preferInformativeProviderFailure(lastFailure, error)
        }
      }

      if (!providerResult) {
        // Every routed provider definitively refused. The hold is released in
        // the catch below, so the customer is never charged a cedi.
        const allFailed = lastFailure || createAppError("PROVIDER_PURCHASE_FAILED", {
          providerMessage: "No provider accepted this order.",
        })
        allFailed.providerAttempts = providerAttempts
        throw allFailed
      }

      // Set the instant a provider takes the order, BEFORE the charge. If the
      // capture below fails, the catch must not release the reservation and
      // mark the order failed - the provider already has it, and doing so would
      // deliver the bundle for free.
      vendorCompleted = true

      if (providerAttempts.length) {
        logger.info("Purchase served by a failover provider", {
          reference,
          primaryProvider,
          servingProvider: provider,
          failedOver: providerAttempts.map((item) => `${item.provider}(${item.errorCode})`),
        })
      }

      let vendorMeta = {}

      // CHARGE. Only now, and only because a provider took the order.
      const captureResult = await captureWalletHold(userId, holdId, {
        reference,
        reason: "wallet_purchase_debit",
      })
      if (captureResult.outcome === WALLET_MUTATION.CONFLICT || captureResult.outcome === WALLET_MUTATION.MISSING) {
        // The reservation is gone but the provider has the order. Never retry
        // the charge blindly - surface it for a human instead.
        logger.error("Provider accepted an order whose hold could not be captured", new Error(captureResult.outcome), {
          userId,
          reference,
          provider,
          outcome: captureResult.outcome,
        })
        throw createAppError("WALLET_CAPTURE_UNCONFIRMED", { outcome: captureResult.outcome })
      }
      captured = captureResult.outcome === WALLET_MUTATION.COMMIT || captureResult.outcome === WALLET_MUTATION.DUPLICATE
      if (!captured) {
        throw createAppError("WALLET_CAPTURE_UNCONFIRMED", { outcome: captureResult.outcome })
      }
      balance = captureResult.balance

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
      const indeterminateProviderFailure = held && !vendorCompleted && isIndeterminateProviderSubmissionError(error)
      if (indeterminateProviderFailure) {
        // The order may be live upstream, so the customer IS charged: the
        // reservation becomes a real debit and the order is parked for review.
        // Releasing here would risk delivering a bundle for free.
        const pendingMessage = getIndeterminateProviderSubmissionMessage(provider)
        const captureResult = await captureWalletHold(userId, holdId, {
          reference,
          reason: "wallet_purchase_debit_pending_confirmation",
        }).catch((captureError) => {
          logger.error("Failed to capture hold for an indeterminate purchase", captureError, { userId, reference })
          return null
        })
        if (captureResult?.outcome === WALLET_MUTATION.COMMIT || captureResult?.outcome === WALLET_MUTATION.DUPLICATE) {
          captured = true
        }
        const currentWallet = await getUserWalletRecord(userId).catch(() => ({ balance }))

        if (captured) {
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
        }

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
          paymentStatus: captured ? "wallet_debited" : "wallet_capture_unconfirmed",
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
          paymentStatus: captured ? "wallet_debited" : "wallet_capture_unconfirmed",
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

      if (held && !captured && !vendorCompleted) {
        // Every routed provider definitively refused. RELEASE the reservation:
        // the balance never moved, so there is no debit to reverse and no
        // refund to issue - the customer simply gets their spendable balance
        // back. This is the path the "never deducted" guarantee rests on.
        let releaseFailed = false
        try {
          const releaseResult = await releaseWalletHold(userId, holdId, {
            reference,
            reason: "wallet_purchase_release",
          })
          balance = releaseResult.balance
          releaseFailed = releaseResult.outcome === WALLET_MUTATION.CONFLICT
        } catch (releaseError) {
          releaseFailed = true
          // The balance is untouched, so no money has been taken - but the
          // amount stays reserved and unspendable until this is settled. It is
          // deliberately NOT queued on the refund outbox: that credits a wallet,
          // and crediting funds that were never debited would create money.
          logger.error("[HOLD STUCK] Failed to release a hold after a failed purchase", releaseError, {
            userId,
            reference,
            holdId,
            amount,
          })
        }

        // Recorded as failed and terminal, so nothing downstream can pick it up
        // and deliver it: the reconciler skips terminal orders and no retry path
        // treats a failed wallet purchase as re-dispatchable.
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
          // Not "refunded": nothing was ever taken, so there is nothing to
          // refund. Saying otherwise would double-count in the money reports.
          refunded: false,
          paymentStatus: releaseFailed ? "wallet_hold_stuck" : "wallet_not_charged",
          retryEligible: false,
          providerAttempts: error?.providerAttempts || [],
          commercialReview: errorCode === "PRICE_FLOOR_BLOCKED" || (error?.providerAttempts || []).some((attempt) => attempt.errorCode === "PRICE_FLOOR_BLOCKED"),
          errorMessage: error.message,
          createdAt: Date.now(),
        }).catch((orderError) => {
          logger.error("Failed to store failed order record", orderError, { userId, reference })
        })
        await upsertPurchaseIntent(reference, {
          paymentStatus: releaseFailed ? "wallet_hold_stuck" : "wallet_not_charged",
          orderStatus: "failed",
          providerSubmissionStatus: "failed",
          retryEligible: false,
          errorMessage: error?.message || "Purchase failed before provider confirmation",
        }).catch(() => null)
      }

      if (!held && !vendorCompleted) {
        await upsertPurchaseIntent(reference, {
          paymentStatus: "wallet_not_charged",
          orderStatus: "failed",
          providerSubmissionStatus: "failed",
          retryEligible: true,
          errorMessage: error?.message || "Wallet reservation failed",
        }).catch(() => null)
        await updateIdempotencyKey(userId, idempotencyKey, { status: "failed", reference }).catch(() => null)
      }

      if (vendorCompleted) {
        if (!captured) {
          // The provider may deliver this order. Keep it visible for manual
          // reconciliation without claiming that the customer was charged.
          const reviewMessage = "Provider accepted the order, but wallet capture needs review. Contact support with this reference."
          await createOrderRecord(userId, {
            userId, reference, packageId: catalogEntry.id, label: catalogEntry.label,
            volume: catalogEntry.volume, amount, network, provider, phone,
            status: "processing", paymentStatus: "wallet_capture_unconfirmed",
            providerReference: providerResult?.providerReference || "",
            providerOrderNumber: providerResult?.providerOrderNumber || "",
            providerStatusRaw: providerResult?.providerStatusRaw || "accepted",
            retryEligible: false, errorMessage: reviewMessage, createdAt: Date.now(),
            sync: { nextAttemptAt: null, skippedReason: "wallet_capture_unconfirmed" },
          }).catch((orderError) => logger.error("Failed to store order awaiting wallet capture review", orderError, { userId, reference }))
          await upsertPurchaseIntent(reference, {
            paymentStatus: "wallet_capture_unconfirmed", orderStatus: "processing",
            providerSubmissionStatus: "submitted", provider, retryEligible: false,
            errorMessage: reviewMessage,
          }).catch(() => null)
          await updateIdempotencyKey(userId, idempotencyKey, { status: "indeterminate", reference }).catch(() => null)
          return res.status(202).json({
            status: "success", message: reviewMessage,
            data: { reference, orderStatus: "processing", amount, phone, network,
              volume: catalogEntry.volume, label: catalogEntry.label, packageId: catalogEntry.id },
            timestamp: new Date().toISOString(),
          })
        }
        logger.error("Purchase completed but local persistence failed", error, { userId, network, reference })
        const recoveryMessage = "Provider accepted this order, but confirmation storage needs review. Contact support with this reference."
        await recordTransaction({
          userId, type: "purchase", amount: -amount, balance, reference,
          mutationId: debitMutationId,
          details: { network, phone, volume: catalogEntry.volume, label: catalogEntry.label, packageId: catalogEntry.id },
        }).catch((transactionError) => logger.error("Failed to recover captured purchase ledger entry", transactionError, { userId, reference }))
        const existingOrder = await findOrderLocationByReference(reference, { includeOrder: true }).catch(() => null)
        if (!existingOrder) {
          await createOrderRecord(userId, {
            userId, reference, packageId: catalogEntry.id, label: catalogEntry.label,
            volume: catalogEntry.volume, amount, network, provider, phone,
            status: "processing", paymentStatus: "wallet_debited",
            providerReference: providerResult?.providerReference || "",
            providerOrderNumber: providerResult?.providerOrderNumber || "",
            providerStatusRaw: providerResult?.providerStatusRaw || "accepted",
            retryEligible: false, errorMessage: recoveryMessage, createdAt: Date.now(),
          }).catch((orderError) => logger.error("Failed to store order awaiting confirmation review", orderError, { userId, reference }))
        }
        await upsertPurchaseIntent(reference, {
          paymentStatus: "wallet_debited", orderStatus: existingOrder?.order?.status || "processing",
          providerSubmissionStatus: "submitted", provider, retryEligible: false,
          errorMessage: recoveryMessage,
        }).catch(() => null)
        await updateIdempotencyKey(userId, idempotencyKey, { status: "indeterminate", reference }).catch(() => null)
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

      if (/HUBNET|GODSWAY|GIGSHUB|PBMHUB|PROVIDER|NETWORK_PAUSED|PRICE_FLOOR/.test(errorCode)) {
        return res.status(503).json({
          status: "error",
          message: "This bundle cannot be delivered right now. Please try again shortly.",
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

/**
 * The signed-in user's role, as far as the browser needs to know it.
 *
 * Deliberately exposes ONLY `admin`, which gates the admin navigation. Agent
 * status is withheld: agent pricing is applied server-side and must be
 * invisible to the customer, and the client no longer has any pricing decision
 * to make that would need it.
 */
app.get("/api/me/role", authenticateRequest, async (req, res) => {
  try {
    await ensureUserAccountState(req.authUser.uid, req.authUser)
    const role = await getUserRoleSummary(req.authUser.uid)
    return res.json({
      status: "success",
      data: { admin: role.admin === true },
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
    pbmhub: pbmhubCircuitBreaker,
  }

  const breaker = breakers[service]
  if (!breaker) {
    return res.status(400).json({
      status: "error",
      message: "Invalid service. Supported services: paystack, hubnet, godsway, gigshub, pbmhub",
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

app.post("/api/initiate-payment", authenticateRequest, purchaseActionRateLimit, purchaseVelocityRateLimit, async (req, res) => {
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

    if (!isNetworkAvailable(await getVendingControls(), normalizedNetwork)) {
      return res.status(503).json({ status: "error", message: "This network is back shortly. Please try another network." })
    }

    if (!/^\d{10}$/.test(normalizedPhone)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid phone number format",
      })
    }
    if (isRecipientBlocked(normalizedPhone) || isIdentityBlocked(authUserId) || assessRecipientVelocity(authUserId, normalizedPhone)) {
      return res.status(403).json({ status: "error", message: "This recipient number cannot be processed at this time." })
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
    const paymentRoute = await getProviderRouteForNetwork(normalizedNetwork)
    normalizedAmount = await getEffectivePackagePrice(catalogEntry, authUserId, { provider: paymentRoute[0] })
    const costCheck = await evaluateSaleGuard({
      network: normalizedNetwork, packageId: catalogEntry.id,
      provider: paymentRoute[0], price: normalizedAmount,
    })
    if (!costCheck.allowed) {
      return res.status(503).json({ status: "error", message: "This bundle is temporarily unavailable. Please try again shortly." })
    }

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

    // Always minted here. A client-chosen reference could name another user's
    // pending deposit or intent, and references double as receipt capabilities.
    void reference
    const paymentReference = generateReference(prefix)
    const amountInKobo = Math.round(numAmount * 100)

    const payload = {
      amount: amountInKobo,
      email: paymentOwnerEmail,
      reference: paymentReference,
      callback_url: paymentType === "wallet" ? buildFrontendUrl("/wallet") : buildFrontendUrl("/buy"),
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

    if (paymentType === "wallet") {
      await db.ref(`deposits/${paymentReference}`).set({
        reference: paymentReference,
        userId: authUserId,
        amount: toMoneyNumber(numAmount, 0),
        status: "pending",
        channel: "paystack",
        createdAt: Date.now(),
        metadata: {
          email: paymentOwnerEmail,
          fcmToken: fcmToken || null,
        },
      }).catch((err) => logger.warn("Failed to record pending deposit intent", { reference: paymentReference, error: err?.message }))
    } else {
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

  let verificationLease = null
  try {
    if (isValidRepairReference(reference)) {
      verificationLease = await claimRepairLease(reference)
      if (!verificationLease) {
        return res.status(409).json({ status: "pending", message: "This order is already being checked. Please try again shortly." })
      }
      // Re-read under the lease. Another path (the webhook-driven repair
      // pipeline, a second tab) may have created and dispatched this order
      // since the unlocked read above; dispatching again would double-deliver.
      const lockedOrder = await findOrderLocationByReference(reference, { includeOrder: true }).catch(() => null)
      if (lockedOrder?.order) {
        const order = normalizeStoredOrderRecord(lockedOrder.order)
        return res.json({
          status: "success",
          message: "Transaction already processed",
          data: { reference, alreadyProcessed: true, orderStatus: order.status, amount: toMoneyNumber(order.amount, 0) },
          timestamp: new Date().toISOString(),
        })
      }
    }
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
      if (isRecipientBlocked(phone) || isIdentityBlocked(userId)) {
        return res.status(403).json({ status: "error", message: "This recipient number cannot be processed at this time." })
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

      let provider = existingOrderLocation?.order?.provider || (await getActiveProviderForNetwork(network))
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
        const { candidates } = await resolvePurchaseProviderCandidates(network, catalogEntry)
        const orderedCandidates = [
          ...candidates.filter((candidate) => candidate.provider === provider),
          ...candidates.filter((candidate) => candidate.provider !== provider),
        ]
        let providerResult = null
        let lastFailure = null
        for (const candidate of orderedCandidates) {
          provider = candidate.provider
          try {
            providerResult = await dispatchGuarded({ provider, network, catalogEntry, amount: paymentAmount, purchase: () => getProviderAdapter(provider).purchase({
              network, phone, reference, catalogEntry, amount: paymentAmount,
            }) })
            break
          } catch (error) {
            if (isIndeterminateProviderSubmissionError(error)) throw error
            lastFailure = preferInformativeProviderFailure(lastFailure, error)
          }
        }
        if (!providerResult) throw lastFailure || createAppError("NO_PROVIDER_ROUTED")

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
        const message = errorCode === "PRICE_FLOOR_BLOCKED"
          ? "This order needs a pricing review before delivery. Your payment is recorded."
          : indeterminateProviderFailure
          ? getIndeterminateProviderSubmissionMessage(provider)
          : "Your payment is recorded. Delivery is pending; please check your order shortly."
        const commercialHold = errorCode === "PRICE_FLOOR_BLOCKED"
        const nextAttemptAt = indeterminateProviderFailure || commercialHold ? null : Date.now() + CONFIG.orderSyncRetryDelayMs
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
          retryEligible: indeterminateProviderFailure || commercialHold ? false : true,
          commercialReview: commercialHold,
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
            skippedReason: commercialHold ? "price_floor_review" : indeterminateProviderFailure ? "provider_submission_indeterminate" : "",
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
          retryEligible: indeterminateProviderFailure || commercialHold ? false : true,
          errorMessage: message,
        }).catch(() => null)

        return res.status(indeterminateProviderFailure ? 202 : 200).json({
          status: "pending",
          paymentStatus: "success",
          errorCode: commercialHold ? "PRICING_REVIEW" : "DELIVERY_PENDING",
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
    if (verificationLease) {
      await releaseRepairLease(reference, verificationLease).catch((error) => logger.error("Verification lease release failed", error, { reference }))
    }
    releaseTransactionLock(reference)
  }
})

/**
 * The 7-step self-healing repair pipeline, independent of HTTP so it can run
 * from a customer's Repair button, the receipt page, or a Paystack webhook
 * for a buyer who paid and closed the tab. Returns { code, body }.
 *
 * `requesterUid` is the signed-in caller ("" for guests). Server-side callers
 * pass the payer uid from a signature-verified Paystack event.
 */
async function runRepairPipeline({ reference, requesterUid: rawRequesterUid = "" }) {
  const reply = (code, body) => ({ code, body })
  if (!isValidRepairReference(reference)) {
    return reply(400, { status: "error", message: "Enter a valid order or payment reference." })
  }

  const leaseToken = await claimRepairLease(reference)
  if (!leaseToken) {
    return reply(409, { status: "pending", message: "This order is already being checked. Please check its status shortly." })
  }

  try {
    let located = await findOrderLocationByReference(reference, { includeOrder: true })
    let intent = await getPurchaseIntent(reference)
    const order = located?.order || null
    const ownerUid = String(located?.userId || intent?.userId || "")
    const guest = order?.isGuest === true || intent?.type === "guest_bundle"
    const requesterUid = String(rawRequesterUid || "")
    if (ownerUid && !guest && requesterUid !== ownerUid) {
      return reply(404, { status: "error", message: "Order not found for this account." })
    }

    const knownState = classifyRepairState(order || {}, intent || {})
    if (!guest && knownState === "refunded") {
      return reply(409, { status: "error", message: "This order was already refunded to your balance." })
    }
    if (!guest && knownState === "delivered") {
      if (order?.storefrontSlug) await settleStorefrontProfit(order).catch((error) => logger.error("Store profit settlement failed", error, { reference }))
      return reply(200, { status: "success", message: "This order was already delivered.", data: order ? toPublicOrderRecord(order) : { reference, status: "delivered" } })
    }

    const paymentStatus = String(order?.paymentStatus || intent?.paymentStatus || "").toLowerCase()
    const walletPurchase = intent?.type === "wallet_purchase" || ["wallet_debited", "wallet_debited_pending", "wallet_capture_unconfirmed", "wallet_not_charged", "wallet_refunded", "refunded"].includes(paymentStatus)
    let payment = null
    if (!walletPurchase) {
      const verified = await verifyPaystackPayment(reference)
      payment = verified?.status && verified?.data?.status === "success" ? verified.data : null
      if (!payment || String(payment.reference || "") !== reference || String(payment.currency || "").toUpperCase() !== "GHS") {
        return reply(409, { status: "pending", message: "Payment is not confirmed yet. Please check again shortly." })
      }
      const metadata = payment.metadata || {}
      if (String(metadata.paymentType || "").toLowerCase() === "wallet") {
        return reply(400, { status: "error", message: "This reference is for a wallet deposit, not a data order." })
      }
      if (ownerUid && metadata.userId && metadata.userId !== ownerUid && !guest) {
        return reply(409, { status: "error", message: "Payment details do not match this order." })
      }
      if (!ownerUid && metadata.userId && metadata.userId !== requesterUid) {
        return reply(404, { status: "error", message: "Order not found for this account." })
      }
      if (!ownerUid && !metadata.userId && (String(metadata.paymentType || "").toLowerCase() !== "guest_bundle" || reference.length < 24)) {
        return reply(404, { status: "error", message: "Order not found." })
      }
      if (guest && String(metadata.paymentType || "").toLowerCase() !== "guest_bundle") {
        return reply(409, { status: "error", message: "Payment details do not match this guest order." })
      }
      const expectedAmount = Number(order?.amount || intent?.amount || 0)
      if (expectedAmount > 0 && toMoneyUnits(expectedAmount) !== Number(payment.amount || 0)) {
        return reply(409, { status: "error", message: "Payment amount does not match this order. Support will review it." })
      }
    }

    const currentState = classifyRepairState(order || {}, intent || {})
    if (currentState === "refunded") {
      return reply(409, { status: "error", message: "This order was already refunded to your balance." })
    }
    if (currentState === "delivered") {
      if (order?.storefrontSlug) await settleStorefrontProfit(order).catch((error) => logger.error("Store profit settlement failed", error, { reference }))
      await queueRepairConfirmation({ reference, phone: order?.phone || intent?.phone, userId: located?.userId || ownerUid, guest }).catch(() => null)
      return reply(200, { status: "success", message: "This order was already delivered.", data: toPublicOrderRecord(order) })
    }
    if (walletPurchase && !["success", "wallet_debited", "wallet_debited_pending", "wallet_capture_unconfirmed"].includes(paymentStatus)) {
      return reply(409, { status: "error", message: "This wallet order has not been charged." })
    }

    if (!located) {
      const metadata = payment?.metadata || {}
      const network = normalizePurchaseNetwork(intent?.network || metadata.network || metadata.carrier)
      const phone = sanitizePhoneNumber(intent?.phone || metadata.phone || metadata.recipient || metadata.recipient_phone)
      const packageId = String(intent?.packageId || metadata.packageId || metadata.plan_id || metadata.bundle_id || "")
      const catalogEntry = await getCatalogPackage(network, { packageId, volume: Number(intent?.volume || metadata.volume || 0) })
      if (!catalogEntry || phone.length !== 10 || !SUPPORTED_PACKAGE_NETWORKS.includes(network)) {
        return reply(409, { status: "pending", message: "Payment is confirmed. The order needs a catalog review before delivery." })
      }
      const amount = Number(payment.amount || 0) / 100
      const isGuest = intent?.type === "guest_bundle" || (!ownerUid && !metadata.userId)
      const uid = isGuest
        ? `guest_${crypto.createHash("sha256").update(reference).digest("hex").slice(0, 24)}`
        : ownerUid || requesterUid
      const provider = intent?.provider || (await getActiveProviderForNetwork(network))
      if (!intent && (toMoneyUnits(amount) < toMoneyUnits(resolveUserPrice(catalogEntry, { provider })) ||
        (Number(metadata.volume || 0) > 0 && Number(metadata.volume) !== Number(catalogEntry.volume)))) {
        return reply(409, { status: "error", message: "Payment details need review before this bundle can be delivered." })
      }
      const previouslySubmitted = ["processing", "submitted", "completed"].includes(intent?.providerSubmissionStatus)
      const created = await createOrderRecord(uid, {
        reference, userId: uid, isGuest, network, phone, packageId: catalogEntry.id,
        label: catalogEntry.label, volume: catalogEntry.volume, amount, provider,
        status: previouslySubmitted ? "processing" : "failed",
        paymentStatus: "success", retryEligible: !previouslySubmitted,
        providerReference: intent?.providerReference || "", providerOrderNumber: intent?.providerOrderNumber || "",
        storefrontSlug: intent?.storefrontSlug || metadata.storefrontSlug || "",
        storefrontOwnerUid: intent?.storefrontOwnerUid || metadata.storefrontOwnerUid || "",
        storefrontWholesale: Number(intent?.storefrontWholesale || metadata.storefrontWholesale || 0),
        statusSource: "repair_reconstruction", createdAt: Date.now(),
      })
      located = { userId: uid, orderId: created.id, order: created }
      intent = await upsertPurchaseIntent(reference, {
        userId: uid, type: isGuest ? "guest_bundle" : "bundle",
        network, phone, packageId: catalogEntry.id, volume: catalogEntry.volume,
        label: catalogEntry.label, amount, paymentStatus: "success",
        orderStatus: created.status, provider, retryEligible: !previouslySubmitted,
        storefrontSlug: created.storefrontSlug, storefrontOwnerUid: created.storefrontOwnerUid,
        storefrontWholesale: created.storefrontWholesale,
      })
    }

    let liveOrder = located.order
    const provider = normalizeProvider(liveOrder.provider, "")
    let upstream = null
    if (provider) {
      try {
        upstream = await getProviderAdapter(provider).getOrderStatus(liveOrder)
      } catch (error) {
        logger.warn("Repair status check unavailable", { reference, provider, errorCode: getErrorCode(error) })
      }
    }
    const upstreamStatus = upstream?.supported === false ? "" : normalizeInternalOrderStatus(upstream?.status, "")
    const upstreamFailed = hasDefinitiveProviderFailure(upstream)
    if (upstreamStatus === "delivered") {
      const applied = await updateOrderByReference(reference, {
        status: "delivered", statusSource: "repair_reconciliation", statusUpdatedAt: Date.now(),
        deliveredAt: Date.now(), repairedAt: Date.now(), retryEligible: false,
        providerStatusRaw: upstream.providerStatusRaw || "delivered",
        providerReference: upstream.providerReference || liveOrder.providerReference || "",
        providerOrderNumber: upstream.providerOrderNumber || liveOrder.providerOrderNumber || "",
        repairDispatchClaim: null,
      }, { manual: true })
      await syncPurchaseIntentFromOrder(reference, applied.order).catch(() => null)
      if (applied.order?.storefrontSlug) await settleStorefrontProfit(applied.order).catch((error) => logger.error("Store profit settlement failed", error, { reference }))
      await queueRepairConfirmation({ reference, phone: applied.order?.phone, userId: located.userId, guest: applied.order?.isGuest === true }).catch(() => null)
      runRepairNotificationQueue().catch((error) => logger.error("Repair notification send failed", error, { reference }))
      return reply(200, { status: "success", message: "Delivery confirmed.", data: toPublicOrderRecord(applied.order) })
    }
    if (upstreamStatus && !["failed", "cancelled"].includes(upstreamStatus)) {
      await updateOrderByReference(reference, { status: upstreamStatus, statusSource: "repair_reconciliation", statusUpdatedAt: Date.now() })
      return reply(202, { status: "pending", message: "This order is still being processed. Please check again shortly.", data: { reference, orderStatus: upstreamStatus } })
    }

    const previousState = classifyRepairState(liveOrder, intent || {})
    if (intent?.providerSubmissionStatus === "processing" && Number(intent.processingExpiresAt || 0) > Date.now()) {
      return reply(202, { status: "pending", message: "The original delivery is still being processed. Please check again shortly.", data: { reference, orderStatus: liveOrder.status } })
    }
    if (!canRedispatchAfterStatus({ previousState, upstream, order: liveOrder, intent: intent || {} })) {
      return reply(202, { status: "pending", message: "We are checking the original delivery before trying again.", data: { reference, orderStatus: liveOrder.status } })
    }
    if (isRecipientBlocked(liveOrder.phone) || (!guest && isIdentityBlocked(ownerUid))) {
      return reply(403, { status: "error", message: "This recipient number cannot be processed at this time." })
    }
    const originalWasSubmitted = Boolean(upstreamFailed || hasProviderSubmissionEvidence(liveOrder, intent || {}))
    if (upstreamFailed) {
      const failed = await updateOrderByReference(reference, { status: "failed", retryEligible: true, repairDispatchClaim: null, statusSource: "repair_reconciliation" }, { manual: true })
      liveOrder = failed.order
    }
    const claimed = await claimRepairDispatch({ userId: located.userId, orderId: located.orderId, token: leaseToken, fallbackOrder: liveOrder })
    if (!claimed) {
      return reply(202, { status: "pending", message: "This order is already being checked.", data: { reference } })
    }

    const network = normalizePurchaseNetwork(liveOrder.network)
    const catalogEntry = await getCatalogPackage(network, { packageId: liveOrder.packageId })
    if (!catalogEntry) {
      await updateOrderByReference(reference, { repairDispatchClaim: null, retryEligible: true, commercialReview: true })
      return reply(202, { status: "pending", message: "This order needs a catalog review before delivery.", data: { reference } })
    }
    const { candidates } = await resolvePurchaseProviderCandidates(network, catalogEntry)
    const dispatchCandidates = originalWasSubmitted && provider
      ? candidates.filter((candidate) => candidate.provider !== provider)
      : candidates
    if (!dispatchCandidates.length) {
      await updateOrderByReference(reference, { repairDispatchClaim: null, retryEligible: true, commercialReview: true })
      return reply(202, { status: "pending", message: "No safe delivery route is available. This order is queued for review.", data: { reference } })
    }

    let result = null
    let servingProvider = ""
    let uncertain = false
    for (const [index, candidate] of dispatchCandidates.entries()) {
      servingProvider = candidate.provider
      try {
        result = await dispatchGuarded({ provider: servingProvider, network, catalogEntry, amount: liveOrder.amount, purchase: () => getProviderAdapter(servingProvider).purchase({
          network, phone: liveOrder.phone, reference, catalogEntry, amount: liveOrder.amount,
          providerIdempotencyKey: `${reference}:repair:${Number(liveOrder.repairAttempts || 0) + 1}`,
          hasNextProvider: hasCandidateAfter(dispatchCandidates, index),
        }) })
        break
      } catch (error) {
        if (isIndeterminateProviderSubmissionError(error)) { uncertain = true; break }
        logger.warn("Repair route refused", { reference, provider: servingProvider, errorCode: getErrorCode(error) })
      }
    }
    if (uncertain) {
      const pendingOrder = await updateOrderByReference(reference, {
        provider: servingProvider, status: "processing", statusSource: "repair_submission_pending",
        retryEligible: false, repairAttempts: Number(liveOrder.repairAttempts || 0) + 1,
        repairDispatchClaim: null,
        sync: { nextAttemptAt: Date.now() + CONFIG.orderSyncRetryDelayMs },
      })
      // Mark the intent submitted too, so no other entry point treats the
      // order as never-dispatched while the provider's answer is unknown.
      await syncPurchaseIntentFromOrder(reference, pendingOrder.order || liveOrder, {
        providerSubmissionStatus: "submitted", retryEligible: false,
      }).catch(() => null)
      return reply(202, { status: "pending", message: "Delivery is awaiting confirmation. Please check this order before trying again.", data: { reference, orderStatus: "processing" } })
    }
    if (!result) {
      await updateOrderByReference(reference, {
        status: "failed", repairDispatchClaim: null, retryEligible: false,
        commercialReview: true, statusSource: "repair_review",
      }, { manual: true })
      return reply(202, { status: "pending", message: "No delivery route accepted this order. It is queued for review.", data: { reference } })
    }
    const updated = await updateOrderByReference(reference, {
      provider: servingProvider, status: result.status || "accepted", statusSource: "repair_dispatch",
      statusUpdatedAt: Date.now(), repairedAt: Date.now(), retryEligible: false,
      repairAttempts: Number(liveOrder.repairAttempts || 0) + 1,
      providerReference: result.providerReference || "", providerOrderNumber: result.providerOrderNumber || "",
      providerStatusRaw: result.providerStatusRaw || "accepted", repairDispatchClaim: null,
    }, { manual: true })
    await syncPurchaseIntentFromOrder(reference, updated.order, { paymentStatus: liveOrder.paymentStatus, retryEligible: false }).catch(() => null)
    if (normalizeInternalOrderStatus(updated.order?.status, "") === "delivered") {
      if (updated.order?.storefrontSlug) await settleStorefrontProfit(updated.order).catch((error) => logger.error("Store profit settlement failed", error, { reference }))
      await queueRepairConfirmation({ reference, phone: updated.order?.phone, userId: located.userId, guest: updated.order?.isGuest === true }).catch(() => null)
      runRepairNotificationQueue().catch((error) => logger.error("Repair notification send failed", error, { reference }))
      return reply(200, { status: "success", message: "Delivery confirmed without another charge.", data: toPublicOrderRecord(updated.order) })
    }
    return reply(202, { status: "pending", message: "Delivery has been restarted without another charge. Check again for confirmation.", data: toPublicOrderRecord(updated.order) })
  } catch (error) {
    logger.error("Order repair failed", error, { reference })
    return reply(503, { status: "pending", message: "We could not finish checking this order. Please check again shortly.", data: { reference } })
  } finally {
    await releaseRepairLease(reference, leaseToken).catch((error) => logger.error("Repair lease release failed", error, { reference }))
  }
}

async function handleRepairOrder(req, res) {
  const reference = String(req.params?.reference || req.body?.reference || "").trim()
  const { code, body } = await runRepairPipeline({ reference, requesterUid: String(req.authUser?.uid || "") })
  if (body?.data?.isGuest === true && body.data.phone) body.data = { ...body.data, phone: maskPhoneNumber(body.data.phone) }
  return res.status(code).json(body)
}

app.post("/api/repair-order", optionalAuthenticateRequest, purchaseActionRateLimit, handleRepairOrder)
app.post("/api/retry-transaction/:reference", authenticateRequest, purchaseActionRateLimit, handleRepairOrder)

app.get("/api/receipt/:reference", optionalAuthenticateRequest, paymentVerificationRateLimit, async (req, res) => {
  const reference = String(req.params.reference || "").trim()
  if (!isValidRepairReference(reference)) return res.status(400).json({ status: "error", message: "Invalid reference" })
  const located = await findOrderLocationByReference(reference, { includeOrder: true }).catch(() => null)
  const order = located?.order
  if (!order || (order.isGuest !== true && located.userId !== req.authUser?.uid)) {
    return res.status(404).json({ status: "error", message: "Receipt not found" })
  }
  const data = toPublicOrderRecord(order)
  // A guest receipt link can be forwarded; confirm the recipient without
  // handing the full number to whoever holds the link.
  if (order.isGuest === true) data.phone = maskPhoneNumber(data.phone)
  res.set("Cache-Control", "no-store")
  return res.json({ status: "success", data })
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
}
