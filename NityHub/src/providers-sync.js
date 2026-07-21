import crypto from "crypto"
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
  extractGodswayOrderNumber,
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
  updateOrderByReference,
  syncPurchaseIntentFromOrder,
  mergeOrderPayloadWithPurchaseIntent,
  bulkUpdateOrdersStatus,
  normalizeExistingOrdersAndIndexes,
  backfillPurchaseIntentsFromOrders,
  firstNonEmptyText,
  uniqueTextValues,
  getWebhookLookupContext,
} from "./domain.js"

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

    const godswayOrderNumber = extractGodswayOrderNumber(data)

    processedTransactions.add(payload.reference, {
      provider: "godsway",
      network: payload.network || null,
      networkKey,
      phone: recipient,
      volume: capacity,
      providerReference: resolveStoredProviderReference("godsway", godswayOrderNumber, payload.reference),
      providerOrderNumber: resolveStoredProviderOrderNumber("godsway", godswayOrderNumber, payload.reference),
      godswayResponse: data,
      telecelResponse: data,
      processedAt: new Date().toISOString(),
    })

    logger.info("Godsway transaction successful", {
      reference: payload.reference,
      orderNumber: godswayOrderNumber || null,
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
    const godswayOrderNumber = extractGodswayOrderNumber(response)
    const providerOrderNumber = resolveStoredProviderOrderNumber("godsway", godswayOrderNumber, reference)
    const providerReference = resolveStoredProviderReference("godsway", godswayOrderNumber, reference, providerOrderNumber || "")
    return {
      provider,
      providerReference,
      providerOrderNumber,
      providerStatusRaw: statusDetails.providerStatusRaw || "INITIATED",
      providerStatusDescription: statusDetails.providerStatusDescription || "Order accepted by provider",
      providerMeta: sanitizeProviderMeta(provider, response),
      providerResponse: response,
      // Trust the status Godsway reported at submit time. Hardcoding "accepted"
      // left orders that came back SUCCESSFUL waiting on a poll to advance them.
      status: statusDetails.normalizedStatus || "accepted",
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
  const statusOrderNumber = extractGodswayOrderNumber(data)
  const resolvedProviderOrderNumber = resolveStoredProviderOrderNumber(
    "godsway",
    statusOrderNumber || providerOrderNumber,
    "",
  )
  return {
    supported: true,
    provider: "godsway",
    providerReference: resolveStoredProviderReference(
      "godsway",
      statusOrderNumber || "",
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

export {
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
}
