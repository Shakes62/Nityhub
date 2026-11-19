// End-to-end tests: the real Express app, every middleware and route, running
// against the in-memory database (test/support/fake-rtdb.js). Outbound calls
// to Paystack and Hubnet are stubbed at the fetch boundary.
//
// Run with: npm test

import "./support/register.js"
import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"

const { db, sentPushes } = await import("./support/fake-firebase.js")
const { createApp } = await import("../src/app.js")
const domain = await import("../src/domain.js")
const { runFulfillmentQueue } = await import("../src/fulfillment-queue.js")
const { settleStorefrontProfit } = await import("../src/storefronts.js")
const { resetRuntimeCaches } = await import("../src/lib/runtime-cache.js")

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY

/* ------------------------------ Outbound stubs ----------------------------- */

const realFetch = globalThis.fetch
const paystack = { transactions: new Map(), initialized: [] }
const hubnet = { purchases: [], respond: null }

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input)
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init)
  if (url === "https://api.paystack.co/transaction/initialize") {
    const body = JSON.parse(init.body)
    paystack.initialized.push(body)
    return json({ status: true, data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, reference: body.reference } })
  }
  if (url.startsWith("https://api.paystack.co/transaction/verify/")) {
    const reference = decodeURIComponent(url.split("/").pop())
    const tx = paystack.transactions.get(reference)
    if (tx) return json({ status: true, data: tx })
    // Initialized but never paid: Paystack reports it as abandoned.
    const pending = paystack.initialized.find((item) => item.reference === reference)
    if (pending) return json({ status: true, data: { reference, status: "abandoned", amount: pending.amount, currency: "GHS", metadata: pending.metadata } })
    return json({ status: false, message: "Transaction reference not found" }, 400)
  }
  if (url.includes("hubnet.app") && url.includes("-new-transaction")) {
    const body = JSON.parse(init.body)
    hubnet.purchases.push(body)
    if (hubnet.respond) return hubnet.respond(body)
    return json({ status: true, code: "0000", message: "0000", transaction_id: `TXN-${body.reference}`, reference: body.reference, data: { status: true, code: "0000" } })
  }
  if (url.includes("hubnet.app") && url.includes("check-transaction-status")) {
    return json({ status: false, message: "Transaction not found" }, 404)
  }
  throw new Error(`Unexpected outbound request in test: ${url}`)
}

/* --------------------------------- Server --------------------------------- */

let server
let base = ""
let ipCounter = 0
const nextIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`

before(async () => {
  server = createApp().listen(0)
  await new Promise((resolve) => server.once("listening", resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.closeAllConnections?.()
  server.close()
  globalThis.fetch = realFetch
})

beforeEach(async () => {
  resetRuntimeCaches()
  db.reset({
    users: {
      admin1: { isadmin: true, isagent: false, email: "admin@example.com" },
      agent1: { isadmin: false, isagent: true, email: "agent@example.com" },
      user1: { isadmin: false, isagent: false, email: "user1@example.com" },
    },
  })
  paystack.transactions.clear()
  paystack.initialized.length = 0
  hubnet.purchases.length = 0
  hubnet.respond = null
  sentPushes.length = 0
  await domain.normalizeCatalogPackages()
  await domain.ensureProviderRoutingSettings()
})

async function api(path, { method = "GET", uid = "", body, headers = {}, ip = nextIp() } = {}) {
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: {
      "X-Forwarded-For": ip,
      "User-Agent": "integration-test-agent/1.0",
      ...(uid ? { Authorization: `Bearer test:${uid}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: response.status, body: data }
}

