/** Runtime configuration derived from public environment variables. */

/** Base URL of the NityHub Express API (no trailing slash). */
export const API_BASE: string = (
  process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3000"
).replace(/\/$/, "");

/** WhatsApp number used for the "Report order" deep link (from orders.js). */
export const SUPPORT_WHATSAPP = "233593554394";
