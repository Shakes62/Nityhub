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
  toMoneyNumber,
  toMoneyUnits,
  fromMoneyUnits,
  hashStableKey,
  sanitizeMutationId,
  trimWalletMutationHistory,
} from "./lib/money.js"
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

// Money math now lives in ./lib/money.js — see the import at the top of this
// module. It is re-exported below so existing call sites keep working.

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

export {
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
}
