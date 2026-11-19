import crypto from "crypto"
import { db } from "./firebase.js"
import { isValidRepairReference } from "./lib/repair-rules.js"
import { classifyRepairState } from "./lib/repair-rules.js"

const LEASE_MS = 120_000

export async function claimRepairLease(reference) {
  if (!isValidRepairReference(reference)) return null
  const token = crypto.randomUUID()
  const ref = db.ref(`repair_locks/${reference}`)
  const now = Date.now()
  const result = await ref.transaction((current) => {
    if (Number(current?.expiresAt || 0) > now) return
    return { token, acquiredAt: now, expiresAt: now + LEASE_MS }
  })
  return result.committed ? token : null
}

export async function releaseRepairLease(reference, token) {
  if (!isValidRepairReference(reference) || !token) return
  const ref = db.ref(`repair_locks/${reference}`)
  const snapshot = await ref.once("value")
  const fallback = snapshot.val()
  await ref.transaction((current) => {
    const value = current === null ? fallback : current
    if (value?.token !== token) return
    return null
  })
}

export async function claimRepairDispatch({ userId, orderId, token, fallbackOrder }) {
  const ref = db.ref(`orders/${userId}/${orderId}`)
  const now = Date.now()
  const result = await ref.transaction((current) => {
    const order = current === null ? fallbackOrder : current
    const claimAge = now - Number(order?.repairDispatchClaim?.claimedAt || 0)
    const isClaimActive = Boolean(order?.repairDispatchClaim && claimAge < LEASE_MS)
    if (!order || isClaimActive || classifyRepairState(order) !== "retryable") return
    return {
      ...order,
      repairDispatchClaim: { token, claimedAt: now },
      retryEligible: false,
      updatedAt: now,
    }
  })
  return result.committed === true
}
