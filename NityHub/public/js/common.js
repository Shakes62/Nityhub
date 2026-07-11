(function initCommon() {
  const firebaseCtx = window.NityHubFirebase;
  if (!firebaseCtx) {
    return;
  }

  const auth = firebaseCtx.auth;
  const db = firebaseCtx.db;
  const moneyFormatter = new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: "GHS",
    minimumFractionDigits: 2,
  });
  let noticeTimer = null;
  let notifierPromise = null;
  let notifier = null;
  let activeNotice = null;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizePhone(value) {
    return String(value || "").replace(/\D/g, "").slice(-10);
  }

  function formatMoney(value) {
    return moneyFormatter.format(Number(value || 0));
  }

  function formatDate(value) {
    const ts = Number(value || 0);
    if (!ts) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  }

  function renderInlineNotice(text, type) {
    const el = document.getElementById("page-notice");
    if (!el) {
      return;
    }

    if (noticeTimer) {
      window.clearTimeout(noticeTimer);
      noticeTimer = null;
    }

    el.textContent = text || "";
    el.className = "notice";

    if (!text) {
      el.classList.add("hidden");
      return;
    }

    if (type === "good") {
      el.classList.add("good");
    }

    if (type === "bad") {
      el.classList.add("bad");
    }

    el.classList.remove("hidden");

    if (type === "good" || type === "bad") {
      noticeTimer = window.setTimeout(() => {
        renderInlineNotice("", "");
      }, 3600);
    }
  }

  function ensureNotifier() {
    if (notifier) {
      return Promise.resolve(notifier);
    }

    if (!notifierPromise) {
      if (!document.getElementById("notyf-stylesheet")) {
        const styleLink = document.createElement("link");
        styleLink.id = "notyf-stylesheet";
        styleLink.rel = "stylesheet";
        styleLink.href = "https://cdn.jsdelivr.net/npm/notyf@3/notyf.min.css";
        document.head.appendChild(styleLink);
      }

      notifierPromise = new Promise((resolve) => {
        const finish = () => {
          if (!window.Notyf) {
            resolve(null);
            return;
          }

          if (!notifier) {
            notifier = new window.Notyf({
              duration: 3600,
              ripple: false,
              position: { x: "right", y: "top" },
              dismissible: false,
              types: [
                {
                  type: "success",
                  className: "nityhub-notyf-success",
                  background: "#ffffff",
                  icon: false,
                  duration: 3400,
                },
                {
                  type: "error",
                  className: "nityhub-notyf-error",
                  background: "#ffffff",
                  icon: false,
                  duration: 3800,
                },
                {
                  type: "info",
                  className: "nityhub-notyf-info",
                  background: "#ffffff",
                  icon: false,
                  duration: 3200,
                },
              ],
            });
          }

          resolve(notifier);
        };

        if (window.Notyf) {
          finish();
          return;
        }

        let script = document.getElementById("notyf-script");
        if (!script) {
          script = document.createElement("script");
          script.id = "notyf-script";
          script.src = "https://cdn.jsdelivr.net/npm/notyf@3/notyf.min.js";
          script.async = true;
          script.addEventListener(
            "load",
            () => {
              script.dataset.ready = "true";
              finish();
            },
            { once: true },
          );
          script.addEventListener("error", () => resolve(null), { once: true });
          document.head.appendChild(script);
          return;
        }

        if (script.dataset.ready === "true" && window.Notyf) {
          finish();
          return;
        }

        script.addEventListener(
          "load",
          () => {
            script.dataset.ready = "true";
            finish();
          },
          { once: true },
        );
        script.addEventListener("error", () => resolve(null), { once: true });
      });
    }

    return notifierPromise;
  }

  function dismissToast() {
    if (!notifier) {
      return;
    }

    if (typeof notifier.dismissAll === "function") {
      notifier.dismissAll();
    } else if (activeNotice && typeof notifier.dismiss === "function") {
      notifier.dismiss(activeNotice);
    }

    activeNotice = null;
  }

  function setPageNotice(text, type) {
    renderInlineNotice("", "");

    if (!text) {
      dismissToast();
      return;
    }

    ensureNotifier()
      .then((instance) => {
        if (!instance) {
          renderInlineNotice(text, type);
          return;
        }

        dismissToast();
        const noticeType = type === "good" ? "success" : type === "bad" ? "error" : "info";
        activeNotice = instance.open({
          type: noticeType,
          message: String(text || ""),
        });
      })
      .catch(() => {
        renderInlineNotice(text, type);
      });
  }

  async function confirmAction(options) {
    const settings = options || {};
    if (window.Swal) {
      const result = await window.Swal.fire({
        title: settings.title || "Continue?",
        text: settings.text || "",
        icon: settings.icon || "question",
        showCancelButton: true,
        confirmButtonText: settings.confirmText || "Continue",
        cancelButtonText: settings.cancelText || "Cancel",
      });
      return result.isConfirmed;
    }

    return window.confirm(settings.text || settings.title || "Continue?");
  }

  function csvDownload(filename, rows) {
    const content = rows
      .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function apiRequest(path, options, withToken) {
    const req = Object.assign({ method: "GET" }, options || {});
    const headers = Object.assign({}, req.headers || {});

    if (req.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    headers["X-Request-Timestamp"] = Date.now().toString();
    headers["X-Requested-With"] = "NityHubWeb";

    if (withToken) {
      const user = auth.currentUser;
      if (!user) {
        throw new Error("Not logged in");
      }

      const token = await user.getIdToken();
      headers.Authorization = `Bearer ${token}`;
    }

    req.headers = headers;

    const base = String(window.NityHubConfig?.apiBase || "").replace(/\/$/, "");
    const target = /^https?:/i.test(path) ? path : `${base}${path}`;
    const response = await fetch(target, req);

    const rawBody = await response.text();
    let payload = null;
    try {
      payload = rawBody ? JSON.parse(rawBody) : null;
    } catch (error) {
      const looksLikeHtml = /^\s*</.test(rawBody || "");
      const message = looksLikeHtml
        ? `Invalid server response from ${base || target}. Check the frontend API base URL and CORS configuration.`
        : "Invalid server response";
      const parseError = new Error(message);
      parseError.status = response.status;
      parseError.responseText = rawBody.slice(0, 300);
      throw parseError;
    }

    if (!response.ok || payload.status === "error") {
      const error = new Error(payload.message || `Request failed (${response.status})`);
      error.payload = payload;
      error.status = response.status;
      throw error;
    }

    return payload;
  }

  function waitForAuthState() {
    return new Promise((resolve) => {
      const unsubscribe = auth.onAuthStateChanged((user) => {
        unsubscribe();
        resolve(user);
      });
    });
  }

  async function requireUser() {
    const user = await waitForAuthState();
    if (!user) {
      window.location.href = "/auth.html";
      throw new Error("AUTH_REQUIRED");
    }
    return user;
  }

  async function getUserProfile() {
    const response = await apiRequest("/api/me/profile", {}, true);
    return response.data || {};
  }

  async function getMyRole() {
    const response = await apiRequest("/api/me/role", {}, true);
    return response.data || { agent: false, admin: false, privileged: false, pricingTier: "user" };
  }

  async function getWalletData(limit) {
    const query = Number(limit || 0) > 0 ? `?limit=${Number(limit)}` : "";
    const response = await apiRequest(`/api/me/wallet${query}`, {}, true);
    return response.data || { balance: 0, transactions: [] };
  }

  async function getWalletBalance() {
    const data = await getWalletData(1);
    return Number(data.balance || 0);
  }

  async function getUserOrders(limit) {
    const query = Number(limit || 0) > 0 ? `?limit=${Number(limit)}` : "";
    const response = await apiRequest(`/api/me/orders${query}`, {}, true);
    return Array.isArray(response.data) ? response.data : [];
  }

  async function getDashboardData() {
    const response = await apiRequest("/api/me/dashboard", {}, true);
    return response.data || {};
  }

  async function isAdminUser() {
    const role = await getMyRole();
    return role.admin === true;
  }

  function bindHeader(activePage) {
    const nav = document.querySelectorAll("[data-page]");
    nav.forEach((item) => {
      item.classList.toggle("active", item.dataset.page === activePage);
    });

    const logoutButtons = document.querySelectorAll("[data-action='logout']");
    logoutButtons.forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        await auth.signOut();
        window.location.href = "/auth.html";
      });
    });

    const userChips = document.querySelectorAll("[data-user-chip]");
    const loginLinks = document.querySelectorAll("[data-login-link]");

    auth.onAuthStateChanged(async (user) => {
      if (!user) {
        userChips.forEach((chip) => {
          chip.textContent = "Guest";
        });
        loginLinks.forEach((entry) => entry.classList.remove("hidden"));
        logoutButtons.forEach((entry) => entry.classList.add("hidden"));
        return;
      }

      let displayName = user.email || "User";
      try {
        const profile = await getUserProfile();
        displayName = profile.username || user.email || "User";
      } catch (error) {
        displayName = user.email || "User";
      }

      userChips.forEach((chip) => {
        chip.textContent = displayName;
      });
      loginLinks.forEach((entry) => entry.classList.add("hidden"));
      logoutButtons.forEach((entry) => entry.classList.remove("hidden"));
    });
  }

  ensureNotifier().catch(() => {
    // Inline notice fallback remains available if Notyf cannot load.
  });

  window.NityHubApp = {
    apiRequest,
    auth,
    bindHeader,
    confirmAction,
    csvDownload,
    db,
    escapeHtml,
    formatDate,
    formatMoney,
    getDashboardData,
    getMyRole,
    getUserProfile,
    getUserOrders,
    getWalletData,
    getWalletBalance,
    isAdminUser,
    normalizePhone,
    requireUser,
    setPageNotice,
    waitForAuthState,
  };
})();