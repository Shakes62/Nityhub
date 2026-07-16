/** Runtime configuration derived from public environment variables. */

/** Base URL of the NityHub Express API (no trailing slash). */
export const API_BASE: string = (
  process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3000"
).replace(/\/$/, "");

/** Public site origin, used for metadata, canonical URLs, sitemap and robots. */
export const SITE_URL: string = (
  process.env.NEXT_PUBLIC_SITE_URL || "https://buy.nityhub.online"
).replace(/\/$/, "");

/** Human-facing product description reused across SEO surfaces. */
export const SITE_DESCRIPTION =
  "Buy affordable MTN, Telecel and AirtelTigo data bundles in seconds, fund your wallet, and track every order. Fast, secure and reliable.";

/** WhatsApp number used for the "Report order" deep link (from orders.js). */
export const SUPPORT_WHATSAPP = "233593554394";
