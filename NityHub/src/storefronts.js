// Multi-tenant reseller eStores.
//
//   - A reseller claims a slug (served at <slug>.<STOREFRONT_BASE_DOMAIN>, at
//     /store/<slug>, and optionally on their own custom domain).
//   - Retail = the reseller's own wholesale price + their per-network margin.
//     The browser never supplies a price; every quote is computed here.
//   - Guests check out with just a recipient number and a receipt email.
//   - When a sale is delivered, the margin is credited to the reseller's wallet
//     exactly once, and they are notified.

import crypto from "crypto"
import { db } from "./firebase.js"
import { CONFIG } from "./config.js"
import { logger } from "./logger.js"
import { generateReference } from "./lib/reference.js"
import { sanitizeMutationId } from "./lib/money.js"
import {
  normalizeStoreSlug, isClaimableStoreSlug, normalizeStoreName, normalizeStoreTagline, normalizeCustomDomain,
  customDomainKey, storePrice, calculateStoreProfit, isValidReceiptEmail,
} from "./lib/storefront-rules.js"
import { isNetworkAvailable, getVendingControls, getProviderCosts, checkPriceFloor } from "./lib/vending-controls.js"
import {
  authenticateRequest, requirePrivilegedAccess, getUserRoleSummary, getCatalogPackage, getCatalogPackages,
  getProviderRouteForNetwork, toPublicCatalogEntry, isProviderConfigured, isCompleteProviderMapping,
  resolveEffectivePackagePrice, isPrivilegedUser, normalizePurchaseNetwork, normalizeInternalOrderStatus,
  sanitizePhoneNumber, toMoneyUnits, toMoneyNumber, upsertPurchaseIntent, updateWalletBalance, recordTransaction,
  registerOrderDeliveredHook, recordAuditEvent, initializePaystackPayment,
} from "./domain.js"
import {
  purchaseActionRateLimit, purchaseVelocityRateLimit, adminMutationRateLimit, registerOriginAllowance,
} from "./middleware.js"
import { isRecipientBlocked, isIdentityBlocked, assessRecipientVelocity } from "./security-controls.js"
import { notifyUser, notificationId } from "./notifications.js"
import { registerCacheReset } from "./lib/runtime-cache.js"

const NETWORKS = ["mtn", "telecel", "at"]
const NEUTRAL_BLOCKED = "This recipient number cannot be processed at this time."
const STORE_CACHE_MS = 30_000
const storeCache = new Map()
const customDomains = new Map()
registerCacheReset(() => storeCache.clear())

export const storefrontBaseDomain = () => String(process.env.STOREFRONT_BASE_DOMAIN || "").trim().toLowerCase().replace(/^\./, "")

/* --------------------------------- Lookup --------------------------------- */

async function readStore(slug) {
  const safe = normalizeStoreSlug(slug)
  if (!safe) return null
  const cached = storeCache.get(safe)
  if (cached && Date.now() - cached.at < STORE_CACHE_MS) return cached.value
  const snapshot = await db.ref(`storefronts/${safe}`).once("value")
  const value = snapshot.exists() ? { ...snapshot.val(), slug: safe } : null
  storeCache.set(safe, { at: Date.now(), value })
  return value
}

/** An enabled store, or null. */
export async function getStorefront(slug) {
  const store = await readStore(slug)
  return store && store.enabled !== false && store.suspended !== true ? store : null
}

/** What any buyer may see. Margins are the reseller's business, never sent. */
function publicStore(store) {
  return {
    slug: store.slug,
    name: store.name,
    tagline: store.tagline || "",
    whatsapp: store.whatsapp,
    enabled: store.enabled !== false && store.suspended !== true,
  }
}

/** The owner's own view, including margins and domain settings. */
function ownerStore(store, stats = null) {
  const base = storefrontBaseDomain()
  return {
    ...publicStore(store),
    margins: store.margins || {},
    customDomain: store.customDomain || "",
    suspended: store.suspended === true,
    paused: store.enabled === false,
    storeUrl: base ? `https://${store.slug}.${base}` : `${CONFIG.frontendUrl.replace(/\/$/, "")}/store/${store.slug}`,
    stats: {
      sales: Number(stats?.sales || 0),
      profit: toMoneyNumber(stats?.profit, 0),
      revenue: toMoneyNumber(stats?.revenue, 0),
    },
    createdAt: Number(store.createdAt || 0),
  }
}

