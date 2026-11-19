// Import this FIRST in an integration test, then load the app with a dynamic
// import(). It points every import of src/firebase.js at the in-memory fake
// and provides the minimum environment config.js needs.

import { registerHooks } from "node:module"

process.env.NODE_ENV = "test"
process.env.PAYSTACK_SECRET_KEY = "sk_test_integration_secret"
process.env.HUBNET_API_KEY = "hubnet_test_key"
process.env.GODSWAY_API_KEY = "godsway_test_key"
process.env.FRONTEND_URL = "https://shop.example.test"
process.env.STOREFRONT_BASE_DOMAIN = "stores.example.test"
process.env.BLACKLIST_HASH_KEY = "test-blacklist-key"
process.env.HUBNET_STATUS_POLL_MIN_INTERVAL_MS = "0"

const fakeUrl = new URL("./fake-firebase.js", import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    if (result.url.endsWith("/src/firebase.js")) {
      return { ...result, url: fakeUrl, shortCircuit: true }
    }
    return result
  },
})