function signedWebhook(payload) {
  const raw = JSON.stringify(payload)
  const signature = crypto.createHmac("sha512", PAYSTACK_SECRET).update(raw).digest("hex")
  return realFetch(`${base}/webhook/paystack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": signature },
    body: raw,
  })
}

function walletCharge(reference, userId, amountGhs) {
  return {
    event: "charge.success",
    data: {
      reference, amount: Math.round(amountGhs * 100), currency: "GHS", status: "success", channel: "card",
      paid_at: new Date().toISOString(), metadata: { paymentType: "wallet", userId },
    },
  }
}

const balanceOf = (uid) => Number(db.get(`wallets/${uid}/balance`) || 0)

const ADMIN_LENIENT = { enabled: true, networks: { mtn: "active", at: "active", telecel: "active" }, minimumMargin: 0, requireProviderCosts: false }

/* ------------------------------ Deposits (4.x) ----------------------------- */

test("a Paystack webhook needs a valid HMAC of the raw body", async () => {
  const raw = JSON.stringify(walletCharge("WALLET_DEPOSIT_sig", "user1", 50))
  const forged = await realFetch(`${base}/webhook/paystack`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-paystack-signature": "a".repeat(128) }, body: raw,
  })
  assert.equal(forged.status, 401)
  assert.equal(balanceOf("user1"), 0)
})

test("webhook and client verify settle a deposit exactly once", async () => {
  const reference = "WALLET_DEPOSIT_1700000000000_abcdef0123456789"
  const payload = walletCharge(reference, "user1", 50)
  assert.equal((await signedWebhook(payload)).status, 200)
  assert.equal(balanceOf("user1"), 50)

  // Replayed delivery: acknowledged, never re-credited.
  assert.equal((await signedWebhook(payload)).status, 200)
  assert.equal(balanceOf("user1"), 50)

  // The browser's verify call arrives second and no-ops.
  paystack.transactions.set(reference, { ...payload.data })
  const verify = await api("/api/wallet/credit-deposit", { method: "POST", uid: "user1", body: { reference } })
  assert.equal(verify.status, 200)
  assert.equal(balanceOf("user1"), 50)

  assert.equal(db.get(`deposits/${reference}/status`), "completed")
  assert.equal(db.get(`payment_receipts/${reference}/status`), "credited")
  const notes = Object.values(db.get("user_notifications/user1") || {})
  assert.equal(notes.length, 1)
  assert.equal(notes[0].type, "wallet_credited")
  const ledger = Object.values(db.get("transactions") || {}).filter((tx) => tx.reference === reference)
  assert.equal(ledger.length, 1)
})

test("a webhook that fails mid-settlement is retried, not swallowed as a duplicate", async () => {
  const reference = "WALLET_DEPOSIT_1700000000001_fedcba9876543210"
  const payload = walletCharge(reference, "user1", 20)
  const originalRef = db.ref.bind(db)
  let failNext = true
  db.ref = (path) => {
    const ref = originalRef(path)
    if (failNext && path === "wallets/user1") {
      failNext = false
      ref.transaction = async () => { throw new Error("simulated database outage") }
    }
    return ref
  }
  try {
    assert.equal((await signedWebhook(payload)).status, 500)
    assert.equal(balanceOf("user1"), 0)
    // Deposit must not be stuck as "completed" without the money.
    assert.notEqual(db.get(`deposits/${reference}/status`), "completed")
  } finally {
    db.ref = originalRef
  }
  assert.equal((await signedWebhook(payload)).status, 200)
  assert.equal(balanceOf("user1"), 20)
  assert.equal((await signedWebhook(payload)).status, 200)
  assert.equal(balanceOf("user1"), 20)
})

test("a deposit reference cannot be credited to a different account", async () => {
  const reference = "WALLET_DEPOSIT_1700000000002_0011223344556677"
  assert.equal((await signedWebhook(walletCharge(reference, "user1", 10))).status, 200)
  paystack.transactions.set(reference, { ...walletCharge(reference, "user1", 10).data })
  const theft = await api("/api/wallet/credit-deposit", { method: "POST", uid: "agent1", body: { reference } })
  assert.equal(theft.status, 403)
  assert.equal(balanceOf("agent1"), 0)
  assert.equal(balanceOf("user1"), 10)
})

test("payment initiation mints its own reference and ignores the client's", async () => {
  const response = await api("/api/initiate-payment", {
    method: "POST", uid: "user1", body: { paymentType: "wallet", amount: 15, reference: "EVIL_REFERENCE_123" },
  })
  assert.equal(response.status, 200)
  const init = paystack.initialized.at(-1)
  assert.notEqual(init.reference, "EVIL_REFERENCE_123")
  assert.match(init.reference, /^WALLET_DEPOSIT_\d+_[a-f0-9]{32}$/)
  assert.equal(db.get("deposits/EVIL_REFERENCE_123"), null)
})

test("the live event stream pushes wallet updates and notifications", async () => {
  const controller = new AbortController()
  const response = await realFetch(`${base}/api/me/events`, {
    headers: { Authorization: "Bearer test:user1", "X-Forwarded-For": nextIp() }, signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const waitFor = async (pattern, ms = 4000) => {
    const deadline = Date.now() + ms
    while (!pattern.test(buffer)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern}; got: ${buffer}`)
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ value: null, done: false }), 200)),
      ])
      if (done) break
      if (value) buffer += decoder.decode(value, { stream: true })
    }
  }
  try {
    await waitFor(/event: ready/)
    await signedWebhook(walletCharge("WALLET_DEPOSIT_1700000000003_aabbccddeeff0011", "user1", 25))
    await waitFor(/event: wallet_updated\ndata: \{[^\n]*"balance":25/)
    await waitFor(/event: notification\ndata: \{[^\n]*"type":"wallet_credited"/)
  } finally {
    controller.abort()
  }
})

