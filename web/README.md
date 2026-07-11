# NityHub Web

Next.js (App Router, TypeScript, Tailwind v4) frontend for NityHub — the
migration of the original static `NityHub/public` HTML app. It talks to the
existing Express API and uses Firebase client-SDK authentication.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in API base + Firebase web config
npm run dev                  # http://localhost:3001
```

The dev server runs on **port 3001** so it does not clash with the Express
backend on port 3000. In development the backend allows all origins, so no extra
CORS configuration is needed. For production, add the deployed web origin to the
backend's allowed origins.

## Scripts

| Script              | Purpose                          |
| ------------------- | -------------------------------- |
| `npm run dev`       | Start the dev server (port 3001) |
| `npm run build`     | Production build                 |
| `npm start`         | Serve the production build       |
| `npm run lint`      | ESLint                           |
| `npm run typecheck` | TypeScript, no emit              |

## Structure

```
app/            Routes (App Router)
  (app)/        Authenticated pages behind the app shell
  auth/         Login / signup / reset
components/
  ui/           Reusable primitives (Button, Card, Field, Table, states…)
  layout/       App shell, sidebar, hero, brand
contexts/       Auth + Toast providers
hooks/          useAsyncData (load/skeleton/error pattern)
services/       api-client (centralized fetch) + typed endpoints
lib/            firebase, formatting, cn
constants/      config, navigation, networks
types/          API envelope + domain models
```

## Backend contract

Every request goes through `services/api-client.ts`, which sets
`X-Request-Timestamp` and `X-Requested-With` on all calls and attaches the
Firebase ID token as a Bearer credential for authenticated endpoints. Responses
are treated as errors when `!res.ok` or `payload.status === "error"`.
