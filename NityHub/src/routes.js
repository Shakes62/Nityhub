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
} from "./lib/http.js"
import { generateReference } from "./lib/reference.js"
import { enqueueRefund } from "./refund-queue.js"
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
import { purchaseActionRateLimit, paymentVerificationRateLimit, adminMutationRateLimit } from "./middleware.js"
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
  getAfaRegistrationFee,
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
  authenticateRequest,
  requirePrivilegedAccess,
  sanitizePhoneNumber,
  buildFrontendUrl,
  updateWalletBalance,
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
  getProviderErrorMessage,
  isIndeterminateProviderSubmissionError,
  getIndeterminateProviderSubmissionMessage,
  reconciliationInFlight,
  getOrderSyncBackoffDelay,
  acquireOrderSyncLease,
  releaseOrderSyncLease,
  getOpenOrderLocationsForSync,
  reconcileSingleOrderStatus,
  runOrderStatusReconciliation,
} from "./providers-sync.js"

export function registerRoutes(app) {
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
          // The user is debited and the inline refund just failed. Durably queue
          // it so the worker keeps retrying instead of the money being lost to
          // this log line. Retrying is safe: refundMutationId is the wallet
          // replay guard's key, so it can never refund twice.
          await enqueueRefund({
            userId,
            reference,
            amount,
            mutationId: refundMutationId,
            reason: "wallet_purchase_refund",
            details: { network, phone, packageId: catalogEntry.id },
            lastError: refundError?.message || String(refundError),
          }).catch((queueError) => {
            logger.error("Refund enqueue failed after refund error", queueError, { userId, reference })
          })
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
}
