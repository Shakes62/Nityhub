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
  /** Referenced hold does not exist (or was pruned after settling). */
  MISSING: "missing",
  /** Hold exists but is already settled the other way; caller must not proceed. */
  CONFLICT: "conflict",
}

/** Lifecycle of one reserved amount. */
export const HOLD_STATUS = {
  /** Reserved: not spendable, but not taken from the customer either. */
  HELD: "held",
  /** Converted into a real debit. */
  CAPTURED: "captured",
  /** Returned to the spendable balance without ever being charged. */
  RELEASED: "released",
}

export const WALLET_HOLD_OPERATION = {
  HOLD: "hold",
  CAPTURE: "capture",
  RELEASE: "release",
}

/** Read the holds map, tolerating absent/array values. */
function readHolds(wallet) {
  return wallet.holds && typeof wallet.holds === "object" && !Array.isArray(wallet.holds) ? wallet.holds : {}
}

/**
 * Reserved total, always recomputed from the holds themselves.
 *
 * The stored `heldBalance` is a convenience for reads and is never trusted as
 * the source of truth: a partial write or a hand-edit would otherwise make
 * money permanently unspendable with nothing to reconcile against.
 */
function sumActiveHoldUnits(holds) {
  return Object.values(holds).reduce((total, entry) => {
    return entry?.status === HOLD_STATUS.HELD ? total + toMoneyUnits(entry?.amount, 0) : total
  }, 0)
}

/**
 * Bound the holds map without ever dropping an active reservation.
 *
 * Settled entries are only kept so a duplicate capture/release can be
 * recognised as a replay. Losing an old one is safe - a late duplicate then
 * reads as MISSING, which callers treat as "do nothing" - whereas dropping a
 * held entry would silently release funds.
 */
function trimSettledHolds(holds, limit) {
  const entries = Object.entries(holds)
  const settled = entries.filter(([, entry]) => entry?.status !== HOLD_STATUS.HELD)
  const maxSettled = Math.max(0, Number(limit || 0))
  if (settled.length <= maxSettled) {
    return holds
  }

  const doomed = new Set(
    settled
      .sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0))
      .slice(0, settled.length - maxSettled)
      .map(([key]) => key),
  )

  return Object.fromEntries(entries.filter(([key]) => !doomed.has(key)))
}

/**
 * Decide the result of a hold / capture / release against a wallet node.
 *
 * This is what makes "the customer is never debited for an order no provider
 * accepted" true rather than merely usually true: the money is reserved up
 * front so it cannot be spent twice, but the balance itself does not move until
 * a provider has actually taken the order. A purchase that fails everywhere
 * releases the reservation, leaving no debit and no refund in the ledger at all.
 *
 * Every operation is keyed on `holdId` and is safe to replay.
 */