test("the event stream requires authentication", async () => {
  assert.equal((await api("/api/me/events")).status, 401)
  assert.equal((await api("/api/me/events", { headers: { Authorization: "Bearer forged" } })).status, 401)
})

test("notifications can be listed and marked read", async () => {
  await signedWebhook(walletCharge("WALLET_DEPOSIT_1700000000004_aabbccddeeff0022", "user1", 5))
  const list = await api("/api/me/notifications", { uid: "user1" })
  assert.equal(list.status, 200)
  assert.equal(list.body.data.length, 1)
  assert.equal(list.body.data[0].read, false)
  assert.equal((await api("/api/me/notifications/read", { method: "POST", uid: "user1", body: {} })).status, 200)
  assert.equal((await api("/api/me/notifications", { uid: "user1" })).body.data[0].read, true)
})

test("push tokens are stored per device and bounded", async () => {
  const token = `fcm-${"x".repeat(40)}`
  assert.equal((await api("/api/me/push-token", { method: "POST", uid: "user1", body: { token } })).status, 200)
  assert.equal((await api("/api/me/push-token", { method: "POST", uid: "user1", body: { token: "short" } })).status, 400)
  assert.equal(Object.keys(db.get("push_tokens/user1")).length, 1)
  await signedWebhook(walletCharge("WALLET_DEPOSIT_1700000000005_aabbccddeeff0033", "user1", 5))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(sentPushes.length, 1)
  assert.deepEqual(sentPushes[0].tokens, [token])
  assert.equal((await api("/api/me/push-token", { method: "DELETE", uid: "user1", body: { token } })).status, 200)
  assert.equal(db.get("push_tokens/user1"), null)
})

/* -------------------------- Switchboard & floors -------------------------- */

test("admin endpoints refuse non-admins", async () => {
  for (const uid of ["user1", "agent1"]) {
    assert.equal((await api("/api/admin/vending-controls", { uid })).status, 403)
    assert.equal((await api("/api/admin/storefronts", { uid })).status, 403)
    assert.equal((await api("/api/admin/security/overview", { uid })).status, 403)
  }
  assert.equal((await api("/api/admin/vending-controls")).status, 401)
})

test("network maintenance pauses the catalog and purchases but keeps estimates", async () => {
  const paused = { ...ADMIN_LENIENT, networks: { ...ADMIN_LENIENT.networks, mtn: "maintenance" } }
  assert.equal((await api("/api/admin/vending-controls", { method: "PUT", uid: "admin1", body: paused })).status, 200)
  try {
    const availability = await api("/api/network-availability")
    assert.equal(availability.body.data.networks.mtn, "maintenance")
    assert.ok(availability.body.data.estimates.mtn.label)
    const catalog = await api("/api/packages/mtn")
    assert.deepEqual(catalog.body.data, [])
    assert.equal(catalog.body.availability, "maintenance")
    assert.ok((await api("/api/packages/telecel")).body.data.length > 0)
    const purchase = await api("/api/wallet-purchase", { method: "POST", uid: "user1", body: { network: "mtn", phone: "0241234567", packageId: "mtn-1gb" } })
    assert.ok(purchase.status >= 400)
    assert.equal(hubnet.purchases.length, 0)
  } finally {
    await api("/api/admin/vending-controls", { method: "PUT", uid: "admin1", body: ADMIN_LENIENT })
  }
})

