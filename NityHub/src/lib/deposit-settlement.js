import { db } from "../firebase.js"
import { logger } from "../logger.js"
import { toMoneyNumber, sanitizeMutationId } from "./money.js"
import { updateWalletBalance, recordTransaction } from "../domain.js"
import { acquireTransactionLock, releaseTransactionLock } from "../state.js"
import { notifyUser, notificationId } from "../notifications.js"

export {
  WebhookReplayCache,
  paystackWebhookReplayCache,
  verifyPaystackWebhookSignature,
  isEligibleWalletDeposit,
} from "./deposit-rules.js"

/**
 * Atomic deposit settlement shared by the Paystack webhook (push) and the
 * client verify call (pull). Whichever arrives first credits; the other finds
 * the receipt and no-ops.
 *
 * Order matters. The wallet credit runs FIRST because it is idempotent on its
 * own (keyed by `deposit:<reference>`): two racing settlements, or a retry
 * after a crash, can never credit twice. Only after the money has landed is
 * the deposit marked completed. The previous order (mark completed, then
 * credit) left a deposit permanently "completed" but never credited whenever
 * the credit step failed.
 *
 * The receipt is written last and is the durable "already credited" marker
 * that outlives the wallet's bounded mutation history.
 */
export async function settleWalletDeposit({
  reference,
  userId,
  amount,
  paidAt = null,
  channel = "paystack",
  source = "webhook",
}) {
  const safeRef = String(reference || "").trim()
  const safeUserId = String(userId || "").trim()
  const numAmount = toMoneyNumber(amount, 0)

  if (!safeRef || !safeUserId || numAmount <= 0) {
    throw new Error("Invalid deposit settlement parameters")
  }

  const receiptRef = db.ref(`payment_receipts/${safeRef}`)
  const existing = (await receiptRef.once("value")).val()
  if (existing?.status === "credited") {
    if (existing.userId && existing.userId !== safeUserId) {
      throw new Error("Deposit reference belongs to another account")
    }
    return { status: "success", alreadyCredited: true, message: "Deposit already credited", receipt: existing }
  }

  // Same-instance fast path; cross-instance safety comes from the idempotent
  // wallet mutation below, not from this lock.
  if (!acquireTransactionLock(safeRef, 30_000)) {
    return { status: "pending", inProgress: true, message: "Deposit verification already in progress", receipt: null }
  }

  try {
    const depositRef = db.ref(`deposits/${safeRef}`)
    const claim = await depositRef.transaction((current) => {
      if (current?.userId && current.userId !== safeUserId) return
      if (current?.status === "completed") return current
      return {
        ...(current || {}),
        reference: safeRef,
        userId: safeUserId,
        amount: numAmount,
        status: "crediting",
        channel,
        source,
        updatedAt: Date.now(),
      }
    })
    if (!claim.committed) {
      throw new Error("Deposit reference belongs to another account")
    }

    const mutationId = sanitizeMutationId(`deposit:${safeRef}`)
    // The wallet's in-record history is bounded, so also consult the durable
    // mutation log: a retry long after a crash must still not credit twice.
    const priorMutation = (await db.ref(`wallet_mutations/${safeUserId}/${mutationId}`).once("value")).val()
    const balance = priorMutation
      ? toMoneyNumber(priorMutation.balance, 0)
      : await updateWalletBalance(safeUserId, numAmount, {
        mutationId,
        reason: "wallet_deposit",
        reference: safeRef,
        details: { channel, source, paidAt },
      })

    const transaction = await recordTransaction({
      userId: safeUserId,
      type: "deposit",
      amount: numAmount,
      balance,
      reference: safeRef,
      mutationId,
      details: { channel, paidAt, source, description: "Wallet top-up via Paystack" },
    })

    await depositRef.update({ status: "completed", creditedAt: Date.now(), updatedAt: Date.now() })

    const receipt = {
      userId: safeUserId,
      reference: safeRef,
      amount: numAmount,
      balance,
      status: "credited",
      paymentType: "wallet",
      channel,
      source,
      paidAt,
      updatedAt: Date.now(),
      transactionId: transaction?.id || null,
    }
    await receiptRef.set(receipt)

    await notifyUser(safeUserId, {
      id: notificationId("deposit", safeRef),
      type: "wallet_credited",
      title: "Wallet credited",
      message: `GHS ${numAmount.toFixed(2)} received. New balance GHS ${toMoneyNumber(balance, 0).toFixed(2)}.`,
      url: "/wallet",
      amount: numAmount,
    }).catch((error) => logger.warn("Deposit notification failed", { reference: safeRef, message: error.message }))

    return { status: "success", alreadyCredited: false, message: "Wallet credited successfully", receipt }
  } finally {
    releaseTransactionLock(safeRef)
  }
}
