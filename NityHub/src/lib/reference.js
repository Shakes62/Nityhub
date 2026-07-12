import crypto from "crypto"

export function generateReference(prefix = "DATA") {
  const timestamp = Date.now()
  const random = crypto.randomBytes(2).toString("hex")
  return `${prefix}_${timestamp}_${random}`
}
