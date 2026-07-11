(function homePage() {
  const app = window.NityHubApp;
  if (!app) {
    return;
  }

  app.bindHeader("home");

  const walletEl = document.getElementById("home-wallet");
  const ordersEl = document.getElementById("home-orders");
  const salesEl = document.getElementById("home-sales");
  const totalOrdersEl = document.getElementById("home-total-orders");
  const totalSalesEl = document.getElementById("home-total-sales");

  function setText(target, value) {
    if (target) {
      target.textContent = value;
    }
  }

  async function loadUserStats() {
    const data = await app.getDashboardData();
    setText(walletEl, app.formatMoney(data.balance || 0));
    setText(ordersEl, String(Number(data.todayOrders || 0)));
    setText(salesEl, app.formatMoney(data.todaySales || 0));
    setText(totalOrdersEl, String(Number(data.ordersCount || 0)));
    setText(totalSalesEl, app.formatMoney(data.totalSales || 0));
  }

  app.requireUser()
    .then(async () => {
      document.body.classList.remove("auth-gated-page");
      await loadUserStats();
    })
    .catch((error) => {
      if (error && error.message === "AUTH_REQUIRED") {
        return;
      }

      document.body.classList.remove("auth-gated-page");
      app.setPageNotice(error.message || "Failed to load dashboard.", "bad");
    });
})();