import { CONFIG } from "./config.js"

// Enhanced logging utility. Quiet under the test runner unless TEST_LOGS=1, so
// expected failure paths in integration tests do not drown the results.
const quiet = process.env.NODE_ENV === "test" && process.env.TEST_LOGS !== "1"

export const logger = {
  info: (message, data = {}) => {
    if (quiet) return
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, data)
  },
  error: (message, error = {}, data = {}) => {
    if (quiet) return
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, {
      error: error.message || error,
      stack: error.stack,
      ...data,
    })
  },
  warn: (message, data = {}) => {
    if (quiet) return
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, data)
  },
  debug: (message, data = {}) => {
    if (CONFIG.nodeEnv === "development") {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, data)
    }
  },
}