function startCustomDomainSync() {
  db.ref("storefront_domains").on("value", (snapshot) => {
    customDomains.clear()
    for (const [key, slug] of Object.entries(snapshot.val() || {})) {
      customDomains.set(key.replace(/,/g, "."), String(slug))
    }
  }, (error) => logger.error("Custom domain sync failed", error))
}

function isCustomStorefrontOrigin(origin) {
  try {
    const url = new URL(origin)
    return url.protocol === "https:" && customDomains.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

/** Resolve a request Host to a store slug: <slug>.<base> or a custom domain. */
export function resolveStoreSlugFromHost(host) {
  const hostname = String(host || "").trim().toLowerCase().split(":")[0]
  if (!hostname) return ""
  const base = storefrontBaseDomain()
  if (base && hostname.endsWith(`.${base}`)) {
    const slug = hostname.slice(0, -base.length - 1)
    return isClaimableStoreSlug(slug) ? slug : ""
  }
  return customDomains.get(hostname) || ""
}

/* --------------------------------- Pricing -------------------------------- */

/**
 * Everything a quote needs that is the same for every package on a network,
 * loaded once per request instead of once per package.
 */
async function buildQuoteContext(store, network) {
  const controls = await getVendingControls()
  if (!isNetworkAvailable(controls, network)) return null
  const route = (await getProviderRouteForNetwork(network)).filter((provider) => isProviderConfigured(provider))
  if (!route.length) return null
  const [costs, ownerAgent] = await Promise.all([
    getProviderCosts(network),
    isPrivilegedUser(store.ownerUid).catch(() => false),
  ])
  return { controls, route, provider: route[0], costs, ownerAgent }
}

/** Retail quote for one package, or null when it must not be sold right now. */
function quoteEntry(store, network, entry, context) {
  if (!entry || entry.enabled === false || !context) return null
  const { route, provider, costs, controls, ownerAgent } = context
  // Priced on the primary provider (what the platform charges the reseller);
  // sellable if at least one routed provider can fulfil it above its floor.
  const wholesale = resolveEffectivePackagePrice(entry, { agentPricing: ownerAgent, provider })
  if (!Number.isFinite(Number(wholesale)) || Number(wholesale) <= 0) return null
  const sellable = route.some((candidate) =>
    isCompleteProviderMapping(network, candidate, entry) &&
    checkPriceFloor({
      costs, packageId: entry.id, provider: candidate, price: wholesale,
      minimumMargin: controls.minimumMargin, requireCost: controls.requireProviderCosts,
    }).allowed)
  if (!sellable) return null
  const retail = storePrice(wholesale, store.margins?.[network] ?? 0)
  if (!retail || retail > 10000) return null
  return { entry, wholesale: toMoneyNumber(wholesale, 0), retail, provider }
}

/* ------------------------------ Profit credit ----------------------------- */

/**
 * Credit a delivered sale's margin to the reseller, exactly once.
 *
 * Every delivery path calls this (and it is also an order-delivered hook), so
 * it has to be idempotent on its own: a sale record claim stops concurrent
 * runs, the durable mutation log stops a retry after a crash, and `creditedAt`
 * makes every later call a no-op.
 */
export async function settleStorefrontProfit(order) {
  if (!order?.storefrontSlug || normalizeInternalOrderStatus(order.status, "") !== "delivered" || order.refunded === true) return false
  const slug = normalizeStoreSlug(order.storefrontSlug)
  const reference = String(order.reference || "").trim()
  if (!slug || !reference) return false
  const store = (await db.ref(`storefronts/${slug}`).once("value")).val()
  if (!store || store.ownerUid !== order.storefrontOwnerUid) return false
  const profit = calculateStoreProfit(order.amount, order.storefrontWholesale)
  if (!profit) return false

  const saleRef = db.ref(`storefront_sales/${slug}/${reference}`)
  const claimToken = crypto.randomUUID()
  const claim = await saleRef.transaction((current) => {
    const value = current || {}
    if (value.creditedAt) return
    if (value.creditClaim && Date.now() - Number(value.creditClaim.at || 0) < 60_000) return
    return { ...value, reference, creditClaim: { token: claimToken, at: Date.now() } }
  })
  if (!claim.committed) return false

  try {
    const mutationId = sanitizeMutationId(`store-profit:${reference}`)
    const prior = (await db.ref(`wallet_mutations/${store.ownerUid}/${mutationId}`).once("value")).val()
    const balance = prior
      ? toMoneyNumber(prior.balance, 0)
      : await updateWalletBalance(store.ownerUid, profit, {
        mutationId, reason: "storefront_profit", reference,
        details: { storefront: slug, wholesale: order.storefrontWholesale, retail: order.amount },
      })
    await recordTransaction({
      userId: store.ownerUid, type: "storefront_profit", amount: profit, balance,
      reference, mutationId: `store-profit-ledger:${reference}`, details: { storefront: slug, description: "eStore sale profit" },
    })
    await saleRef.update({ status: "delivered", profit, creditedAt: Date.now(), creditClaim: null })
    if (!prior) {
      await db.ref(`storefront_stats/${slug}`).transaction((current) => ({
        sales: Number(current?.sales || 0) + 1,
        profit: Math.round((Number(current?.profit || 0) + profit) * 100) / 100,
        revenue: Math.round((Number(current?.revenue || 0) + Number(order.amount || 0)) * 100) / 100,
      }))
    }
    await notifyUser(store.ownerUid, {
      id: notificationId("store_sale", reference),
      type: "storefront_profit",
      title: "New eStore sale",
      message: `Sale on ${store.name}! GHS ${profit.toFixed(2)} profit credited to your wallet.`,
      url: "/store",
      amount: profit,
    }).catch((error) => logger.warn("Store sale notification failed", { reference, message: error.message }))
    return true
  } catch (error) {
    await saleRef.update({ creditClaim: null }).catch(() => null)
    throw error
  }
}

registerOrderDeliveredHook(async (order) => {
  if (order?.storefrontSlug) await settleStorefrontProfit(order)
})

/* --------------------------------- Routes --------------------------------- */

async function getOwnedSlug(uid) {
  const index = await db.ref(`storefront_owner/${uid}`).once("value")
  return index.exists() ? String(index.val()) : ""
}

export function registerStorefrontRoutes(app) {
  startCustomDomainSync()
  registerOriginAllowance(isCustomStorefrontOrigin)

  app.get("/api/storefront/me", authenticateRequest, async (req, res) => {
    try {
      const slug = await getOwnedSlug(req.authUser.uid)
      const store = slug ? (await db.ref(`storefronts/${slug}`).once("value")).val() : null
      const [role, stats] = await Promise.all([
        getUserRoleSummary(req.authUser.uid),
        slug ? db.ref(`storefront_stats/${slug}`).once("value").then((s) => s.val()) : null,
      ])
      res.set("Cache-Control", "no-store")
      return res.json({
        status: "success",
        data: store ? ownerStore({ ...store, slug }, stats) : null,
        eligible: role.privileged === true,
        baseDomain: storefrontBaseDomain(),
      })
    } catch (error) {
      logger.error("Failed to load own storefront", error, { uid: req.authUser.uid })
      return res.status(503).json({ status: "error", message: "Your store could not be loaded right now." })
    }
  })

  app.get("/api/storefront/me/sales", authenticateRequest, async (req, res) => {
    try {
      const slug = await getOwnedSlug(req.authUser.uid)
      if (!slug) return res.json({ status: "success", data: [] })
      const snapshot = await db.ref(`storefront_sales/${slug}`).limitToLast(50).once("value")
      const rows = Object.values(snapshot.val() || {})
        .map((sale) => ({
          reference: String(sale.reference || ""),
          status: sale.creditedAt ? "delivered" : String(sale.status || "initialized"),
          amount: toMoneyNumber(sale.amount, 0),
          profit: toMoneyNumber(sale.profit, 0),
          network: String(sale.network || ""),
          label: String(sale.label || ""),
          createdAt: Number(sale.createdAt || 0),
          creditedAt: Number(sale.creditedAt || 0) || null,
        }))
        .sort((a, b) => b.createdAt - a.createdAt)
      res.set("Cache-Control", "no-store")
      return res.json({ status: "success", data: rows })
    } catch (error) {
      logger.error("Failed to load store sales", error, { uid: req.authUser.uid })
      return res.status(503).json({ status: "error", message: "Sales could not be loaded right now." })
    }
  })

  app.put("/api/storefront/me", authenticateRequest, purchaseActionRateLimit, async (req, res) => {
    const uid = req.authUser.uid
    const role = await getUserRoleSummary(uid)
    if (!role.privileged) {
      return res.status(403).json({ status: "error", errorCode: "RESELLER_REQUIRED", message: "eStores are available to reseller (agent) accounts. Contact support to upgrade." })
    }
    const name = normalizeStoreName(req.body?.name)
    const tagline = normalizeStoreTagline(req.body?.tagline)
    const requestedSlug = normalizeStoreSlug(req.body?.slug)
    const whatsapp = sanitizePhoneNumber(req.body?.whatsapp)
    const customDomain = normalizeCustomDomain(req.body?.customDomain)
    const margins = Object.fromEntries(NETWORKS.map((network) => [network, toMoneyNumber(req.body?.margins?.[network], 0)]))
    if (name.length < 3) return res.status(400).json({ status: "error", message: "Store name needs at least 3 characters." })
    if (!/^0\d{9}$/.test(whatsapp)) return res.status(400).json({ status: "error", message: "Enter a 10-digit WhatsApp number, e.g. 0241234567." })
    if (Object.values(margins).some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
      return res.status(400).json({ status: "error", message: "Margins must be between GHS 0 and GHS 100." })
    }
    if (customDomain === null) return res.status(400).json({ status: "error", message: "Enter a domain like data.yourname.com, without https://." })

    const ownerRef = db.ref(`storefront_owner/${uid}`)
    const existingSlug = await getOwnedSlug(uid)
    const slug = existingSlug || requestedSlug
    if (!existingSlug && !isClaimableStoreSlug(requestedSlug)) {
      return res.status(400).json({ status: "error", message: "Choose a store address of 3–40 letters, numbers or hyphens. Some words are reserved." })
    }
    if (existingSlug && requestedSlug && requestedSlug !== existingSlug) {
      return res.status(409).json({ status: "error", message: "Your store address cannot be changed after creation." })
    }

    if (!existingSlug) {
      const ownerClaim = await ownerRef.transaction((current) => current || slug)
      if (ownerClaim.snapshot.val() !== slug) return res.status(409).json({ status: "error", message: "You already have a store." })
    }

    const storeRef = db.ref(`storefronts/${slug}`)
    const before = (await storeRef.once("value")).val()
    if (before && before.ownerUid !== uid) {
      if (!existingSlug) await ownerRef.transaction((current) => (current === slug ? null : current))
      return res.status(409).json({ status: "error", message: "That store address is taken. Try another." })
    }

    // Claim the custom domain before saving it on the store.
    const previousDomain = before?.customDomain || ""
    if (customDomain && customDomain !== previousDomain) {
      const domainClaim = await db.ref(`storefront_domains/${customDomainKey(customDomain)}`)
        .transaction((current) => (current && current !== slug ? undefined : slug))
      if (!domainClaim.committed) return res.status(409).json({ status: "error", message: "That domain is already connected to another store." })
    }

    const claim = await storeRef.transaction((current) => {
      if (current && current.ownerUid !== uid) return
      return {
        ...(current || {}), slug, ownerUid: uid, name, tagline, whatsapp, margins, customDomain: customDomain || "",
        enabled: req.body?.paused === true ? false : true,
        createdAt: current?.createdAt || Date.now(), updatedAt: Date.now(),
      }
    })
    if (!claim.committed) {
      if (!existingSlug) await ownerRef.transaction((current) => (current === slug ? null : current))
      return res.status(409).json({ status: "error", message: "That store address is taken. Try another." })
    }
    if (previousDomain && previousDomain !== customDomain) {
      await db.ref(`storefront_domains/${customDomainKey(previousDomain)}`)
        .transaction((current) => (current === slug ? null : current)).catch(() => null)
    }
    storeCache.delete(slug)
    const stats = (await db.ref(`storefront_stats/${slug}`).once("value")).val()
    return res.json({ status: "success", data: ownerStore({ ...claim.snapshot.val(), slug }, stats) })
  })

  app.get("/api/storefronts/by-host/:host", async (req, res) => {
    const slug = resolveStoreSlugFromHost(req.params.host)
    const store = slug ? await getStorefront(slug) : null
    res.set("Cache-Control", "public, max-age=120")
    if (!store) return res.status(404).json({ status: "error", message: "Store not found" })
    return res.json({ status: "success", data: { slug: store.slug } })
  })

  app.get("/api/storefronts/:slug", async (req, res) => {
    const store = await getStorefront(req.params.slug)
    if (!store) return res.status(404).json({ status: "error", message: "Store not found" })
    res.set("Cache-Control", "public, max-age=30")
    return res.json({ status: "success", data: publicStore(store) })
  })

  app.get("/api/storefronts/:slug/packages/:network", async (req, res) => {
    const store = await getStorefront(req.params.slug)
    const network = normalizePurchaseNetwork(req.params.network)
    if (!store || !NETWORKS.includes(network)) return res.status(404).json({ status: "error", message: "Store or network not found" })
    try {
      const context = await buildQuoteContext(store, network)
      res.set("Cache-Control", "no-store")
      if (!context) return res.json({ status: "success", data: [], availability: "maintenance" })
      const packages = await getCatalogPackages(network)
      const rows = packages
        .map((entry) => {
          const quote = quoteEntry(store, network, entry, context)
          if (!quote) return null
          const publicEntry = toPublicCatalogEntry(entry, { agentPricing: false, provider: context.provider })
          return { ...publicEntry, price: quote.retail }
        })
        .filter(Boolean)
        .sort((a, b) => Number(a.sortOrder || a.volume || 0) - Number(b.sortOrder || b.volume || 0))
      return res.json({ status: "success", data: rows })
    } catch (error) {
      logger.error("Store catalog failed", error, { slug: store.slug, network })
      return res.status(503).json({ status: "error", message: "Bundles could not be loaded. Please try again." })
    }
  })

  app.post("/api/storefronts/:slug/checkout", purchaseActionRateLimit, purchaseVelocityRateLimit, async (req, res) => {
    const store = await getStorefront(req.params.slug)
    const network = normalizePurchaseNetwork(req.body?.network)
    const packageId = String(req.body?.packageId || "").trim()
    const phone = sanitizePhoneNumber(req.body?.phone)
    const email = String(req.body?.email || "").trim().toLowerCase()
    if (!store || !NETWORKS.includes(network)) return res.status(404).json({ status: "error", message: "Store not found" })
    if (!/^0\d{9}$/.test(phone)) return res.status(400).json({ status: "error", message: "Enter the 10-digit number that should receive the bundle." })
    if (!isValidReceiptEmail(email)) return res.status(400).json({ status: "error", message: "Enter a valid email so we can send your receipt." })
    if (!packageId) return res.status(400).json({ status: "error", message: "Choose a bundle first." })
    // Price tampering defence: a checkout carries only what to buy and for whom.
    if (["amount", "price", "wholesale", "provider", "reference", "margin", "margins"].some((key) => req.body?.[key] !== undefined)) {
      return res.status(400).json({ status: "error", message: "Please refresh the store and choose the package again." })
    }
    if (isRecipientBlocked(phone) || isIdentityBlocked(email) || isIdentityBlocked(store.ownerUid) || assessRecipientVelocity(`ip:${req.ip}`, phone)) {
      return res.status(403).json({ status: "error", message: NEUTRAL_BLOCKED })
    }
    const context = await buildQuoteContext(store, network)
    if (!context) return res.status(409).json({ status: "error", errorCode: "NETWORK_PAUSED", message: "This network is paused by the carrier right now. Please try another network." })
    const entry = await getCatalogPackage(network, { packageId })
    const quote = quoteEntry(store, network, entry, context)
    if (!quote) return res.status(409).json({ status: "error", message: "This bundle is temporarily unavailable. Please choose another." })

    const reference = generateReference("GUEST_DATA")
    const guestUid = `guest_${crypto.createHash("sha256").update(reference).digest("hex").slice(0, 24)}`
    const amount = quote.retail
    const metadata = {
      paymentType: "guest_bundle", network, phone, packageId: quote.entry.id, volume: quote.entry.volume, amount,
      label: quote.entry.label, storefrontSlug: store.slug, storefrontOwnerUid: store.ownerUid,
      storefrontWholesale: quote.wholesale, userId: guestUid,
    }
    try {
      await upsertPurchaseIntent(reference, {
        userId: guestUid, type: "guest_bundle", network, phone,
        packageId: quote.entry.id, volume: quote.entry.volume, label: quote.entry.label,
        amount, provider: quote.provider, paymentStatus: "initialized", orderStatus: "pending",
        providerSubmissionStatus: "pending", storefrontSlug: store.slug,
        storefrontOwnerUid: store.ownerUid, storefrontWholesale: quote.wholesale,
        metadata: { email, storefrontSlug: store.slug },
      })
      // Send the buyer back to whichever store host they are shopping on, but
      // only a host this store genuinely owns - never an arbitrary Origin.
      const origin = String(req.headers.origin || "")
      let receiptOrigin = CONFIG.frontendUrl.replace(/\/$/, "")
      try {
        const host = new URL(origin).hostname.toLowerCase()
        if (origin.startsWith("https://") && resolveStoreSlugFromHost(host) === store.slug) receiptOrigin = `https://${host}`
      } catch {
        // keep the platform receipt URL
      }
      const payment = await initializePaystackPayment({
        amount: toMoneyUnits(amount), email, reference,
        callback_url: `${receiptOrigin}/receipt/${encodeURIComponent(reference)}`, metadata,
      })
      if (!payment?.status || !payment.data?.authorization_url) throw new Error("Payment setup failed")
      await db.ref(`storefront_sales/${store.slug}/${reference}`).set({
        reference, status: "initialized", amount, wholesale: quote.wholesale, network, label: quote.entry.label,
        profit: calculateStoreProfit(amount, quote.wholesale), createdAt: Date.now(),
      })
      return res.json({ status: "success", data: { reference, amount, authorization_url: payment.data.authorization_url } })
    } catch (error) {
      logger.error("Storefront checkout setup failed", error, { slug: store.slug, reference })
      return res.status(503).json({ status: "error", message: "Payment could not be started. Please try again in a moment." })
    }
  })

  /* ------------------------------ Admin tools ----------------------------- */

  app.get("/api/admin/storefronts", authenticateRequest, requirePrivilegedAccess, async (_req, res) => {
    try {
      const [stores, stats] = await Promise.all([
        db.ref("storefronts").limitToLast(500).once("value"),
        db.ref("storefront_stats").once("value"),
      ])
      const statMap = stats.val() || {}
      const rows = Object.entries(stores.val() || {}).map(([slug, store]) => ({
        ...ownerStore({ ...store, slug }, statMap[slug]),
        ownerUid: store.ownerUid,
      })).sort((a, b) => b.createdAt - a.createdAt)
      return res.json({ status: "success", data: rows })
    } catch (error) {
      logger.error("Failed to list storefronts", error)
      return res.status(503).json({ status: "error", message: "Stores could not be loaded." })
    }
  })

  app.patch("/api/admin/storefronts/:slug", authenticateRequest, requirePrivilegedAccess, adminMutationRateLimit, async (req, res) => {
    const slug = normalizeStoreSlug(req.params.slug)
    if (!slug || typeof req.body?.suspended !== "boolean") return res.status(400).json({ status: "error", message: "Invalid store update" })
    const ref = db.ref(`storefronts/${slug}`)
    const before = (await ref.once("value")).val()
    if (!before) return res.status(404).json({ status: "error", message: "Store not found" })
    await ref.update({ suspended: req.body.suspended, updatedAt: Date.now() })
    storeCache.delete(slug)
    await recordAuditEvent({
      actorUid: req.authUser.uid, action: req.body.suspended ? "admin.storefront.suspend" : "admin.storefront.restore",
      targetRef: slug, status: "success",
    }).catch(() => null)
    return res.json({ status: "success", data: { slug, suspended: req.body.suspended } })
  })
}
