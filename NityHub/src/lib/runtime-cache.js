// In-process caches (switchboard, store lookups, banners, rate-limit windows)
// register a reset here. Production never needs it - every cache has a short
// TTL - but tests call resetRuntimeCaches() so one case cannot see another's
// cached state after the database is reset.

const resetters = new Set()

export function registerCacheReset(reset) {
  if (typeof reset === "function") resetters.add(reset)
}

export function resetRuntimeCaches() {
  for (const reset of resetters) reset()
}
