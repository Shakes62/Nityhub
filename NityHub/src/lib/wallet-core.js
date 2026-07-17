// Pure decision core for wallet balance mutations.
//
// This is the logic that runs inside the RTDB `walletRef.transaction()`
// updater: given the wallet node as it currently exists, decide whether to
// commit a new balance, treat the mutation as an already-applied duplicate, or
// reject it for insufficient funds.
//
// It is kept free of Firebase imports so the guards protecting real user funds
// (no double charge, no overdraft, no float drift) are exhaustively testable.
// The caller owns all RTDB plumbing: retries, snapshots and abort handling.

import { CONFIG } from "../config.js"
import { toMoneyNumber, toMoneyUnits, fromMoneyUnits, trimWalletMutationHistory } from "./money.js"

/** Outcome of a wallet mutation decision. */
export const WALLET_MUTATION = {
  /** Apply `wallet` as the new node value. */
  COMMIT: "commit",
  /** `safeMutationId` was already applied; `wallet` is unchanged. */
  DUPLICATE: "duplicate",
  /** Would overdraft a balance-guarded wallet; caller must abort. */
  INSUFFICIENT: "insufficient",
}

/**
 * Normalise whatever RTDB handed the updater into a wallet object.
 * `current` is null on the optimistic first pass, in which case we fall back to
 * the snapshot the caller read up front. A non-object node (a bare number from
 * a legacy write) is treated as the balance itself.
 */
function normalizeWallet(current, initialWalletValue) {
  const sourceValue = current == null ? initialWalletValue : current
  return sourceValue && typeof sourceValue === "object" ? sourceValue : { balance: sourceValue }
}

/** Read the applied-mutation replay guard, tolerating absent/array values. */
function readAppliedMutations(wallet) {
  return wallet.appliedMutations &&
    typeof wallet.appliedMutations === "object" &&
    !Array.isArray(wallet.appliedMutations)
    ? wallet.appliedMutations
    : {}
}

/**
 * Decide the result of applying `deltaUnits` to a wallet node.
 *
 * @param current             The node value RTDB passed the updater (may be null).
 * @param initialWalletValue  Wallet snapshot the caller read before the transaction.
 * @param deltaUnits          Signed change in integer minor units.
 * @param delta               The same change in major units, recorded on the entry.
 * @param safeMutationId      Sanitised idempotency key; falsy disables the replay guard.
 * @param requireSufficient   When true, reject rather than allow a negative balance.
 * @param now                 Injectable clock, so tests can pin timestamps.
 * @returns {{outcome: string, wallet: object, duplicateData: object|null, currentBalance: number, nextBalance: number}}
 */
export function computeWalletMutation(
  current,
  {
    initialWalletValue = {},
    deltaUnits = 0,
    delta = 0,
    safeMutationId = "",
    requireSufficient = false,
    reason = "",
    reference = null,
    details = {},
    now = Date.now(),
    historyLimit = CONFIG.walletMutationHistoryLimit,
  } = {},
) {
  const wallet = normalizeWallet(current, initialWalletValue)
  const appliedMutations = readAppliedMutations(wallet)

  const currentBalance = toMoneyNumber(wallet.balance, 0)
  const currentBalanceUnits = toMoneyUnits(currentBalance, 0)
  const nextBalanceUnits = currentBalanceUnits + deltaUnits
  const nextBalance = fromMoneyUnits(nextBalanceUnits, 0)

  // Replay guard. Checked inside the transaction so a concurrent retry of the
  // same mutation can never apply the delta twice.
  if (safeMutationId && appliedMutations[safeMutationId]) {
    return {
      outcome: WALLET_MUTATION.DUPLICATE,
      wallet,
      duplicateData: appliedMutations[safeMutationId],
      currentBalance,
      nextBalance: currentBalance,
    }
  }

  if (requireSufficient && nextBalanceUnits < 0) {
    return {
      outcome: WALLET_MUTATION.INSUFFICIENT,
      wallet,
      duplicateData: null,
      currentBalance,
      nextBalance,
    }
  }

  const nextAppliedMutations = safeMutationId
    ? trimWalletMutationHistory(
        {
          ...appliedMutations,
          [safeMutationId]: {
            amount: toMoneyNumber(delta, 0),
            balance: nextBalance,
            reference: reference || null,
            reason: String(reason || "").trim() || null,
            details: details && typeof details === "object" && !Array.isArray(details) ? details : {},
            timestamp: now,
          },
        },
        historyLimit,
      )
    : appliedMutations

  return {
    outcome: WALLET_MUTATION.COMMIT,
    wallet: {
      ...wallet,
      balance: nextBalance,
      updatedAt: now,
      appliedMutations: nextAppliedMutations,
    },
    duplicateData: null,
    currentBalance,
    nextBalance,
  }
}
