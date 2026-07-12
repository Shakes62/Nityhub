import dotenv from "dotenv"
import crypto from "crypto"

dotenv.config()

export function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "")
}

const DEFAULT_LOCAL_APP_URL = `http://localhost:${process.env.PORT || 3000}`
const DEFAULT_PUBLIC_APP_URL = "https://nityhub.onrender.com"
const DEFAULT_PUBLIC_FRONTEND_URL = "https://buy.nityhub.online"
export const APP_URL =
  normalizeUrl(process.env.APP_URL || process.env.PUBLIC_APP_URL) ||
  (process.env.NODE_ENV === "production" ? DEFAULT_PUBLIC_APP_URL : DEFAULT_LOCAL_APP_URL)
const FRONTEND_URL =
  normalizeUrl(process.env.FRONTEND_URL || process.env.PUBLIC_FRONTEND_URL) ||
  (process.env.NODE_ENV === "production" ? DEFAULT_PUBLIC_FRONTEND_URL : APP_URL)
const parseCsvUrls = (value) =>
  String(value || "")
    .split(",")
    .map((item) => normalizeUrl(item))
    .filter(Boolean)

export const CONFIG = {
  port: process.env.PORT || 3000,
  frontendUrl: FRONTEND_URL,
  baseUrl: normalizeUrl(process.env.BASE_URL) || APP_URL,
  hubnetApiKey: process.env.HUBNET_API_KEY,
  hubnetWebhookUrl: process.env.HUBNET_WEBHOOK_URL || "",
  hubnetStatusUrl: process.env.HUBNET_STATUS_URL || process.env.HUBNET_ORDER_STATUS_URL || "",
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
  godswayApiKey: process.env.GODSWAY_API_KEY || process.env.TELECEL_API_KEY,
  godswayBaseUrl: process.env.GODSWAY_BASE_URL || "https://console.ckgodsway.com/api",
  godswayStatusUrl: process.env.GODSWAY_STATUS_URL || "",
  gigshubApiKey: process.env.GIGSHUB_API_KEY,
  gigshubBaseUrl: process.env.GIGSHUB_BASE_URL || "https://gigshub.store/api/v1",
  providerWebhookSecret: process.env.PROVIDER_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "",
  providerWebhookAllowedIps: String(process.env.PROVIDER_WEBHOOK_ALLOWED_IPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  additionalAllowedOrigins: parseCsvUrls(process.env.ADDITIONAL_ALLOWED_ORIGINS || process.env.CORS_ALLOWED_ORIGINS),
  nodeEnv: process.env.NODE_ENV || "development",

  maxRetries: 1,
  baseDelay: 200,
  maxDelay: 3000,
  requestTimeout: 8000,
  keepAliveTimeout: 65000,
  headersTimeout: 66000,

  rateLimitWindow: 3 * 60 * 1000,
  rateLimitMax: 500,

  maxMemoryUsage: 512 * 1024 * 1024,
  cacheCleanupInterval: 60 * 1000,

  maxSockets: 200,
  maxFreeSockets: 50,

  orderSyncIntervalMs: Number(process.env.ORDER_SYNC_INTERVAL_MS || 45000),
  orderSyncLeaseMs: Number(process.env.ORDER_SYNC_LEASE_MS || 120000),
  orderSyncMaxPerRun: Number(process.env.ORDER_SYNC_MAX_PER_RUN || 15),
  orderSyncRetryDelayMs: Number(process.env.ORDER_SYNC_RETRY_DELAY_MS || 45000),
  orderSyncMaxAttempts: Number(process.env.ORDER_SYNC_MAX_ATTEMPTS || 25),
  orderSyncLeaseRetryCount: Number(process.env.ORDER_SYNC_LEASE_RETRY_COUNT || 3),
  orderSyncLeaseRetryBaseMs: Number(process.env.ORDER_SYNC_LEASE_RETRY_BASE_MS || 500),
  purchaseIntentMaxAgeMs: Number(process.env.PURCHASE_INTENT_MAX_AGE_MS || 24 * 60 * 60 * 1000),
  idempotencyWindowMs: Number(process.env.IDEMPOTENCY_WINDOW_MS || 60 * 1000),
  providerSubmissionMaxRetries: Number(process.env.PROVIDER_SUBMISSION_MAX_RETRIES || 0),
  walletMutationHistoryLimit: Number(process.env.WALLET_MUTATION_HISTORY_LIMIT || 120),
}

export const SUPPORTED_PACKAGE_NETWORKS = ["mtn", "at", "telecel"]
export const SUPPORTED_PROVIDERS = ["hubnet", "godsway", "gigshub"]
export const DEFAULT_PROVIDER_ROUTING = {
  mtn: "hubnet",
  at: "hubnet",
  telecel: "godsway",
}
export const TERMINAL_ORDER_STATUSES = new Set(["delivered", "failed", "cancelled"])
export const ORDER_SYNC_LEASE_PATH = "system_leases/order_status_reconciler"
export const ORDER_SYNC_STATE_PATH = "system_sync/order_status"
export const INSTANCE_ID = crypto.randomBytes(4).toString("hex")
export const DEFAULT_AFA_REGISTRATION_FEE = 6
export const PURCHASE_INTENT_PATH = "purchase_intents"
export const DEFAULT_PACKAGE_CATALOG = {
  mtn: [
    { id: "mtn-1gb", label: "1GB", volume: 1000, userPrice: 6.5, agentPrice: 6.2 },
    { id: "mtn-2gb", label: "2GB", volume: 2000, userPrice: 12.8, agentPrice: 12.3 },
    { id: "mtn-3gb", label: "3GB", volume: 3000, userPrice: 18.8, agentPrice: 18.2 },
    { id: "mtn-5gb", label: "5GB", volume: 5000, userPrice: 30, agentPrice: 29 },
    { id: "mtn-10gb", label: "10GB", volume: 10000, userPrice: 45, agentPrice: 44 },
    { id: "mtn-15gb", label: "15GB", volume: 15000, userPrice: 65, agentPrice: 63 },
    { id: "mtn-20gb", label: "20GB", volume: 20000, userPrice: 85, agentPrice: 83 },
    { id: "mtn-25gb", label: "25GB", volume: 25000, userPrice: 110, agentPrice: 106 },
    { id: "mtn-30gb", label: "30GB", volume: 30000, userPrice: 129, agentPrice: 123 },
    { id: "mtn-40gb", label: "40GB", volume: 40000, userPrice: 167, agentPrice: 164 },
    { id: "mtn-50gb", label: "50GB", volume: 50000, userPrice: 210, agentPrice: 205 },
    { id: "mtn-100gb", label: "100GB", volume: 100000, userPrice: 405, agentPrice: 400 },
  ],
  at: [
    { id: "at-1gb", label: "1GB", volume: 1000, userPrice: 6.5, agentPrice: 6.2 },
    { id: "at-2gb", label: "2GB", volume: 2000, userPrice: 13, agentPrice: 12.4 },
    { id: "at-3gb", label: "3GB", volume: 3000, userPrice: 19.5, agentPrice: 18.9 },
    { id: "at-5gb", label: "5GB", volume: 5000, userPrice: 32, agentPrice: 30 },
    { id: "at-10gb", label: "10GB", volume: 10000, userPrice: 48, agentPrice: 45 },
    { id: "at-15gb", label: "15GB", volume: 15000, userPrice: 70, agentPrice: 67 },
    { id: "at-20gb", label: "20GB", volume: 20000, userPrice: 95, agentPrice: 90 },
    { id: "at-25gb", label: "25GB", volume: 25000, userPrice: 120, agentPrice: 112 },
    { id: "at-30gb", label: "30GB", volume: 30000, userPrice: 130, agentPrice: 120 },
    { id: "at-40gb", label: "40GB", volume: 40000, userPrice: 180, agentPrice: 168 },
    { id: "at-50gb", label: "50GB", volume: 50000, userPrice: 230, agentPrice: 215 },
    { id: "at-100gb", label: "100GB", volume: 100000, userPrice: 390, agentPrice: 380 },
  ],
  telecel: [
    { id: "telecel-5gb", label: "5GB", volume: 5000, userPrice: 24, agentPrice: 24 },
    { id: "telecel-10gb", label: "10GB", volume: 10000, userPrice: 45, agentPrice: 45 },
    { id: "telecel-15gb", label: "15GB", volume: 15000, userPrice: 67, agentPrice: 67 },
    { id: "telecel-20gb", label: "20GB", volume: 20000, userPrice: 89, agentPrice: 89 },
    { id: "telecel-25gb", label: "25GB", volume: 25000, userPrice: 113, agentPrice: 113 },
    { id: "telecel-30gb", label: "30GB", volume: 30000, userPrice: 133, agentPrice: 133 },
    { id: "telecel-35gb", label: "35GB", volume: 35000, userPrice: 153, agentPrice: 153 },
    { id: "telecel-40gb", label: "40GB", volume: 40000, userPrice: 178, agentPrice: 178 },
    { id: "telecel-50gb", label: "50GB", volume: 50000, userPrice: 225, agentPrice: 225 },
  ],
}

if (!CONFIG.paystackSecretKey) {
  console.error("Missing required environment variable: PAYSTACK_SECRET_KEY")
  process.exit(1)
}
