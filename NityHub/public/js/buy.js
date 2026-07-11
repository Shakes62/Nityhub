(function buyPage() {
  const app = window.NityHubApp;
  if (!app) {
    return;
  }

  app.bindHeader("buy");

  const networkInput = document.getElementById("network-picker");
  const packageGrid = document.getElementById("package-grid");
  const phoneInput = document.getElementById("beneficiary-phone");
  const buyBtn = document.getElementById("buy-btn");
  const walletEl = document.getElementById("buy-wallet");
  const roleEl = document.getElementById("pricing-role");

  let currentUser = null;
  let currentPackages = [];
  let selectedPackage = null;
  let useAgentPricing = false;
  let purchaseInFlight = false;

  async function refreshWallet() {
    const balance = await app.getWalletBalance();
    walletEl.textContent = app.formatMoney(balance);
  }

  function renderPackageButtons() {
    packageGrid.innerHTML = "";

    if (!currentPackages.length) {
      packageGrid.innerHTML = "<div class='empty-state'>No package found for this network.</div>";
      selectedPackage = null;
      return;
    }

    currentPackages.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bundle-btn";
      button.dataset.id = item.id;
      button.innerHTML = `
        <div class="bundle-main">${app.escapeHtml(item.label)}</div>
        <div class="bundle-sub">${app.formatMoney(item.price)}</div>
      `;

      button.addEventListener("click", () => {
        selectedPackage = item;
        app.setPageNotice(
          `${item.label} bundle selected for ${networkInput.value.toUpperCase()} at ${app.formatMoney(item.price)}.`,
          "",
        );
        packageGrid.querySelectorAll(".bundle-btn").forEach((entry) => entry.classList.remove("active"));
        button.classList.add("active");
      });

      packageGrid.appendChild(button);
    });

    selectedPackage = null;
  }

  async function loadPackages(network) {
    const response = await app.apiRequest(`/api/packages/${network}`);
    const rows = Array.isArray(response.data) ? response.data : [];

    currentPackages = rows
      .filter((item) => item.enabled !== false)
      .map((item) => ({
        ...item,
        price: useAgentPricing ? Number(item.agentPrice || item.userPrice || 0) : Number(item.userPrice || 0),
      }))
      .filter((item) => Number(item.price) > 0)
      .sort((a, b) => Number(a.sortOrder || a.volume || 0) - Number(b.sortOrder || b.volume || 0));

    renderPackageButtons();
  }

  async function doPurchase() {
    if (purchaseInFlight) {
      return;
    }

    if (!selectedPackage) {
      app.setPageNotice("Select a package first.", "bad");
      return;
    }

    const phone = app.normalizePhone(phoneInput.value);
    if (phone.length !== 10) {
      app.setPageNotice("Enter a valid 10-digit number.", "bad");
      return;
    }

    purchaseInFlight = true;
    buyBtn.disabled = true;
    app.setPageNotice("Processing order...", "");

    try {
      const response = await app.apiRequest(
        "/api/wallet-purchase",
        {
          method: "POST",
          body: JSON.stringify({
            network: networkInput.value,
            phone,
            packageId: selectedPackage.id,
            volume: selectedPackage.volume,
          }),
        },
        true,
      );

      const reference = response?.data?.reference || `REF_${Date.now()}`;
      const serverMessage =
        response?.message || `Order accepted. We will update the final status shortly. Ref: ${reference}`;
      app.setPageNotice(`${serverMessage} Ref: ${reference}`, "good");
      phoneInput.value = "";
      await refreshWallet();
      await loadPackages(networkInput.value);
    } catch (error) {
      const details = error?.payload || {};
      if (
        details.errorCode === "INSUFFICIENT_WALLET_BALANCE" &&
        Number.isFinite(Number(details.availableBalance)) &&
        Number.isFinite(Number(details.requiredAmount))
      ) {
        app.setPageNotice(
          `Insufficient wallet balance. Available ${app.formatMoney(details.availableBalance)}, required ${app.formatMoney(details.requiredAmount)}.`,
          "bad",
        );
        await refreshWallet();
      } else {
        app.setPageNotice(error.message || "Purchase failed.", "bad");
      }
    } finally {
      purchaseInFlight = false;
      buyBtn.disabled = false;
    }
  }

  networkInput.addEventListener("change", () => {
    loadPackages(networkInput.value).catch((error) => {
      app.setPageNotice(error.message || "Failed to load packages.", "bad");
    });
  });

  phoneInput.addEventListener("blur", () => {
    phoneInput.value = app.normalizePhone(phoneInput.value);
  });

  buyBtn.addEventListener("click", doPurchase);

  app.requireUser()
    .then(async (user) => {
      currentUser = user;
      const role = await app.getMyRole();
      useAgentPricing = role.pricingTier === "agent" || role.privileged === true;
      roleEl.textContent = useAgentPricing ? "Agent Pricing" : "Regular Pricing";
      await refreshWallet();
      await loadPackages(networkInput.value);
    })
    .catch(() => {
      // Redirect handled by requireUser.
    });
})();