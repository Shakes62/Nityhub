import { CONFIG } from "./config.js"

// Enhanced logging utility
export const logger = {
  info: (message, data = {}) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, data)
  },
  error: (message, error = {}, data = {}) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, {
      error: error.message || error,
      stack: error.stack,
      ...data,
    })
  },
  warn: (message, data = {}) => {
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, data)
  },
  debug: (message, data = {}) => {
    if (CONFIG.nodeEnv === "development") {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, data)
    }
  },
}
