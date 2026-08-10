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
  isIndeterminateProviderSubmissionError,
  getIndeterminateProviderSubmissionMessage,
} from "./lib/provider-failure.js"
import {
  fetchWithRetry,
  paystackCircuitBreaker,
  hubnetCircuitBreaker,
  godswayCircuitBreaker,
  gigshubCircuitBreaker,
  pbmhubCircuitBreaker,
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
  checkPbmhubBalance,
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
  extractPbmhubOrderReference,
  isPbmhubDuplicateReplay,
  isPbmhubOrderNotFound,
  classifyPbmhubFailure,
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
      // Godsway accepts and stores our own tracking reference. Sending it is
      // what makes the integration idempotent and reconcilable: a retry carries
      // the same reference instead of creating a second delivery, and
      // GET /order-status?reference=<ours> resolves even when the purchase
      // response never gave us a provider order number.
      reference: String(payload.reference || "").trim(),
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

/**
 * Submit one order to PBM HUB.
 *
 * Two things make this different from the other providers:
 *
 * 1. Idempotency is server-side and keyed on a header. Our own reference is
 *    already unique per order, so it doubles as X-Idempotency-Key: any replay
 *    returns the original outcome flagged "Duplicate request - no new charge"
 *    rather than charging the wallet twice.
 * 2. A network timeout comes back as 202 with the debit HELD, not reversed -
 *    the order may already be live upstream. That is the one 2xx we must never
 *    read as "nothing happened". When the body still carries their reference we
 *    accept the order and let the reconciler poll it to a terminal state; when
 *    it does not, we raise an indeterminate error so the caller keeps the debit
 *    and parks the order for review instead of refunding a bundle that may land.
 */
async function processPbmhubTransaction(payload) {
  const network = String(payload.network || "").trim().toLowerCase()
  const size = String(payload.size || "").trim()
  const recipient = sanitizePhoneNumber(payload.recipient)
  const reference = String(payload.reference || "").trim()
  // Defaults to our reference, which is unique per order and is what makes an
  // ordinary retry of the SAME attempt free. A caller that has established the
  // original dispatch is dead overrides it: replaying the original key would
  // return PBM HUB's stored outcome, and for a failed order that outcome is the
  // failure itself, so the order would never be re-placed.
  const idempotencyKey = String(payload.providerIdempotencyKey || "").trim() || reference
  // Size alone is not unique across networks ("1GB" exists on all three), so the
  // network is part of the key - otherwise an MTN and a Telecel 1GB to the same
  // recipient would look like a repeat of each other.
  const duplicateKey = `${recipient}_${network}_${size}_pbmhub`

  if (processedTransactions.has(reference)) {
    const metadata = processedTransactions.get(reference)
    if (metadata && metadata.pbmhubResponse) {
      logger.info("PBM HUB transaction already processed", { reference })
      return metadata.pbmhubResponse
    }
    return {
      success: true,
      message: "Already processed",
      data: {
        // Deliberately omitted when we never learned PBM HUB's reference: ours
        // is not a valid lookup upstream, so echoing it here would store an
        // order number that 404s on every poll instead of one that is simply
        // absent, which the status adapter already handles by parking the order.
        ...(metadata?.providerReference ? { reference: metadata.providerReference } : {}),
        status: "PROCESSING",
      },
    }
  }

  const duplicateCheck = checkDuplicateAttempts(duplicateKey, "phone_transaction")
  if (duplicateCheck.isSuspicious) {
    logger.error("Suspicious duplicate attempts detected for PBM HUB", {
      reference,
      phone: recipient,
      network,
      size,
      attempts: duplicateCheck.count,
    })
    throw new Error("SUSPICIOUS_ACTIVITY_DETECTED")
  }

  const phoneLockAcquired = acquirePhoneTransactionLock(recipient, `${size}_pbmhub`, network)
  if (!phoneLockAcquired) {
    logger.warn("PBM HUB phone transaction lock conflict", { reference, phone: recipient, network, size })
    recordDuplicateAttempt(duplicateKey, "phone_transaction")
    throw new Error("DUPLICATE_TRANSACTION_ATTEMPT")
  }

  try {
    const baseUrl = String(CONFIG.pbmhubBaseUrl || "").replace(/\/$/, "")
    const apiUrl = `${baseUrl}/api/v1/purchase`
    const requestBody = {
      network,
      size,
      beneficiary_phone: recipient,
      idempotency_key: idempotencyKey,
    }

    // The key is logged because a mis-named context field would silently fall
    // back to the reference and make every retry a replay - the failure mode is
    // invisible otherwise, since nothing throws.
    logger.info("Processing PBM HUB transaction", {
      reference,
      apiUrl,
      network,
      size,
      recipient,
      idempotencyKey,
      freshKey: idempotencyKey !== reference,
    })

    let data
    let statusCode = 0
    try {
      const result = await fetchWithRetry(
        apiUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CONFIG.pbmhubApiKey}`,
            "X-Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(requestBody),
        },
        {
          circuitBreaker: pbmhubCircuitBreaker,
          timeout: 15000,
          maxRetries: CONFIG.providerSubmissionMaxRetries,
          includeResponseMeta: true,
        },
      )
      data = result.data
      statusCode = result.statusCode
    } catch (error) {
      const failure = classifyPbmhubFailure(error?.responseData, error?.message, error?.statusCode)
      logger.error("PBM HUB request failed", error, {
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

    const providerReference = extractPbmhubOrderReference(data)

    if (statusCode === 202) {
      if (!providerReference) {
        logger.error("PBM HUB held a debit without returning a reference", new Error("PBMHUB_SUBMISSION_PENDING"), {
          reference,
          response: data,
        })
        throw createAppError("PBMHUB_SUBMISSION_PENDING", {
          providerMessage:
            "PBM HUB timed out and held the debit without returning an order reference. Do not retry; this order is pending review.",
          providerResponse: data,
          statusCode,
        })
      }

      logger.warn("PBM HUB accepted the order on a held debit (202)", {
        reference,
        pbmhubReference: providerReference,
      })
    } else if (!data?.success) {
      const failure = classifyPbmhubFailure(data, data?.message, statusCode)
      logger.error("PBM HUB transaction failed", new Error(failure.message), {
        reference,
        code: failure.code,
        response: data,
      })
      throw createAppError(failure.code, {
        providerMessage: failure.message,
        providerResponse: data,
        statusCode,
      })
    }

    if (!providerReference) {
      // Their contract says /purchase always returns one, and without it the
      // order can never be polled. Keep the order (the wallet was charged) but
      // make the reason it will stall obvious in the logs.
      logger.error("PBM HUB returned no order reference", new Error("PBMHUB_REFERENCE_MISSING"), {
        reference,
        response: data,
      })
    }

    processedTransactions.add(reference, {
      provider: "pbmhub",
      phone: recipient,
      network,
      size,
      providerReference: providerReference || null,
      pbmhubResponse: data,
      processedAt: new Date().toISOString(),
    })

    logger.info("PBM HUB transaction successful", {
      reference,
      pbmhubReference: providerReference || null,
      status: data?.data?.status || null,
      duplicateReplay: isPbmhubDuplicateReplay(data),
    })

    return data
  } finally {
    releasePhoneTransactionLock(recipient, `${size}_pbmhub`, network)
  }
}

async function getPbmhubOrderStatus(pbmhubReference) {
  const providerRef = String(pbmhubReference || "").trim()
  if (!providerRef) {
    throw createAppError("PBMHUB_REFERENCE_MISSING", {
      providerMessage: "PBM HUB status check requires the provider order reference.",
    })
  }

  const baseUrl = String(CONFIG.pbmhubBaseUrl || "").replace(/\/$/, "")
  const apiUrl = `${baseUrl}/api/v1/orders/${encodeURIComponent(providerRef)}`

  let data
  try {
    data = await fetchWithRetry(
      apiUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${CONFIG.pbmhubApiKey}`,
          "Content-Type": "application/json",
        },
      },
      {
        circuitBreaker: pbmhubCircuitBreaker,
        timeout: 12000,
        maxRetries: 1,
      },
    )
  } catch (error) {
    if (isPbmhubOrderNotFound(error)) {
      // PBM HUB has not indexed the reference yet. Skipping keeps the order open
      // for the next sweep; treating it as a failure would wrongly mark a live
      // order failed and trigger a refund.
      return {
        supported: false,
        skippedReason: "PBM HUB has no record of this reference yet",
      }
    }

    const failure = classifyPbmhubFailure(error?.responseData, error?.message, error?.statusCode)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: error?.responseData || null,
      statusCode: error?.statusCode || null,
    })
  }

  if (!data?.success) {
    if (isPbmhubOrderNotFound({ responseData: data })) {
      return {
        supported: false,
        skippedReason: "PBM HUB has no record of this reference yet",
      }
    }

    const failure = classifyPbmhubFailure(data, data?.message)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: data,
    })
  }

  const statusDetails = getPbmhubStatusDetails(data)
  return {
    supported: true,
    provider: "pbmhub",
    providerReference: providerRef,
    providerOrderNumber: providerRef,
    providerStatusRaw: statusDetails.providerStatusRaw,
    providerStatusDescription: statusDetails.providerStatusDescription,
    status: statusDetails.normalizedStatus,
    providerMeta: sanitizeProviderMeta("pbmhub", data),
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

  if (provider === "pbmhub") {
    const statusDetails = getPbmhubStatusDetails(response)
    // Their reference, not ours - it is the only identifier /orders/:reference
    // resolves, so storing anything else here makes the order unpollable.
    const providerOrderNumber = extractPbmhubOrderReference(response) || null
    return {
      provider,
      providerReference: providerOrderNumber || reference,
      providerOrderNumber,
      providerStatusRaw: statusDetails.providerStatusRaw || "PROCESSING",
      providerStatusDescription: statusDetails.providerStatusDescription || "Order accepted by PBM HUB",
      providerMeta: sanitizeProviderMeta(provider, response),
      providerResponse: response,
      // Trust the status PBM HUB reported at submit time (PROCESSING on a fresh
      // order, but a duplicate replay can come back already DELIVERED).
      status: statusDetails.normalizedStatus || "accepted",
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

async function getGodswayOrderStatus(reference, { appReference = "" } = {}) {
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
  // Sanitize against our own reference: now that we submit it, Godsway echoes
  // it back, and storing it as the "provider order number" would be a lie that
  // makes later lookups look more authoritative than they are.
  const resolvedProviderOrderNumber = resolveStoredProviderOrderNumber(
    "godsway",
    statusOrderNumber || providerOrderNumber,
    appReference,
  )
  return {
    supported: true,
    provider: "godsway",
    providerReference: resolveStoredProviderReference(
      "godsway",
      statusOrderNumber || "",
      appReference,
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

/**
 * Spacing gate for Hubnet's documented 5 requests/minute-per-endpoint limit.
 *
 * Only the status endpoint goes through here; purchases have their own bucket
 * and must not be delayed behind a poll. Reconciliation holds a distributed
 * lease, so a single in-process timestamp is enough to pace the whole fleet.
 */
let lastHubnetStatusPollAt = 0

function getHubnetStatusPollWaitMs(now = Date.now()) {
  const minInterval = Math.max(0, Number(CONFIG.hubnetStatusPollMinIntervalMs || 0))
  if (!minInterval || !lastHubnetStatusPollAt) {
    return 0
  }

  return Math.max(0, lastHubnetStatusPollAt + minInterval - now)
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
  if (!reference) {
    return {
      supported: false,
      skippedReason: "Hubnet status lookup requires the order reference",
    }
  }

  const apiUrl = baseStatusUrl.includes("{reference}")
    ? baseStatusUrl.replace("{reference}", encodeURIComponent(reference))
    : `${baseStatusUrl}${baseStatusUrl.includes("?") ? "&" : "?"}reference=${encodeURIComponent(reference)}`

  const waitMs = getHubnetStatusPollWaitMs()
  if (waitMs > 0) {
    await sleep(waitMs)
  }
  lastHubnetStatusPollAt = Date.now()

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
    if (isHubnetTransactionNotFoundResponse(error?.responseData)) {
      // Hubnet has not registered the reference yet. Skipping keeps the order
      // open for the next sweep; treating it as a failure would wrongly mark a
      // live order failed and trigger a refund.
      return {
        supported: false,
        skippedReason: "Hubnet has no record of this reference yet",
      }
    }

    const failure = classifyHubnetFailure(error?.responseData, error?.message)
    throw createAppError(failure.code, {
      providerMessage: failure.message,
      providerResponse: error?.responseData || null,
      statusCode: error?.statusCode || null,
    })
  }

  if (isHubnetTransactionNotFoundResponse(data)) {
    return {
      supported: false,
      skippedReason: "Hubnet has no record of this reference yet",
    }
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
      const rawProviderOrderNumber = String(order.providerOrderNumber || order.orderNumber || "").trim()
      const providerOrderNumber = resolveStoredProviderOrderNumber("godsway", rawProviderOrderNumber, order.reference)
      const appReference = String(order.reference || "").trim()

      // Prefer Godsway's own order number, but fall back to our reference: we
      // now submit it on every purchase, so /order-status resolves it. Older
      // orders placed before that change have neither and stay unpollable.
      const lookupReference = providerOrderNumber || appReference
      if (!lookupReference) {
        return {
          supported: false,
          skippedReason: "No Godsway order number or app reference available - cannot query status",
        }
      }

      return await getGodswayOrderStatus(lookupReference, { appReference })
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
  pbmhub: {
    async purchase({ network, phone, reference, catalogEntry, providerIdempotencyKey }) {
      assertProviderConfigured("pbmhub", "purchase")
      const mapping = getPackageProviderMapping(network, "pbmhub", catalogEntry)
      const response = await processPbmhubTransaction({
        network: mapping.network,
        size: mapping.size,
        recipient: phone,
        reference,
        providerIdempotencyKey,
      })
      return createProviderPurchaseMetadata("pbmhub", response, reference, network)
    },
    async getOrderStatus(order) {
      assertProviderConfigured("pbmhub", "status")
      const providerOrderNumber = String(order.providerOrderNumber || "").trim()
      if (!providerOrderNumber) {
        // Unlike CK-Godsway there is no fallback to our own reference: PBM HUB
        // only resolves references it issued, so ours would 404 on every poll.
        return {
          supported: false,
          skippedReason: "PBM HUB order reference not available - cannot query status",
        }
      }
      return await getPbmhubOrderStatus(providerOrderNumber)
    },
    async health() {
      let balance = null
      let balanceError = ""

      try {
        assertProviderConfigured("pbmhub", "health")
      } catch (error) {
        return {
          provider: "pbmhub",
          supportsBalanceCheck: true,
          breaker: pbmhubCircuitBreaker.getState(),
          balance: null,
          balanceError: error?.providerMessage || error?.message || "PBM HUB is not configured",
        }
      }

      try {
        balance = await checkPbmhubBalance()
      } catch (error) {
        balanceError = error?.providerMessage || error?.message || "Failed to load PBM HUB balance"
      }

      return {
        provider: "pbmhub",
        supportsBalanceCheck: true,
        breaker: pbmhubCircuitBreaker.getState(),
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
  const [routing, sync, syncStateSnapshot, hubnetHealth, godswayHealth, gigshubHealth, pbmhubHealth] =
    await Promise.all([
      getProviderRoutingConfig(),
      getOrderSyncHealthSummary(),
      db.ref(ORDER_SYNC_STATE_PATH).once("value"),
      providerAdapters.hubnet.health(),
      providerAdapters.godsway.health(),
      providerAdapters.gigshub.health(),
      providerAdapters.pbmhub.health(),
    ])

  return {
    routing,
    sync,
    syncState: syncStateSnapshot.exists() ? syncStateSnapshot.val() || {} : {},
    providers: {
      hubnet: hubnetHealth,
      godsway: godswayHealth,
      gigshub: gigshubHealth,
      pbmhub: pbmhubHealth,
    },
    timestamp: new Date().toISOString(),
  }
}

function getProviderErrorHttpStatus(errorCode) {
  if (errorCode === "DUPLICATE_TRANSACTION_ATTEMPT" || errorCode === "WALLET_TRANSACTION_ABORTED") {
    return 409
  }

  if (
    errorCode === "HUBNET_RATE_LIMITED" ||
    errorCode === "GODSWAY_RATE_LIMITED" ||
    errorCode === "GIGSHUB_RATE_LIMITED" ||
    errorCode === "PBMHUB_RATE_LIMITED" ||
    errorCode === "PBMHUB_DUPLICATE_WINDOW"
  ) {
    return 429
  }

  if (
    errorCode === "HUBNET_AUTH_FAILED" ||
    errorCode === "GODSWAY_AUTH_FAILED" ||
    errorCode === "GIGSHUB_AUTH_FAILED" ||
    errorCode === "PBMHUB_AUTH_FAILED"
  ) {
    return 502
  }

  if (
    errorCode === "INSUFFICIENT_HUBNET_BALANCE" ||
    errorCode === "INSUFFICIENT_GODSWAY_BALANCE" ||
    errorCode === "INSUFFICIENT_GIGSHUB_BALANCE" ||
    errorCode === "INSUFFICIENT_PBMHUB_BALANCE" ||
    errorCode === "PBMHUB_WALLET_FROZEN" ||
    errorCode === "PBMHUB_NETWORK_UNAVAILABLE" ||
    errorCode === "PBMHUB_PURCHASE_FAILED" ||
    // Only reachable if a caller treats an indeterminate submission as a plain
    // error. Callers that know about it answer 202 and keep the debit; see
    // isIndeterminateProviderSubmissionError.
    errorCode === "PBMHUB_SUBMISSION_PENDING"
  ) {
    return 503
  }

  if (errorCode === "PACKAGE_PROVIDER_MAPPING_MISSING") {
    return 400
  }

  if (errorCode === "PROVIDER_CONFIGURATION_MISSING") {
    return 500
  }

  if (
    errorCode === "GODSWAY_REFERENCE_MISSING" ||
    errorCode === "GIGSHUB_REFERENCE_MISSING" ||
    errorCode === "PBMHUB_REFERENCE_MISSING"
  ) {
    return 400
  }

  if (errorCode === "GIGSHUB_INVALID_PACKAGE" || errorCode === "PBMHUB_INVALID_PACKAGE") {
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

  if (errorCode === "PBMHUB_AUTH_FAILED") {
    return "PBM HUB API authentication failed. Update PBMHUB_API_KEY."
  }

  if (errorCode === "PBMHUB_RATE_LIMITED") {
    return "PBM HUB API rate limit reached. Please try again shortly."
  }

  if (errorCode === "PBMHUB_DUPLICATE_WINDOW") {
    return "PBM HUB rejected a repeat purchase for this recipient. Please wait before retrying."
  }

  if (errorCode === "PBMHUB_NETWORK_UNAVAILABLE") {
    return "PBM HUB has temporarily disabled this network. Try again later or reroute the network."
  }

  if (errorCode === "PBMHUB_WALLET_FROZEN") {
    return "PBM HUB has frozen the account wallet. Contact PBM HUB support."
  }

  if (errorCode === "PBMHUB_PURCHASE_FAILED") {
    return "PBM HUB's upstream provider failed. Please try again shortly."
  }

  if (errorCode === "PBMHUB_INVALID_PACKAGE") {
    return "PBM HUB rejected the network or size. Check the package mapping."
  }

  if (
    errorCode === "INSUFFICIENT_HUBNET_BALANCE" ||
    errorCode === "INSUFFICIENT_GODSWAY_BALANCE" ||
    errorCode === "INSUFFICIENT_GIGSHUB_BALANCE" ||
    errorCode === "INSUFFICIENT_PBMHUB_BALANCE"
  ) {
    return "Service provider has insufficient balance"
  }

  if (errorCode === "PACKAGE_PROVIDER_MAPPING_MISSING") {
    return "Selected package is not configured for the active provider route."
  }

  if (
    errorCode === "GODSWAY_REFERENCE_MISSING" ||
    errorCode === "GIGSHUB_REFERENCE_MISSING" ||
    errorCode === "PBMHUB_REFERENCE_MISSING"
  ) {
    return "Provider status check requires the provider order reference."
  }

  if (errorCode === "GIGSHUB_INVALID_PACKAGE") {
    return "GiGSHUB rejected the selected package. Check the package ID configuration."
  }

  return fallback
}

// isIndeterminateProviderSubmissionError / getIndeterminateProviderSubmissionMessage
// now live in ./lib/provider-failure.js (imported at the top) and are
// re-exported below.

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
  // Hubnet caps the status endpoint at 5 requests/minute; picking more than a
  // handful per sweep just burns the budget on 1007 rate-limit errors and
  // starves the rest of the queue. Other providers are unconstrained.
  const hubnetBudget = Math.max(1, Number(CONFIG.hubnetStatusPollMaxPerRun || 4))
  let hubnetSelected = 0
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

    // The index carries the provider, so an over-budget Hubnet order can be
    // skipped before paying for a read of the order node.
    if (normalizeProvider(item.provider) === "hubnet" && hubnetSelected >= hubnetBudget) {
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

    const provider = normalizeProvider(order.provider, DEFAULT_PROVIDER_ROUTING[order.network] || "hubnet")
    if (provider === "hubnet") {
      if (hubnetSelected >= hubnetBudget) {
        continue
      }
      hubnetSelected += 1
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
    // The monotonic guard may have kept the stored status (e.g. a webhook
    // already delivered this order while the poll was in flight). Report and
    // propagate what is actually stored, never what we asked for.
    const appliedStatus = normalizeInternalOrderStatus(updateResult.order?.status, nextStatus)

    if (updateResult.statusRejected && isTerminalOrderStatus(appliedStatus)) {
      // Stop re-polling an order the guard has settled as terminal.
      await updateOrderByReference(order.reference, {
        sync: { nextAttemptAt: null, skippedReason: "" },
      }).catch(() => null)
    }

    await syncPurchaseIntentFromOrder(order.reference, updateResult.order || {
      ...order,
      provider,
      providerReference: nextProviderReference,
      providerOrderNumber: nextProviderOrderNumber,
      providerStatusRaw: result?.providerStatusRaw || order.providerStatusRaw || "",
      providerStatusDescription: result?.providerStatusDescription || order.providerStatusDescription || "",
      status: appliedStatus,
    }).catch(() => null)

    return { synced: true, status: appliedStatus, provider }
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
  processPbmhubTransaction,
  getPbmhubOrderStatus,
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
