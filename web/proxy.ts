import { NextResponse, type NextRequest } from "next/server";

/**
 * Multi-tenant storefront routing (blueprint 6.1).
 *
 *   daniels-data.<NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN>/      -> /store/daniels-data
 *   data.example.com/  (a reseller's connected domain)      -> /store/<their slug>
 *
 * Only "/" and "/shop" are rewritten; every other path (receipt, repair) is
 * the normal app, so a buyer's receipt link works on the store's own host.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3000").replace(/\/$/, "");
const BASE_DOMAIN = (process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN || "").toLowerCase().replace(/^\./, "");

function platformHosts(): Set<string> {
  const hosts = new Set(["localhost", "127.0.0.1"]);
  for (const value of (process.env.NEXT_PUBLIC_PLATFORM_HOSTS || "").split(",")) {
    const host = value.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  try {
    hosts.add(new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://buy.nityhub.online").hostname.toLowerCase());
  } catch {
    /* ignore a malformed site URL */
  }
  if (BASE_DOMAIN) hosts.add(BASE_DOMAIN);
  return hosts;
}

const PLATFORM_HOSTS = platformHosts();
const CUSTOM_DOMAIN_TTL_MS = 5 * 60_000;
const customDomainCache = new Map<string, { slug: string; at: number }>();

async function lookupCustomDomain(host: string): Promise<string> {
  const cached = customDomainCache.get(host);
  if (cached && Date.now() - cached.at < CUSTOM_DOMAIN_TTL_MS) return cached.slug;
  let slug = "";
  try {
    const response = await fetch(`${API_BASE}/api/storefronts/by-host/${encodeURIComponent(host)}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (response.ok) {
      const payload = (await response.json()) as { data?: { slug?: string } };
      slug = SLUG.test(String(payload?.data?.slug || "")) ? String(payload.data!.slug) : "";
    }
  } catch {
    // Unknown on error: fall through to the normal app rather than block it.
    return "";
  }
  customDomainCache.set(host, { slug, at: Date.now() });
  if (customDomainCache.size > 1000) customDomainCache.clear();
  return slug;
}

/**
 * The host the visitor actually typed. `nextUrl.hostname` reflects the
 * server's own bind address under `next start`, so read the forwarded/Host
 * header instead. Spoofing it can only change which public store is shown.
 */
function requestHost(request: NextRequest): string {
  const raw = request.headers.get("x-forwarded-host") || request.headers.get("host") || request.nextUrl.hostname;
  return raw.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
}

export async function proxy(request: NextRequest) {
  const hostname = requestHost(request);
  let slug = "";

  if (BASE_DOMAIN && hostname.endsWith(`.${BASE_DOMAIN}`)) {
    const candidate = hostname.slice(0, -BASE_DOMAIN.length - 1);
    if (SLUG.test(candidate) && !candidate.includes(".") && candidate !== "www") slug = candidate;
  } else if (!PLATFORM_HOSTS.has(hostname) && !hostname.endsWith(".vercel.app") && hostname.includes(".")) {
    slug = await lookupCustomDomain(hostname);
  }

  if (!slug) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = `/store/${slug}`;
  return NextResponse.rewrite(url);
}

export const config = { matcher: ["/", "/shop"] };
