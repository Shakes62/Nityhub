import crypto from "crypto"

export function generateReference(prefix = "DATA") {
  const timestamp = Date.now()
  // Guest receipts use the payment reference as a capability. Keep it hard to
  // guess even when an attacker knows the timestamp and order prefix.
  const random = crypto.randomBytes(16).toString("hex")
  return `${prefix}_${timestamp}_${random}`
}