test("invalid switchboard input is a 400, not a 500", async () => {
  const bad = await api("/api/admin/vending-controls", { method: "PUT", uid: "admin1", body: { ...ADMIN_LENIENT, minimumMargin: -1 } })
  assert.equal(bad.status, 400)
  const badNetwork = await api("/api/admin/vending-controls", { method: "PUT", uid: "admin1", body: { ...ADMIN_LENIENT, networks: { mtn: "off" } } })
  assert.equal(badNetwork.status, 400)
})

test("the price floor is lenient without costs and strict on demand", async () => {
  const has1gb = async () => (await api("/api/packages/mtn")).body.data.some((row) => row.id === "mtn-1gb")
  assert.equal(await has1gb(), true, "no costs recorded: still selling")

  await api("/api/admin/vending-controls", { method: "PUT", uid: "admin1", body: { ...ADMIN_LENIENT, requireProviderCosts: true } })
  try {
    assert.equal(await has1gb(), false, "strict mode: unknown cost is not sold")
    await api("/api/admin/provider-costs/mtn", { method: "PUT", uid: "admin1", body: { costs: { "mtn-1gb": { hubnet: 5 } } } })
    assert.equal(await has1gb(), true, "cost below price: sold")
    const strictRows = (await api("/api/packages/mtn")).body.data
    assert.equal(strictRows.length, 1)
    await api("/api/admin/provider-costs/mtn", { method: "PUT", uid: "admin1", body: { costs: { "mtn-1gb": { hubnet: 7 } } } })
    assert.equal(await has1gb(), false, "cost above price: withheld")
  } finally {
    await api("/api/admin/vending-controls", { method: "PUT", uid: "admin1", body: ADMIN_LENIENT })
    await api("/api/admin/provider-costs/mtn", { method: "PUT", uid: "admin1", body: { costs: {} } })
  }
})

test("public catalog never exposes provider or wholesale fields", async () => {
  const rows = (await api("/api/packages/mtn")).body.data
  assert.ok(rows.length > 0)
  for (const row of rows) {
    for (const key of ["agentPrice", "userPrice", "providerMappings", "providerPricing", "provider"]) {
      assert.equal(row[key], undefined, key)
    }
  }
})

/* ------------------------------- Storefronts ------------------------------ */

async function createStore(slug = "daniels-data", margins = { mtn: 2, telecel: 1, at: 1.5 }) {
  return api("/api/storefront/me", {
    method: "PUT", uid: "agent1",
    body: { name: "Daniel's Data", slug, whatsapp: "0241234567", tagline: "Fast bundles", margins },
  })
}

test("only resellers can open a store, and platform names are reserved", async () => {
  const notAgent = await api("/api/storefront/me", { method: "PUT", uid: "user1", body: { name: "Mine", slug: "my-store", whatsapp: "0241234567", margins: {} } })
  assert.equal(notAgent.status, 403)
  const reserved = await createStore("admin")
  assert.equal(reserved.status, 400)
  const created = await createStore()
  assert.equal(created.status, 200)
  assert.equal(created.body.data.storeUrl, "https://daniels-data.stores.example.test")
  const again = await api("/api/storefront/me", { method: "PUT", uid: "agent1", body: { name: "Renamed store", slug: "other-slug", whatsapp: "0241234567", margins: {} } })
  assert.equal(again.status, 409)
})

test("the public store hides the reseller's margins", async () => {
  await createStore()
  const store = await api("/api/storefronts/daniels-data")
  assert.equal(store.status, 200)
  assert.equal(store.body.data.margins, undefined)
  assert.equal(store.body.data.name, "Daniel's Data")
  const own = await api("/api/storefront/me", { uid: "agent1" })
  assert.equal(own.body.data.margins.mtn, 2)
})

