import { CONFIG } from "./config.js"
import { logger } from "./logger.js"

// In-memory processed-transaction cache (dedupe + short-term metadata store).
class TransactionStore {
  constructor() {
    this._store = new Map()
    this._maxAge = 6 * 60 * 60 * 1000
    this._maxSize = 2000
    this.setupPeriodicCleanup()
  }

  setupPeriodicCleanup() {
    setInterval(() => {
      this.cleanup()
      this.memoryCleanup()
    }, CONFIG.cacheCleanupInterval)
  }

  memoryCleanup() {
    if (this._store.size > this._maxSize) {
      const entries = Array.from(this._store.entries())
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
      const toDelete = entries.slice(0, this._store.size - this._maxSize)
      toDelete.forEach(([key]) => this._store.delete(key))
    }
  }

  has(reference) {
    return this._store.has(reference)
  }

  add(reference, metadata = {}) {
    this._store.set(reference, {
      timestamp: Date.now(),
      ...metadata,
    })
    return this
  }

  get(reference) {
    return this._store.get(reference)
  }

  cleanup(maxAgeMs = this._maxAge) {
    const now = Date.now()
    let count = 0

    for (const [reference, metadata] of this._store.entries()) {
      if (now - metadata.timestamp > maxAgeMs) {
        this._store.delete(reference)
        count++
      }
    }

    return count
  }
}

export const processedTransactions = new TransactionStore()

// Duplicate attempt monitoring
export const duplicateAttempts = new Map()
const MAX_DUPLICATE_ATTEMPTS = 5
export const DUPLICATE_ATTEMPT_WINDOW = 10 * 60 * 1000 // 10 minutes

export function recordDuplicateAttempt(identifier, type = 'transaction') {
  const key = `${type}_${identifier}`
  const now = Date.now()

  if (!duplicateAttempts.has(key)) {
    duplicateAttempts.set(key, [])
  }

  const attempts = duplicateAttempts.get(key)
  attempts.push(now)

  // Keep only attempts within the window
  const validAttempts = attempts.filter(time => now - time < DUPLICATE_ATTEMPT_WINDOW)
  duplicateAttempts.set(key, validAttempts)

  // Log suspicious activity
  if (validAttempts.length >= MAX_DUPLICATE_ATTEMPTS) {
    logger.error("SUSPICIOUS DUPLICATE ATTEMPTS DETECTED", {
      identifier,
      type,
      attempts: validAttempts.length,
      window: DUPLICATE_ATTEMPT_WINDOW,
      timestamp: new Date().toISOString(),
    })
  }

  return validAttempts.length
}

export function checkDuplicateAttempts(identifier, type = 'transaction') {
  const key = `${type}_${identifier}`
  const attempts = duplicateAttempts.get(key) || []
  const now = Date.now()
  const validAttempts = attempts.filter(time => now - time < DUPLICATE_ATTEMPT_WINDOW)

  return {
    count: validAttempts.length,
    isSuspicious: validAttempts.length >= MAX_DUPLICATE_ATTEMPTS,
    lastAttempt: validAttempts.length > 0 ? validAttempts[validAttempts.length - 1] : null
  }
}

// Enhanced transaction locking mechanism with multiple lock types
export const transactionLocks = new Map()
export const phoneTransactionLocks = new Map()
export const userTransactionLocks = new Map()

export function acquireTransactionLock(reference, timeout = 30000) {
  if (transactionLocks.has(reference)) {
    const lockTime = transactionLocks.get(reference)
    if (Date.now() - lockTime < timeout) {
      return false // Lock still active
    }
  }

  transactionLocks.set(reference, Date.now())
  return true
}

export function acquirePhoneTransactionLock(phone, volume, network, timeout = 45000) {
  const phoneKey = `${phone}_${volume}_${network}`
  if (phoneTransactionLocks.has(phoneKey)) {
    const lockTime = phoneTransactionLocks.get(phoneKey)
    if (Date.now() - lockTime < timeout) {
      return false // Lock still active for this phone+volume+network
    }
  }

  phoneTransactionLocks.set(phoneKey, Date.now())
  return true
}

export function acquireUserTransactionLock(userId, timeout = 30000) {
  if (userTransactionLocks.has(userId)) {
    const lockTime = userTransactionLocks.get(userId)
    if (Date.now() - lockTime < timeout) {
      return false // User has active transaction
    }
  }

  userTransactionLocks.set(userId, Date.now())
  return true
}

export function releaseTransactionLock(reference) {
  transactionLocks.delete(reference)
}

export function releasePhoneTransactionLock(phone, volume, network) {
  const phoneKey = `${phone}_${volume}_${network}`
  phoneTransactionLocks.delete(phoneKey)
}

export function releaseUserTransactionLock(userId) {
  userTransactionLocks.delete(userId)
}

// Cleanup expired locks periodically
setInterval(() => {
  const now = Date.now()
  const timeout = 30000 // 30 seconds
  const phoneTimeout = 45000 // 45 seconds for phone locks

  // Cleanup transaction locks
  for (const [reference, lockTime] of transactionLocks.entries()) {
    if (now - lockTime > timeout) {
      transactionLocks.delete(reference)
    }
  }

  // Cleanup phone transaction locks
  for (const [phoneKey, lockTime] of phoneTransactionLocks.entries()) {
    if (now - lockTime > phoneTimeout) {
      phoneTransactionLocks.delete(phoneKey)
    }
  }

  // Cleanup user transaction locks
  for (const [userId, lockTime] of userTransactionLocks.entries()) {
    if (now - lockTime > timeout) {
      userTransactionLocks.delete(userId)
    }
  }
}, 60000) // Run every minute
