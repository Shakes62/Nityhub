(function setAppConfig() {
  const fallbackOrigin = window.__NITYHUB_DEFAULT_ORIGIN__ || "https://nityhub.onrender.com";
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
      : fallbackOrigin;
  const isLocalHost = currentHost === "localhost" || currentHost === "127.0.0.1";
  const isApiHost = currentHost === "nityhub.onrender.com";

  const API_BASE =
    window.__NITYHUB_API_BASE__ ||
    (isLocalHost ? localApiBase : isApiHost ? detectedOrigin : fallbackOrigin);

  window.NityHubConfig = {
    ...(window.NityHubConfig || {}),
    apiBase: API_BASE.replace(/\/$/, ""),
    firebase: {
      apiKey: "AIzaSyC75ji7WqBFoeHvw0bcpr809xoA8WYW4xA",
      authDomain: "wisedata-d239b.firebaseapp.com",
      databaseURL: "https://wisedata-d239b-default-rtdb.firebaseio.com",
      projectId: "wisedata-d239b",
      storageBucket: "wisedata-d239b.firebasestorage.app",
      messagingSenderId: "67624259724",
      appId: "1:67624259724:web:1692ec94b2d31bdf6f2ba9",
    },
  };
})();