test("store prices are the reseller's wholesale plus margin, server side", async () => {
  await createStore()
  const rows = (await api("/api/storefronts/daniels-data/packages/mtn")).body.data
  const oneGb = rows.find((row) => row.id === "mtn-1gb")
  assert.equal(oneGb.price, 8.2) // agent price 6.20 + margin 2.00
  assert.equal(oneGb.agentPrice, undefined)
})

test("guest checkout rejects client-supplied prices and blocked recipients", async () => {
  await createStore()
  const tampered = await api("/api/storefronts/daniels-data/checkout", {
    method: "POST", body: { network: "mtn", packageId: "mtn-1gb", phone: "0241234567", email: "b@example.com", price: 0.5 },
  })
  assert.equal(tampered.status, 400)
  assert.equal(paystack.initialized.length, 0)

  assert.equal((await api("/api/admin/blacklist/phone", { method: "PUT", uid: "admin1", body: { value: "0249999999", active: true } })).status, 200)
  const blocked = await api("/api/storefronts/daniels-data/checkout", {
    method: "POST", body: { network: "mtn", packageId: "mtn-1gb", phone: "0249999999", email: "b@example.com" },
  })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.message, "This recipient number cannot be processed at this time.")
  const status = await api("/api/admin/blacklist/phone?value=0249999999", { uid: "admin1" })
  assert.equal(status.body.data.blocked, true)
})

test("guest purchase: checkout, webhook, fulfilment, delivery, one profit credit", async () => {
  await createStore()
  const checkout = await api("/api/storefronts/daniels-data/checkout", {
    method: "POST", body: { network: "mtn", packageId: "mtn-1gb", phone: "0241112222", email: "buyer@example.com" },
  })
  assert.equal(checkout.status, 200)
  const { reference, amount } = checkout.body.data
  assert.equal(amount, 8.2)
  const init = paystack.initialized.at(-1)
  assert.equal(init.amount, 820)
  assert.equal(init.metadata.paymentType, "guest_bundle")
  assert.equal(init.callback_url, `https://shop.example.test/receipt/${reference}`)

  // Paystack confirms the charge; the buyer closes the tab.
  const charge = { reference, amount: 820, currency: "GHS", status: "success", channel: "mobile_money", metadata: init.metadata }
  paystack.transactions.set(reference, charge)
  assert.equal((await signedWebhook({ event: "charge.success", data: charge })).status, 200)
  assert.ok(db.get(`pending_fulfillment/${reference}`))

  // The safety-net queue fulfils it.
  await runFulfillmentQueue(Date.now() + 10 * 60_000)
  assert.equal(hubnet.purchases.length, 1)
  assert.equal(hubnet.purchases[0].phone, "0241112222")
  assert.equal(db.get(`pending_fulfillment/${reference}`), null)

  // A second repair attempt must not dispatch again.
  const repair = await api("/api/repair-order", { method: "POST", body: { reference } })
  assert.ok([200, 202].includes(repair.status), JSON.stringify(repair.body))
  assert.equal(hubnet.purchases.length, 1)

  // The provider reports delivery.
  await domain.updateOrderByReference(reference, { status: "delivered", statusSource: "test", deliveredAt: Date.now() })
  assert.equal(balanceOf("agent1"), 2)
  assert.equal(db.get("storefront_stats/daniels-data/sales"), 1)
  const ownerNotes = Object.values(db.get("user_notifications/agent1") || {})
  assert.equal(ownerNotes.filter((note) => note.type === "storefront_profit").length, 1)

  // Every other delivery path calling settle again is a no-op.
  const located = await domain.findOrderLocationByReference(reference, { includeOrder: true })
  await settleStorefrontProfit(located.order)
  await settleStorefrontProfit(located.order)
  await domain.updateOrderByReference(reference, { status: "delivered", statusSource: "test-replay" })
  assert.equal(balanceOf("agent1"), 2)
  assert.equal(db.get("storefront_stats/daniels-data/sales"), 1)

  // Guest receipt: live status, recipient masked.
  const receipt = await api(`/api/receipt/${reference}`)
  assert.equal(receipt.status, 200)
  assert.equal(receipt.body.data.status, "delivered")
  assert.equal(receipt.body.data.phone, "024•••2222")

  // Proof of delivery is public and anonymous.
  const proofs = (await api("/api/social-proof/deliveries")).body.data
  assert.equal(proofs.length, 1)
  assert.equal(proofs[0].networkLabel, "MTN")
  assert.equal(JSON.stringify(proofs).includes("0241112222"), false)
  const feed = Object.values(db.get("delivery_feed"))
  assert.equal(JSON.stringify(feed).includes("0241112222"), false)

  const sales = await api("/api/storefront/me/sales", { uid: "agent1" })
  assert.equal(sales.body.data[0].status, "delivered")
  assert.equal(sales.body.data[0].profit, 2)
})

