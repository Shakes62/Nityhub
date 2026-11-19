/**
 * Polite, user-facing error copy (blueprint 7.4).
 *
 * Raw transport errors ("Failed to fetch", "ECONNREFUSED"), upstream codes and
 * stack-ish strings never reach the screen. The backend already sends friendly
 * messages for the cases it knows about; this layer catches everything else.
 */

const CODE_COPY: Record<string, string> = {
  ETIMEDOUT: "The service timed out. Please check your order in Track Order before trying again.",
  ECONNABORTED: "The service timed out. Please check your order in Track Order before trying again.",
  REQUEST_TIMEOUT: "The service timed out. Please check your order in Track Order before trying again.",
  PROVIDER_INSUFFICIENT_BALANCE: "Orders on this network are processing with a slight delay. Please check back shortly.",
  INVALID_PHONE_PREFIX: "The recipient phone number does not match the selected network.",
  PAYMENT_FAILED: "Your payment could not be confirmed. Use the Repair button if money was deducted.",
  INSUFFICIENT_WALLET_BALANCE: "Your wallet balance is too low for this bundle. Top up and try again.",
  WALLET_TRANSACTION_ABORTED: "Your wallet was busy with another update. Please try again.",
  NETWORK_PAUSED: "This network is paused by the carrier right now. Please try another network.",
  RATE_LIMITED: "You're going a little fast. Please wait a moment and try again.",
  RESELLER_REQUIRED: "eStores are available to reseller accounts. Contact support to upgrade.",
};

const NETWORK_COPY = "We couldn't reach NityHub. Check your connection and try again.";
const SERVER_COPY = "Something went wrong on our side. Please try again in a moment.";

/** Messages that look like internals rather than something written for a person. */
const LOOKS_TECHNICAL = [
  /^[A-Z0-9_.:\- ]+$/, // a bare code such as "GODSWAY_BALANCE_LOW"
  /\bE(?:CONN[A-Z]+|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE)\b/, // socket errors
  /failed to fetch|networkerror|load failed|unexpected token|is not valid json|\bat \S+:\d+:\d+/i,
  /^(?:client|server) error:/i, // raw upstream passthrough
  /\b(?:hubnet|godsway|gigshub|pbm ?hub|ck-godsway)\b/i, // provider names stay private
  /\b(?:undefined|null|NaN)\b/,
];

export function friendlyMessage({
  message,
  status = 0,
  code,
}: {
  message?: string | null;
  status?: number;
  code?: string | null;
}): string {
  if (code && CODE_COPY[code]) return CODE_COPY[code];
  if (status === 429) return CODE_COPY.RATE_LIMITED;
  const text = String(message || "").trim();
  if (status === 0) return NETWORK_COPY;
  if (!text || LOOKS_TECHNICAL.some((pattern) => pattern.test(text)) || text.length > 220) {
    return status >= 500 ? SERVER_COPY : "We couldn't complete that request. Please try again.";
  }
  return text;
}

/** Friendly copy from anything thrown. */
export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (error && typeof error === "object" && "message" in error) {
    const value = error as { message?: unknown; status?: unknown; errorCode?: unknown };
    return friendlyMessage({
      message: typeof value.message === "string" ? value.message : fallback,
      status: typeof value.status === "number" ? value.status : 400,
      code: typeof value.errorCode === "string" ? value.errorCode : null,
    });
  }
  return fallback;
}
