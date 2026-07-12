// Application error helpers shared across the backend.

export function createAppError(code, details = {}) {
  const error = new Error(code)
  error.code = code
  Object.assign(error, details)
  return error
}

export function getErrorCode(error) {
  return String(error?.code || error?.message || "").trim()
}

export function parseJsonText(text, fallback = {}) {
  if (!text) {
    return fallback
  }

  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}