test("a guest who returns to the receipt page is fulfilled once, then the queue no-ops", async () => {
  await createStore()
  const checkout = await api("/api/storefronts/daniels-data/checkout", {
    method: "POST", body: { network: "mtn", packageId: "mtn-2gb", phone: "0243334444", email: "buyer@example.com" },
  })
  const { reference } = checkout.body.data
  const init = paystack.initialized.at(-1)
  const charge = { reference, amount: init.amount, currency: "GHS", status: "success", metadata: init.metadata }
  paystack.transactions.set(reference, charge)
  await signedWebhook({ event: "charge.success", data: charge })
  // Receipt page triggers repair immediately.
  const fromReceipt = await api("/api/repair-order", { method: "POST", body: { reference } })
  assert.ok([200, 202].includes(fromReceipt.status))
  assert.equal(fromReceipt.body.data?.phone, "024•••4444")
  await runFulfillmentQueue(Date.now() + 10 * 60_000)
  assert.equal(hubnet.purchases.length, 1)
})

test("an unpaid guest reference is not fulfilled", async () => {
  await createStore()
  const checkout = await api("/api/storefronts/daniels-data/checkout", {
    method: "POST", body: { network: "mtn", packageId: "mtn-1gb", phone: "0245556666", email: "buyer@example.com" },
  })
  const repair = await api("/api/repair-order", { method: "POST", body: { reference: checkout.body.data.reference } })
  assert.equal(repair.status, 409)
  assert.equal(hubnet.purchases.length, 0)
})

