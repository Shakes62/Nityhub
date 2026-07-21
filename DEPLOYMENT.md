# Deploying NityHub

This repository holds **two separate deployables**. They cannot both go to Vercel.

```
/            <- dev-only orchestrator (concurrently). NOT deployable.
/web         <- Next.js frontend   -> Vercel
/NityHub     <- Express API        -> Render / Railway / Fly (a persistent host)
```

---

## 1. Frontend on Vercel

### The Root Directory setting (this is what causes `404: NOT_FOUND`)

The repository root has no framework and no build script — it only runs
`concurrently` for local development. If Vercel builds from the root it finds
nothing to serve and every route returns `404: NOT_FOUND`.

**Fix — in the Vercel dashboard:**

> Project → Settings → Build and Deployment → **Root Directory** → set to `web` → Save → Redeploy

There is no `vercel.json` equivalent for this: `rootDirectory` is a project
setting, not a config-file field. Setting it also makes Vercel auto-detect
Next.js, so Framework Preset, Build Command and Output Directory can all stay
on their defaults.

### Environment variables (Vercel → Settings → Environment Variables)

All are `NEXT_PUBLIC_*`, meaning they are exposed to the browser. That is
correct for Firebase web config and the API base URL. **Never** put a server
secret (Paystack key, service account, provider API keys) in a `NEXT_PUBLIC_*`
variable — it ships to every visitor.

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_BASE` | Public URL of the deployed Express API, e.g. `https://nityhub.onrender.com` — no trailing slash |
| `NEXT_PUBLIC_SITE_URL` | The site's own public origin, e.g. `https://buy.nityhub.online` |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_DATABASE_URL` | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase web config |

Copy the values from your local `web/.env.local`, which is git-ignored and
therefore never pushed.

`NEXT_PUBLIC_SITE_URL` drives canonical URLs, `sitemap.xml`, `robots.txt` and
the social preview image. If it is wrong, SEO and link previews point at the
wrong domain.

---

## 2. Backend — not on Vercel

`NityHub/` is a long-running Express server. It schedules background workers
with `setInterval`:

- order status reconciliation (`ORDER_SYNC_INTERVAL_MS`, default 45s)
- the refund outbox drain (`REFUND_WORKER_INTERVAL_MS`, default 60s)

Vercel's serverless functions are per-request and freeze between invocations,
so those intervals would never fire: provider order statuses would stop
reconciling and failed refunds would never be retried. Deploy it to a host that
keeps a process alive — Render, Railway or Fly. The code's production defaults
already assume Render (`https://nityhub.onrender.com`).

Service settings:

- Build command: `npm install --prefix NityHub`
- Start command: `npm start --prefix NityHub`
- Health check path: `/health`

### Required environment variables

See `NityHub/.env.example` for the full annotated list. At minimum the server
will not boot without Firebase credentials:

| Variable | Notes |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Full service-account JSON. Alternatives: `FIREBASE_SERVICE_ACCOUNT_BASE64`, or `FIREBASE_SERVICE_ACCOUNT_PATH` for a mounted file. Boot throws without one of these. |
| `FIREBASE_DATABASE_URL` | Realtime Database URL |
| `PAYSTACK_SECRET_KEY` | Deposits and payment verification |
| `HUBNET_API_KEY` | MTN + AirtelTigo provider |
| `GODSWAY_API_KEY` | Telecel provider |
| `PROVIDER_WEBHOOK_SECRET` | Timing-safe check on inbound provider webhooks |
| `APP_URL` | The API's own public origin. Used to build provider webhook callback URLs — if wrong, provider callbacks silently never arrive. |
| `FRONTEND_URL` | The Vercel site origin, used for links in emails/receipts |
| `ADDITIONAL_ALLOWED_ORIGINS` | Comma-separated CORS allowlist. Must include the Vercel domain, or the browser blocks every API call. |
| `PORT` | Usually injected by the host |

---

## 3. Wiring the two together

The two services reference each other, so these must agree:

- Vercel `NEXT_PUBLIC_API_BASE` → the backend's public URL
- Backend `FRONTEND_URL` and `ADDITIONAL_ALLOWED_ORIGINS` → the Vercel URL
- Backend `APP_URL` → the backend's own public URL

A mismatch here is the usual cause of a frontend that loads but whose API calls
fail CORS, and of provider webhooks that never land.

Note that Vercel gives every preview deployment a unique URL. Only the
production domain is in the CORS allowlist unless you add the others.

---

## 4. Realtime Database rule

The refund worker queries `refund_queue` by `status`. Without this index every
sweep downloads the whole node:

```json
{
  "rules": {
    "refund_queue": { ".indexOn": ["status"] }
  }
}
```

---

## 5. Post-deploy checks

```bash
curl -s https://<backend-host>/health
curl -s -o /dev/null -w "%{http_code}\n" https://<vercel-domain>/
curl -s https://<vercel-domain>/manifest.webmanifest | head -c 200
```

Then load the site and confirm the browser console shows no CORS errors on the
first API call — that is the check that most often catches a bad
`ADDITIONAL_ALLOWED_ORIGINS`.