export function computeWalletHoldMutation(
  current,
  {
    initialWalletValue = {},
    operation = WALLET_HOLD_OPERATION.HOLD,
    holdId = "",
    amount = 0,
    reference = null,
    reason = "",
    details = {},
    now = Date.now(),
    historyLimit = CONFIG.walletMutationHistoryLimit,
  } = {},
) {
  const wallet = normalizeWallet(current, initialWalletValue)
  const holds = readHolds(wallet)
  const currentBalance = toMoneyNumber(wallet.balance, 0)
  const currentBalanceUnits = toMoneyUnits(currentBalance, 0)
  const heldUnits = sumActiveHoldUnits(holds)
  const availableUnits = currentBalanceUnits - heldUnits

  const base = {
    wallet,
    duplicateData: null,
    currentBalance,
    nextBalance: currentBalance,
    heldBalance: fromMoneyUnits(heldUnits, 0),
    availableBalance: fromMoneyUnits(availableUnits, 0),
  }

  if (!holdId) {
    return { ...base, outcome: WALLET_MUTATION.MISSING }
  }

  const existing = holds[holdId] || null

  if (operation === WALLET_HOLD_OPERATION.HOLD) {
    if (existing) {
      return { ...base, outcome: WALLET_MUTATION.DUPLICATE, duplicateData: existing }
    }

    const amountUnits = toMoneyUnits(amount, 0)
    if (amountUnits <= 0) {
      return { ...base, outcome: WALLET_MUTATION.CONFLICT }
    }

    // Guarded against `available`, not `balance`: two purchases in flight must
    // not both pass on the same funds.
    if (amountUnits > availableUnits) {
      return { ...base, outcome: WALLET_MUTATION.INSUFFICIENT }
    }

    const nextHeldUnits = heldUnits + amountUnits
    return {
      ...base,
      outcome: WALLET_MUTATION.COMMIT,
      heldBalance: fromMoneyUnits(nextHeldUnits, 0),
      availableBalance: fromMoneyUnits(currentBalanceUnits - nextHeldUnits, 0),
      wallet: {
        ...wallet,
        // Balance deliberately untouched: nothing has been charged yet.
        heldBalance: fromMoneyUnits(nextHeldUnits, 0),
        updatedAt: now,
        holds: trimSettledHolds(
          {
            ...holds,
            [holdId]: {
              amount: fromMoneyUnits(amountUnits, 0),
              status: HOLD_STATUS.HELD,
              reference: reference || null,
              reason: String(reason || "").trim() || null,
              details: details && typeof details === "object" && !Array.isArray(details) ? details : {},
              createdAt: now,
              updatedAt: now,
            },
          },
          historyLimit,
        ),
      },
    }
  }

  if (!existing) {
    // Either it never applied, or it settled long ago and was pruned. Both mean
    // "there is nothing to move"; the caller must not invent a balance change.
    return { ...base, outcome: WALLET_MUTATION.MISSING }
  }

  const settledStatus =
    operation === WALLET_HOLD_OPERATION.CAPTURE ? HOLD_STATUS.CAPTURED : HOLD_STATUS.RELEASED
  const opposingStatus =
    operation === WALLET_HOLD_OPERATION.CAPTURE ? HOLD_STATUS.RELEASED : HOLD_STATUS.CAPTURED

  if (existing.status === settledStatus) {
    return { ...base, outcome: WALLET_MUTATION.DUPLICATE, duplicateData: existing }
  }

  if (existing.status === opposingStatus) {
    // Capturing a released hold would charge for a purchase we already gave
    // back; releasing a captured one would hand back money already spent on a
    // delivered order. Neither may be papered over.
    return { ...base, outcome: WALLET_MUTATION.CONFLICT, duplicateData: existing }
  }

  const holdUnits = toMoneyUnits(existing.amount, 0)
  const nextHeldUnits = Math.max(0, heldUnits - holdUnits)
  // Only a capture moves the balance. A release just stops reserving it.
  const nextBalanceUnits =
    operation === WALLET_HOLD_OPERATION.CAPTURE ? currentBalanceUnits - holdUnits : currentBalanceUnits
  const nextBalance = fromMoneyUnits(nextBalanceUnits, 0)

  return {
    ...base,
    outcome: WALLET_MUTATION.COMMIT,
    nextBalance,
    heldBalance: fromMoneyUnits(nextHeldUnits, 0),
    availableBalance: fromMoneyUnits(nextBalanceUnits - nextHeldUnits, 0),
    wallet: {
      ...wallet,
      balance: nextBalance,
      heldBalance: fromMoneyUnits(nextHeldUnits, 0),
      updatedAt: now,
      holds: trimSettledHolds(
        {
          ...holds,
          [holdId]: {
            ...existing,
            status: settledStatus,
            settledReason: String(reason || "").trim() || existing.settledReason || null,
            updatedAt: now,
          },
        },
        historyLimit,
      ),
    },
  }
}

/** Spendable balance: what is in the wallet, less what is already reserved. */
export function getAvailableWalletBalance(wallet = {}) {
  const source = wallet && typeof wallet === "object" ? wallet : {}
  const balanceUnits = toMoneyUnits(toMoneyNumber(source.balance, 0), 0)
  const heldUnits = sumActiveHoldUnits(readHolds(source))
  return fromMoneyUnits(balanceUnits - heldUnits, 0)
}

/** Reserved total, recomputed from the holds rather than the stored mirror. */
export function getHeldWalletBalance(wallet = {}) {
  const source = wallet && typeof wallet === "object" ? wallet : {}
  return fromMoneyUnits(sumActiveHoldUnits(readHolds(source)), 0)
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

  // Guarded against the SPENDABLE balance, not the raw one: funds already
  // reserved for an in-flight purchase are not available to a second debit, or
  // the same money would be committed twice.
  const heldUnits = sumActiveHoldUnits(readHolds(wallet))
  if (requireSufficient && currentBalanceUnits + deltaUnits - heldUnits < 0) {
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