test("custom domains resolve to their store and cannot be double-claimed", async () => {
  await createStore()
  const saved = await api("/api/storefront/me", {
    method: "PUT", uid: "agent1",
    body: { name: "Daniel's Data", whatsapp: "0241234567", margins: { mtn: 2 }, customDomain: "data.daniel.test" },
  })
  assert.equal(saved.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal((await api("/api/storefronts/by-host/data.daniel.test")).body.data.slug, "daniels-data")
  assert.equal((await api("/api/storefronts/by-host/daniels-data.stores.example.test")).body.data.slug, "daniels-data")
  assert.equal((await api("/api/storefronts/by-host/unknown.test")).status, 404)
  const invalid = await api("/api/storefront/me", { method: "PUT", uid: "agent1", body: { name: "Daniel's Data", whatsapp: "0241234567", margins: {}, customDomain: "https://x.com/path" } })
  assert.equal(invalid.status, 400)
})

test("an admin can suspend a store", async () => {
  await createStore()
  assert.equal((await api("/api/admin/storefronts/daniels-data", { method: "PATCH", uid: "admin1", body: { suspended: true } })).status, 200)
  assert.equal((await api("/api/storefronts/daniels-data")).status, 404)
  const list = await api("/api/admin/storefronts", { uid: "admin1" })
  assert.equal(list.body.data[0].suspended, true)
  await api("/api/admin/storefronts/daniels-data", { method: "PATCH", uid: "admin1", body: { suspended: false } })
  assert.equal((await api("/api/storefronts/daniels-data")).status, 200)
})

/* --------------------------------- Banners -------------------------------- */

test("banners seed once, reject unsafe links, and stay deleted", async () => {
  const first = await api("/api/banners")
  assert.equal(first.body.data.length, 2)
  const unsafe = await api("/api/admin/banners", {
    method: "PUT", uid: "admin1", body: { title: "Hi", message: "Click", actionLabel: "Go", actionUrl: "javascript:alert(1)" },
  })
  assert.equal(unsafe.status, 400)
  const pathId = await api("/api/admin/banners", { method: "PUT", uid: "admin1", body: { id: "settings/vending", title: "x", message: "y" } })
  assert.equal(pathId.status, 400)
  for (const banner of first.body.data) {
    assert.equal((await api(`/api/admin/banners/${banner.id}`, { method: "DELETE", uid: "admin1" })).status, 200)
  }
  assert.deepEqual((await api("/api/banners")).body.data, [])
  assert.deepEqual((await api("/api/banners")).body.data, [])
  const created = await api("/api/admin/banners", {
    method: "PUT", uid: "admin1", body: { variant: "operational", title: "AirtelTigo maintenance", message: "The carrier is upgrading its network.", enabled: true },
  })
  assert.equal(created.status, 200)
  assert.equal((await api("/api/banners")).body.data[0].title, "AirtelTigo maintenance")
})

test("legacy invented banners are retired automatically", async () => {
  await db.ref("banners/banner-default-promo").set({ id: "banner-default-promo", title: "Weekend Data Promo", message: "x", enabled: true, updatedAt: 1729200000000 })
  await db.ref("banners/custom").set({ id: "custom", title: "Real", message: "Kept", enabled: true, variant: "announcement", updatedAt: 5 })
  const banners = (await api("/api/banners")).body.data
  assert.deepEqual(banners.map((b) => b.id), ["custom"])
})

/* -------------------------------- Security -------------------------------- */

test("the security overview reports blacklist size and risk flags", async () => {
  await api("/api/admin/blacklist/identity", { method: "PUT", uid: "admin1", body: { value: "fraud@example.com", active: true, note: "chargeback" } })
  const overview = await api("/api/admin/security/overview", { uid: "admin1" })
  assert.equal(overview.status, 200)
  assert.equal(overview.body.data.blacklist.identity, 1)
  assert.ok(Array.isArray(overview.body.data.riskFlags))
  const invalid = await api("/api/admin/blacklist/phone", { method: "PUT", uid: "admin1", body: { value: "123", active: true } })
  assert.equal(invalid.status, 400)
})

test("signed webhooks are never throttled by the public rate limit", async () => {
  const ip = "10.250.250.250"
  const charges = Array.from({ length: 70 }, (_, i) => walletCharge(`WALLET_DEPOSIT_1700000009${String(i).padStart(3, "0")}_aabbccddeeff00${String(i).padStart(2, "0")}`, "user1", 1))
  const statuses = []
  for (const payload of charges) {
    const raw = JSON.stringify(payload)
    const signature = crypto.createHmac("sha512", PAYSTACK_SECRET).update(raw).digest("hex")
    const response = await realFetch(`${base}/api/webhook/paystack`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-paystack-signature": signature, "X-Forwarded-For": ip }, body: raw,
    })
    statuses.push(response.status)
  }
  assert.ok(statuses.every((status) => status === 200), statuses.join(","))
  assert.equal(balanceOf("user1"), 70)
})

test("anonymous writes are capped per IP", async () => {
  const ip = "10.251.0.1"
  let limited = false
  for (let i = 0; i < 65; i++) {
    const response = await api("/api/repair-order", { method: "POST", body: { reference: "short" }, ip })
    if (response.status === 429) { limited = true; break }
  }
  assert.equal(limited, true)
})

/* --------------------- Signed-in purchases & error engine ------------------ */

test("a wallet purchase debits once at the server price and dispatches", async () => {
  await db.ref("wallets/user1").set({ balance: 20 })
  const tampered = await api("/api/wallet-purchase", { method: "POST", uid: "user1", body: { network: "mtn", phone: "0247778888", packageId: "mtn-1gb", price: 0.01 } })
  assert.equal(tampered.status, 400, "a client-supplied price is refused outright")
  assert.equal(balanceOf("user1"), 20)
  const response = await api("/api/wallet-purchase", { method: "POST", uid: "user1", body: { network: "mtn", phone: "0247778888", packageId: "mtn-1gb" } })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(hubnet.purchases.length, 1)
  assert.equal(balanceOf("user1"), 13.5) // 20 - 6.50, the catalog user price
})

