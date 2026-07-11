(function bootstrapApiBase() {
  const hostedApiBase = "https://nityhub.onrender.com";
  const localApiBase = window.__NITYHUB_LOCAL_API_BASE__ || "http://localhost:3000";
  const currentHost =
    typeof window !== "undefined" && typeof window.location?.hostname === "string"
      ? window.location.hostname.toLowerCase()
      : "";
  const detectedOrigin =
    typeof window !== "undefined" &&
    typeof window.location?.origin === "string" &&
    /^https?:/i.test(window.location.origin)
      ? window.location.origin
      : hostedApiBase;
  const isLocalHost = currentHost === "localhost" || currentHost === "127.0.0.1";
  const isApiHost = currentHost === "nityhub.onrender.com";
  const resolvedDefaultOrigin = isLocalHost ? localApiBase : hostedApiBase;
  const resolvedApiBase = isLocalHost
    ? localApiBase
    : isApiHost
      ? detectedOrigin
      : hostedApiBase;

  window.__NITYHUB_DEFAULT_ORIGIN__ = String(
    window.__NITYHUB_DEFAULT_ORIGIN__ || resolvedDefaultOrigin
  ).replace(/\/$/, "");

  window.__NITYHUB_API_BASE__ = String(
    window.__NITYHUB_API_BASE__ || resolvedApiBase
  ).replace(/\/$/, "");
})();