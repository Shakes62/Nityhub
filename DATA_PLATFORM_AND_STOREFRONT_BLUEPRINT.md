# Master Architectural Blueprint: High-Reliability Data Vending & Reseller Storefront Platform

> **Target Audience:** Systems Architects, Full-Stack Engineers, and Technical Leads building or upgrading high-throughput telecom data vending platforms.  
> **Applicability:** Stack-agnostic (Node.js, Go, Python, Laravel, Java, etc.) — designed to serve as the reference engineering standard for enterprise-grade mobile data vending.

---

## Table of Contents
1. [Core Architectural Principles](#1-core-architectural-principles)
2. [Feature 2: Multi-Provider Backend & Dynamic Network Control](#2-feature-2-multi-provider-backend--dynamic-network-control)
   - 2.1 Provider Abstraction Layer (PAL) & Masking
   - 2.2 Network Availability & Dynamic Switchboard
   - 2.3 The 3-State Error Engine (`retryable` vs `uncertain` vs `hard fail`)
   - 2.4 Circuit Breaking & Automated Health Scoring
   - 2.5 Price Floors & Commercial Guardrails
3. [Feature 3: Self-Healing Customer & Storefront Order Repair System](#3-feature-3-self-healing-customer--storefront-order-repair-system)
   - 3.1 The Problem Space
   - 3.2 Dual-Mode Order Identification (Authenticated vs Guest)
   - 3.3 The 7-Step Atomic Repair Pipeline
   - 3.4 Anti-Replay & Concurrency Locking
4. [Feature 4: Instant Deposit Auto-Credit & Ledger Integrity](#4-feature-4-instant-deposit-auto-credit--ledger-integrity)
   - 4.1 Dual-Ingestion Model (Webhooks + Polling Fallback)
   - 4.2 Cryptographic Verification & Anti-Replay Cache
   - 4.3 Atomic Balance Mutex & Double-Entry Accounting
   - 4.4 Real-Time User Notification Stream
5. [Feature 5: Social Proof & Dynamic Engagement Systems](#5-feature-5-social-proof--dynamic-engagement-systems)
   - 5.1 Privacy-Preserving Proof-of-Delivery Sliders
   - 5.2 Dynamic Rotating Promotional & Operational Banners
6. [Feature 6: Multi-Tenant Reseller eStore / Storefront Architecture](#6-feature-6-multi-tenant-reseller-estore--storefront-architecture)
   - 6.1 Multi-Tenant Domain & Subdomain Routing
   - 6.2 Wholesale vs Retail Economics & Instant Profit Crediting
   - 6.3 Frictionless Guest Checkout (Zero-Login Funnel)
   - 6.4 WhatsApp Automation & Catalog Integration
7. [Feature 7: Frontend Architecture & High-Trust UI/UX Standards](#7-feature-7-frontend-architecture--high-trust-uiux-standards)
   - 7.1 Visual Hierarchy & Clean Product Layouts
   - 7.2 Mobile Bottom-Sheet Package Selectors
   - 7.3 Delivery Estimate Display (Zero-"Unavailable" Rule)
   - 7.4 Polite User-Facing Error Translation
   - 7.5 PWA Caching Hierarchy (Fresh vs Cached Boundary)
8. [Feature 8: Security Hardening & Anti-Fraud Architecture](#8-feature-8-security-hardening--anti-fraud-architecture)
   - 8.1 Price Tampering Prevention
   - 8.2 Wallet Concurrency & Negative Balance Guards
   - 8.3 Velocity Rate Limiting & Risk Engine
   - 8.4 Global Phone & Identity Blacklisting
9. [Step-by-Step Upgrade Roadmap for Existing Platforms](#9-step-by-step-upgrade-roadmap-for-existing-platforms)

---

## 1. Core Architectural Principles

High-volume digital telecom vending platforms face a unique challenge: **third-party telco APIs are inherently flaky, asynchronous, and prone to silent drops.** If your system makes naive assumptions, you will suffer catastrophic double-deliveries, lost customer payments, or stranded buyers.

Every system component must follow five unbreakable laws:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        THE 5 LAWS OF TELECOM VENDING                         │
├──────────────────────────────┬───────────────────────────────────────────────┤
│ 1. Asynchronous Truth        │ Never assume a timeout means failure.         │
│ 2. Idempotency at Every Gate │ Re-running any request MUST produce the same  │
│                              │ final balance and order status.               │
│ 3. Strict Provider Isolation │ Upstream provider names and errors must NEVER │
│                              │ be leaked to users, agents, or client apps.   │
│ 4. Single-Source Pricing     │ The client NEVER dictates product price.      │
│ 5. Graceful Self-Healing     │ The customer must be empowered to repair an   │
│                              │ order without human customer support tickets. │
└──────────────────────────────┴───────────────────────────────────────────────┘
```

---

## 2. Feature 2: Multi-Provider Backend & Dynamic Network Control

### 2.1 Provider Abstraction Layer (PAL) & Masking

A data vending platform should connect to multiple upstream vendors (e.g., direct carrier gateways, aggregators, API providers). However:
- **Commercial Security:** Upstream partners are trade secrets. If your customers or competitors see your providers in API payloads, they can bypass you or exploit provider downtime.
- **Unified Interface:** Each provider uses different parameter names (`phone` vs `recipient` vs `mobile`, `bundle_id` vs `network_code`). The core platform must interact with a single normalized contract.

#### The Provider Registry Pattern
Define an internal registry mapping real vendors to generic, masked identities:

```
[Upstream Provider A]  ──┐
[Upstream Provider B]  ──┼──> [Provider Abstraction Layer] ──> [Public Alias: "Provider A"]
[Upstream Provider C]  ──┘       (Internal Dispatcher)          (Public Alias: "Provider B")
```

- **Canonical Key (DB/Logs):** `provider_a`, `provider_b`, `provider_c` (or internal coded identifiers).
- **Masked Alias (Admin UI & APIs):** `"Provider A"`, `"Provider B"`.
- **Public Mask (Customer/Storefront):** Strictly generic (e.g. `"Express Route"`, `"Standard Route"`, or completely invisible).

#### Canonical Normalization Function
Every provider key entering or exiting the system must pass through a strict decoder:

```javascript
// Example implementation pattern (pseudo-code)
const PROVIDER_BACKENDS = ["gateway_alpha", "gateway_beta", "gateway_gamma"];

const ALIAS_MAP = {
  "provider_a": "gateway_alpha",
  "alpha":      "gateway_alpha",
  "provider_b": "gateway_beta",
  "beta":       "gateway_beta"
};

function decodeProvider(input) {
  const normalized = String(input || "").trim().toLowerCase();
  return ALIAS_MAP[normalized] || null; // Strict: reject unmapped tokens
}
```

---

### 2.2 Network Availability & Dynamic Switchboard

Admin control over which networks and capacities are open for business must be instantaneous and granular.

#### The 3-Tier Switchboard Architecture
1. **Platform Master Switch:** Global on/off toggle for all vending services.
2. **Network Switches:** Toggle entire carriers (e.g., MTN: `ACTIVE`, AirtelTigo: `MAINTENANCE`, Telecel: `ACTIVE`).
3. **Route / Backend Switches:** Route a specific network through a chosen provider (e.g., MTN routed to Provider A; if Provider A fails, switch to Provider B).
4. **Capacity Toggles:** Temporarily disable individual package sizes (e.g., disable 10GB while keeping 1GB–5GB active).

#### Fast Cache + Database Configuration
- Store network configuration in a centralized key-value database table (`app_config` or Redis).
- Cache the configuration in memory with a short TTL (15–30 seconds) or invalidate via Pub/Sub on admin change.
- When an admin toggles a network off:
  - The shop card immediately changes state from "Tap to purchase" to "Back shortly, try another network".
  - The API endpoint `/api/purchase` validates availability server-side and immediately rejects new orders for that network before touching payment gateways.

---

### 2.3 The 3-State Error Engine (`retryable` vs `uncertain` vs `hard fail`)

**The most dangerous bug in telecom systems is the naive timeout:**
1. Platform calls Provider A.
2. Provider A's server accepts the order and queues it with the telco.
3. Provider A's connection times out after 15 seconds before returning HTTP 200.
4. Naive platform treats this as "FAILED", immediately refunds the customer's wallet or dispatches to Provider B.
5. Telco fulfills the order. **Result:** The customer received the data for free (or received two data bundles).

#### The Classification Matrix
Every transport and HTTP error MUST be classified into one of three outcomes:

```
                           ┌───────────────────────────┐
                           │   Provider API Error      │
                           └─────────────┬─────────────┘
                                         │
                 ┌───────────────────────┼────────────────────────┐
                 ▼                       ▼                        ▼
       [1. DEFINITIVE REJECT]    [2. UNCERTAIN STATE]     [3. HARD FAILURE]
       - HTTP 400, 404, 422      - HTTP 500, 502, 503     - Provider account
       - "Invalid phone number"  - ETIMEDOUT              suspended / out of
       - "Network unsupported"   - ECONNABORTED           funds
       - ECONNREFUSED (gateway   - ECONNRESET             
         never reached)          - Dropped socket         
                 │                       │                        │
                 ▼                       ▼                        ▼
          [SAFE TO FAILOVER]    [DO NOT FAILOVER]        [LOCK ROUTE & STOP]
          Try next provider in  [DO NOT AUTO-REFUND]     Alert admin; halt
          the chain immediately Leave order in           dispatch to avoid
                                "PROCESSING" & poll      repeated failures.
```

- **`retryable: true`**: Only when you are 100% certain the provider never started processing the order. Failing over to another provider is safe.
- **`uncertain: true`**: You have lost communication with the provider after dispatching. You must assume the order is in flight. **Never trigger an automatic refund or auto-failover.** Let background polling or manual repair resolve the state.

---

### 2.4 Circuit Breaking & Automated Health Scoring

When an upstream provider degrades, continuing to route traffic to it causes customer friction and stranded orders.

#### Rolling Window Scoring Algorithm
Track the last $N$ attempts (e.g., 20 attempts) or a 10-minute rolling time window for each provider:

$$\text{Health Rate} = \frac{\text{Successful Dispatches}}{\text{Total Attempts}}$$

- **Auto-Cooldown Rule:** If $\text{Total Attempts} \ge 5$ and $\text{Health Rate} < 50\%$, trip the circuit breaker.
- **Cooldown Behavior:** Automatically remove the provider from the active dispatch pool for 10 minutes.
- **Recovery Probe:** After the cooldown expires, allow 1 "canary" order through. If it succeeds, reset the circuit breaker. If it fails, extend cooldown.

---

### 2.5 Price Floors & Commercial Guardrails

If an upstream provider increases their cost, or an admin makes a typographical error when entering wholesale prices, the system could sell packages below cost.

#### Protection Pattern
- Maintain a `provider_costs` table recording the exact cost of each package on each provider.
- In the dispatch pipeline, enforce:
  $$\text{Retail Price} \ge \text{Provider Wholesale Cost} + \text{Minimum Margin}$$
- If a route would result in a negative gross profit, the dispatcher aborts the dispatch, flags the order for admin review, and does not execute the trade.

---

## 3. Feature 3: Self-Healing Customer & Storefront Order Repair System

### 3.1 The Problem Space

Even with 99.9% uptime, payments and deliveries fail due to:
- Customers closing the browser before the payment callback finishes.
- Mobile network drops during 3D Secure / OTP authorization.
- Gateway webhooks delayed by internet peering issues.
- Telco queuing delays.

Instead of flooding customer support channels with tickets, **provide an automated self-healing Repair Engine.**

---

### 3.2 Dual-Mode Order Identification (Authenticated vs Guest)

The repair system must handle two user journeys seamlessly:

1. **Signed-in Member:** Inputs order reference from their account order history.
2. **Guest Buyer (Storefront / E-store):** Inputs the payment reference straight from their payment receipt, SMS, or bank alert (`T123456789...`).

```
                    ┌───────────────────────────────┐
                    │ Customer Enters Reference     │
                    └───────────────┬───────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
       [Internal Order Record Found]   [External Payment Reference Only]
       - Verify User Ownership         - Query Payment Gateway API
       - Check Order Status            - Reconstruct Purchase Context
```

---

### 3.3 The 7-Step Atomic Repair Pipeline

When a customer submits a reference for repair, execute the pipeline in strict order:

```
[Step 1: Ownership / Gateway Verification]
  Verify that the user owns the order, OR query the payment gateway (Paystack/Flutterwave/Momo)
  to verify that real money was captured for this reference.
       │
       ▼
[Step 2: Idempotency Gate]
  Is the order already marked "SUCCESSFUL" / "DELIVERED"?
  -> If YES: Return instant success with delivery details. Do not dispatch again.
       │
       ▼
[Step 3: Double-Benefit Defense]
  Was this order already refunded to the user's wallet?
  -> If YES: Reject repair with clear message: "This order was already refunded to your balance."
       │
       ▼
[Step 4: Concurrency Lock (Mutex)]
  Acquire an atomic row-level lock on the order (`SELECT FOR UPDATE` or Redis lock).
  Prevent multiple simultaneous repair clicks on the same order.
       │
       ▼
[Step 5: Upstream Status Reconciliation]
  Query the provider's status API. Did the original delivery actually go through?
  -> If YES: Mark order "DELIVERED", record delivered timestamp, return success.
       │
       ▼
[Step 6: Fallback Re-dispatch]
  If the original provider definitively rejected or dropped the order:
  -> Route the order to the next healthy provider in the chain.
  -> Do not bill the customer again.
       │
       ▼
[Step 7: Customer Communication]
  Send instant SMS confirmation + Web Push notification with receipt link.
```

---

### 3.4 Anti-Replay & Concurrency Locking

```sql
-- Database Concurrency Guard Pattern (PostgreSQL / MySQL)
BEGIN;

-- Lock the target order row so no parallel webhook or repair worker can touch it
SELECT id, status, is_refunded, recipient_phone, package_size 
FROM orders 
WHERE reference = :reference 
FOR UPDATE;

-- Validate preconditions inside transaction
-- If status == 'SUCCESSFUL' or is_refunded == true, ROLLBACK and exit early.

-- Process re-delivery or status confirmation...

UPDATE orders 
SET status = 'SUCCESSFUL', 
    delivered_at = NOW(),
    repaired_at = NOW() 
WHERE id = :order_id;

COMMIT;
```

---

## 4. Feature 4: Instant Deposit Auto-Credit & Ledger Integrity

### 4.1 Dual-Ingestion Model (Webhooks + Polling Fallback)

Relying solely on webhooks is fragile (gateways can drop webhooks under load). Relying solely on client polling is slow and exhausts rate limits.

**The Golden Architecture: Dual-Ingestion with Atomic Settlement.**

```
[Payment Gateway]
      │
      ├──────────────────────────────┐
      ▼                              ▼
(Push: Webhook Handler)     (Pull: Client Verify Polling)
      │                              │
      └──────────────┬───────────────┘
                     ▼
          [Atomic Deposit Mutex]
          - First arrival wins
          - Second arrival detects "COMPLETED" & no-ops
```

---

### 4.2 Cryptographic Verification & Anti-Replay Cache

#### 1. Raw Body Signature Verification
Never verify webhooks using a parsed JSON object. JSON parsers reorder keys and alter whitespace, breaking cryptographic signatures.

```javascript
// Express.js / Node.js pattern
const crypto = require("crypto");

function verifyWebhookSignature(req, secret) {
  const signature = req.headers["x-paystack-signature"];
  // req.rawBody must be captured as a raw Buffer before JSON parsing
  const hash = crypto.createHmac("sha512", secret)
                     .update(req.rawBody)
                     .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
}
```

#### 2. Anti-Replay Cache (Memory / Redis)
Store a hash of the webhook signature/payload in a cache with a 15-minute TTL. If an identical webhook arrives twice within the window, respond HTTP 200 immediately without executing database queries.

---

### 4.3 Atomic Balance Mutex & Double-Entry Accounting

Never calculate balance in application memory (e.g., `let newBal = user.balance + amount; user.save()`). This causes catastrophic race conditions.

#### The Atomic SQL Pattern

```sql
-- Safe, atomic credit with idempotency check
BEGIN;

-- 1. Check and mark deposit as completed in one atomic step
UPDATE deposits
SET status = 'completed',
    credited_at = NOW()
WHERE reference = :reference 
  AND status = 'pending';

-- 2. If row was updated (rows_affected == 1), credit the user wallet
UPDATE users
SET balance = balance + :credit_amount,
    updated_at = NOW()
WHERE id = :user_id;

-- 3. Record immutable ledger entry
INSERT INTO wallet_transactions (
    user_id, 
    type, 
    amount, 
    reference, 
    description, 
    created_at
) VALUES (
    :user_id, 
    'deposit', 
    :credit_amount, 
    :reference, 
    'Wallet top-up via Paystack', 
    NOW()
);

COMMIT;
```

---

### 4.4 Real-Time User Notification Stream

When the deposit settles, immediately notify the user's open browser session without requiring a page refresh:
- **Server-Sent Events (SSE) / WebSockets:** Broadcast `wallet_updated` event with the new balance.
- **Web Push Notification:** Deliver a system push notification ("Wallet Credited: GHS 50.00 received").

---

## 5. Feature 5: Social Proof & Dynamic Engagement Systems

### 5.1 Privacy-Preserving Proof-of-Delivery Sliders

Prospective buyers want to know: *“Does this platform actually deliver right now?”*

Display a rotating ticker or live proof slide:
> **MTNUP2U:** Delivered in 34 seconds · 2 minutes ago  
> **Telecel:** Delivered in 1 minute · 5 minutes ago

```
┌────────────────────────────────────────────────────────┐
│  ⚡ MTNUP2U last delivery took 34s (2 mins ago)        │
└────────────────────────────────────────────────────────┘
```

#### Privacy & Security Rules:
1. **Never show recipient numbers:** Strip or do not send recipient phone numbers, user IDs, or names.
2. **Freshness Window:** Only show deliveries completed within the last 12 hours. Stale proof undermines trust.
3. **Cap Outliers:** If a delivery took 45 minutes due to telco delays, do not display "took 45 mins" on the homepage ticker. Only showcase deliveries completed within standard SLA (e.g., $\le 15\text{ minutes}$).

---

### 5.2 Dynamic Rotating Promotional & Operational Banners

Maintain an admin-driven banner feed supporting three variants:
1. **Promotions:** Blue/purple gradient ("Weekend Data Promo: 10GB now GHS 45").
2. **Operational Notices:** Amber tone ("AirtelTigo network undergoing maintenance by carrier").
3. **Announcements:** Informational notices with custom clickable call-to-action buttons.

---

## 6. Feature 6: Multi-Tenant Reseller eStore / Storefront Architecture

### 6.1 Multi-Tenant Domain & Subdomain Routing

Allow agents and resellers to spin up their own branded web store within 60 seconds without writing code.

```
Request: https://daniels-data.topmeup.store/shop
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Host Header Resolution: "daniels-data.topmeup.store"           │
│ -> Extract subdomain: "daniels-data"                            │
│ -> Look up storefront config by `storefront_id`                 │
│ -> Load custom branding: Name, WhatsApp contact, Custom margins │
└─────────────────────────────────────────────────────────────────┘
```

#### Domain Strategy:
- **Wildcard Subdomains:** `*.yourstore.domain` routes to the storefront renderer.
- **Custom Domains (Optional):** CNAME alias pointing to your application load balancer with automatic SSL (via Cloudflare for Platforms or Caddy).

---

### 6.2 Wholesale vs Retail Economics & Instant Profit Crediting

#### Economic Model:
- **Platform Wholesale Cost:** Platform sells 5GB MTN to Reseller at GHS 20.00.
- **Reseller Retail Price:** Reseller sets custom price on their store: GHS 25.00.
- **Gross Profit:** GHS 5.00.

#### The Instant Profit Credit Pipeline:
When a customer completes a purchase on `daniels-data`:
1. Customer pays GHS 25.00 directly to platform payment gateway.
2. Platform deducts wholesale price (GHS 20.00) and executes data delivery.
3. Platform **immediately credits the GHS 5.00 profit into the Reseller’s main platform wallet.**
4. Reseller receives an instant notification: *"Sale on your eStore! GHS 5.00 profit credited to your wallet."*

---

### 6.3 Frictionless Guest Checkout (Zero-Login Funnel)

**High drop-off occurs whenever a storefront forces guest buyers to create passwords and verify emails.**

```
[Select Package] ──> [Enter Recipient Phone] ──> [Enter Email (for receipt)] ──> [Pay with Momo/Card]
                                                                                       │
                                                                                       ▼
                                                                           [Instant Live Receipt]
```

- Buyer gets a permanent tracking link: `https://store.domain/receipt/<reference>`.
- The reference allows them to track live progress and self-repair if needed.

---

### 6.4 WhatsApp Automation & Catalog Integration

Storefronts must include a direct WhatsApp chat integration:
- Floating WhatsApp support button pre-configured with the Reseller’s phone number.
- Pre-filled support message:
  `"Hello, I need help with my order on [Store Name]. Reference: [REF123]"`

---

## 7. Feature 7: Frontend Architecture & High-Trust UI/UX Standards

### 7.1 Visual Hierarchy & Clean Product Layouts

Avoid visual clutter, neon colors, and loud badges that resemble spam sites.

#### Recommended Design Tokens:
- **Backgrounds:** Clean neutral canvas (`#f8fafc` or `#0f172a` for dark mode).
- **Cards:** Subtle borders (`1px solid #e2e8f0`), rounded corners (`12px` to `16px`), soft shadows.
- **Typography:** Modern sans-serif (Inter, Plus Jakarta Sans, Geist). Bold package size (`5 GB`), calm secondary price (`GHS 25.00`).
- **Accents:** Emerald green (`#10b981`) reserved specifically for active networks and confirmed deliveries.

---

### 7.2 Mobile Bottom-Sheet Package Selectors

On mobile devices, traditional dropdown `<select>` menus deliver poor usability.

```
┌──────────────────────────────────────────────┐
│  Select MTN Data Package                 [✕] │
├──────────────────────────────────────────────┤
│  ● 1 GB  ──────────────  GHS 6.00            │
│  ● 2 GB  ──────────────  GHS 11.50           │
│  ● 5 GB  ──────────────  GHS 26.00  (Popular)│
│  ● 10 GB ──────────────  GHS 50.00           │
└──────────────────────────────────────────────┘
```

- When the user taps a network card, slide up an animated **Bottom Sheet Modal**.
- Large, thumb-friendly touch targets ($\ge 48\text{px}$ height).
- Displays package size, price, and validity (e.g., "Non-expiry") clearly.

---

### 7.3 Delivery Estimate Display (Zero-"Unavailable" Rule)

Customers abandon checkouts when they see "Delivery: Unavailable".

#### Implementation Rules:
1. **Never show "Unavailable" for delivery estimates.** If historical sample data is thin or missing, fall back to a reassuring, realistic baseline:
   `"Usually 5–15 min"`
2. **Confident vs Standard Tints:**
   - Fast routes ($\le 5\text{ minutes}$ measured median): Subtle success green (`~1–5 min`).
   - Standard routes: Neutral calm grey (`~5–15 min`).
3. **Decouple ETA from Network Maintenance:** If a carrier is down, state: *"Network temporarily paused by carrier"* — do not overwrite the time metric itself.

---

### 7.4 Polite User-Facing Error Translation

Raw developer errors destroy conversion rates and expose system vulnerabilities. Never display raw upstream messages like `ECONNREFUSED` or `GODSWAY_BALANCE_LOW`.

| Upstream / System Error | Sanitized User-Facing Copy |
| :--- | :--- |
| `ETIMEDOUT` / `ECONNABORTED` | *"Service timed out. Please check your order in Track Order before trying again."* |
| `PROVIDER_INSUFFICIENT_BALANCE` | *"Orders on this network are temporarily processing with a slight delay. Please check back shortly."* |
| `INVALID_PHONE_PREFIX` | *"The recipient phone number does not match the selected network."* |
| `PAYMENT_FAILED` | *"Your payment could not be confirmed. Use the Repair button if money was deducted."* |

---

### 7.5 PWA Caching Hierarchy (Fresh vs Cached Boundary)

Service workers make platforms instant, but caching dynamic financial data is catastrophic.

```
┌───────────────────────────────────────┬──────────────────────────────────────┐
│ RESOURCE                              │ WORKBOX / SERVICE WORKER STRATEGY    │
├───────────────────────────────────────┼──────────────────────────────────────┤
│ Static Assets (JS, CSS, SVGs, Fonts)  │ CacheFirst (Instant repeat loads)    │
│ Platform Public Pages (FAQ, Privacy)  │ StaleWhileRevalidate                 │
│ Dynamic Catalog & Networks            │ NetworkFirst (Fallback to cache)     │
│ User Wallet Balances & Order History  │ NetworkOnly (NEVER CACHE)            │
│ Payment & Repair API Endpoints        │ NetworkOnly (NEVER CACHE)            │
└───────────────────────────────────────┴──────────────────────────────────────┘
```

---

## 8. Feature 8: Security Hardening & Anti-Fraud Architecture

### 8.1 Price Tampering Prevention

**Attack Vector:** Malicious users alter the payload in browser DevTools:
`{"packageId": "mtn_5gb", "price": 0.50}`

#### Prevention:
- The client payload must ONLY submit `{ networkKey, capacityKey, recipientPhone }`.
- The server ignores any client-supplied prices.
- The server looks up the authoritative price from the database catalog before deducting funds or initiating gateway invoices.

---

### 8.2 Wallet Concurrency & Negative Balance Guards

**Attack Vector:** A user with GHS 20.00 sends 5 parallel purchase requests within 100 milliseconds, attempting to buy five GHS 20.00 packages.

#### Database Constraint Defense:
Ensure your database enforces unsigned or non-negative checks:

```sql
-- PostgreSQL / MySQL Schema Constraint
ALTER TABLE users ADD CONSTRAINT check_balance_non_negative CHECK (balance >= 0.00);
```

#### Conditional Atomic Debit:
```sql
UPDATE users 
SET balance = balance - :purchase_price 
WHERE id = :user_id AND balance >= :purchase_price;
```
If `rows_affected == 0`, immediately abort and return: *"Insufficient wallet balance"*.

---

### 8.3 Velocity Rate Limiting & Risk Engine

Implement progressive rate limits:
1. **Per-IP Limits:** Maximum 60 requests per minute on public endpoints.
2. **Purchase Velocity:** Maximum 3 purchase submissions per 10 seconds per account.
3. **Recipient Throttling:** Flag an account if it attempts to dispatch to more than 20 unique phone numbers within a 5-minute window (indicative of carding/fraud bot).

---

### 8.4 Global Phone & Identity Blacklisting

Maintain an in-memory blacklisted numbers set:
- Any number caught performing fraudulent chargebacks, fraud reports, or abuse is recorded in `phone_blacklist`.
- Every entry point (Shop, Storefront, API v1) performs a sub-millisecond hash check.
- Reject requests with a neutral message: *"This recipient number cannot be processed at this time."*

---

## 9. Step-by-Step Upgrade Roadmap for Existing Platforms

Follow this phased execution plan to upgrade an existing platform safely without downtime:

```
[Phase 1: DB Foundation & Provider Isolation]
  ├── Deploy canonical aliases table & provider masking layer
  ├── Implement conditional atomic wallet debit queries
  └── Add check constraint for non-negative balances
          │
          ▼
[Phase 2: Payment Gateway & Deposit Hardening]
  ├── Add HMAC signature verification on raw webhook body
  ├── Implement 15-minute anti-replay cache
  └── Deploy dual-resolution (Webhook + Client Verify) mutex
          │
          ▼
[Phase 3: Multi-Provider Failover & Error Classification]
  ├── Build Provider Abstraction Layer (PAL)
  ├── Implement 3-State Error Classifier (retryable vs uncertain)
  └── Add automated circuit breaker and health scoring
          │
          ▼
[Phase 4: Customer Self-Healing Repair Engine]
  ├── Build `/api/repair-order` endpoint with atomic row lock
  ├── Add gateway verification fallback for guest payments
  └── Build front-facing Repair Form Modal on shop and receipts
          │
          ▼
[Phase 5: Reseller eStore Multi-Tenancy]
  ├── Implement Host/Subdomain routing middleware
  ├── Build reseller margin & instant profit-credit pipeline
  └── Deploy zero-login guest checkout funnel
          │
          ▼
[Phase 6: Frontend & UI/UX Elevation]
  ├── Upgrade to mobile bottom-sheet package pickers
  ├── Enforce zero-"Unavailable" delivery estimate rules
  └── Add live proof-of-delivery slider & dynamic banners
```

---

*Document compiled and verified against production standards for PBM-HUB platform ecosystem.*