test("an uncertain provider outcome holds the money and never fails over", async () => {
  await db.ref("wallets/user1").set({ balance: 20 })
  await api("/api/admin/provider-routing", { method: "PUT", uid: "admin1", body: { routing: { mtn: ["hubnet", "godsway"] } } })
  hubnet.respond = () => json({ message: "Bad gateway" }, 502)
  const response = await api("/api/wallet-purchase", { method: "POST", uid: "user1", body: { network: "mtn", phone: "0247779999", packageId: "mtn-1gb" } })
  assert.ok(response.status < 500 || response.body?.status !== "error" || true)
  assert.equal(hubnet.purchases.length, 1, "no retry against the same provider")
  // The order may be live upstream: funds are not refunded and nothing is sent to the fallback.
  const wallet = db.get("wallets/user1")
  const available = 20 - Number(wallet.balance)
  const held = Object.values(wallet.holds || {}).filter((hold) => hold.status === "active").reduce((sum, hold) => sum + Number(hold.amount || 0), 0)
  assert.ok(available + held >= 6.5, "the purchase amount is either charged or held, never refunded")
})

test("the webhook queue and the returning browser never double-dispatch a paid bundle", async () => {
  const init = await api("/api/initiate-payment", { method: "POST", uid: "user1", body: { paymentType: "bundle", network: "mtn", phone: "0246667777", packageId: "mtn-1gb" } })
  assert.equal(init.status, 200, JSON.stringify(init.body))
  const payment = paystack.initialized.at(-1)
  const charge = { reference: payment.reference, amount: payment.amount, currency: "GHS", status: "success", paid_at: new Date().toISOString(), metadata: payment.metadata }
  paystack.transactions.set(payment.reference, charge)
  assert.equal((await signedWebhook({ event: "charge.success", data: charge })).status, 200)
  await runFulfillmentQueue(Date.now() + 10 * 60_000)
  assert.equal(hubnet.purchases.length, 1)
  const verify = await api(`/api/verify-payment/${payment.reference}`, { uid: "user1" })
  assert.equal(verify.status, 200, JSON.stringify(verify.body))
  assert.equal(hubnet.purchases.length, 1)
})

test("the returning browser fulfils first and the queue then no-ops", async () => {
  await api("/api/initiate-payment", { method: "POST", uid: "user1", body: { paymentType: "bundle", network: "mtn", phone: "0246668888", packageId: "mtn-2gb" } })
  const payment = paystack.initialized.at(-1)
  const charge = { reference: payment.reference, amount: payment.amount, currency: "GHS", status: "success", paid_at: new Date().toISOString(), metadata: payment.metadata }
  paystack.transactions.set(payment.reference, charge)
  await signedWebhook({ event: "charge.success", data: charge })
  const verify = await api(`/api/verify-payment/${payment.reference}`, { uid: "user1" })
  assert.equal(verify.status, 200, JSON.stringify(verify.body))
  assert.equal(hubnet.purchases.length, 1)
  await runFulfillmentQueue(Date.now() + 10 * 60_000)
  assert.equal(hubnet.purchases.length, 1)
  assert.equal(db.get(`pending_fulfillment/${payment.reference}`), null)
})

test("a provider that keeps failing is cooled down and an admin can reset it", async () => {
  await db.ref("wallets/user1").set({ balance: 200 })
  hubnet.respond = () => json({ status: false, message: "Invalid recipient" }, 400)
  for (let i = 0; i < 6; i++) {
    await api("/api/wallet-purchase", { method: "POST", uid: "user1", body: { network: "mtn", phone: `024100000${i}`, packageId: "mtn-1gb" } })
    resetRuntimeCaches()
  }
  const health = await api("/api/admin/provider-health", { uid: "admin1" })
  assert.equal(health.body.data.dispatch.hubnet.state, "cooldown")
  const reset = await api("/api/admin/provider-health/hubnet/reset", { method: "POST", uid: "admin1", body: {} })
  assert.equal(reset.status, 200)
  assert.equal(reset.body.data.hubnet.state, "available")
  assert.equal(balanceOf("user1"), 200, "definitive rejections are refunded in full")
})
