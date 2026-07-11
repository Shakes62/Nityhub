(function walletPage() {
  const app = window.NityHubApp;
  if (!app) {
    return;
  }

  app.bindHeader("wallet");

  const balanceEl = document.getElementById("wallet-balance");
  const amountInput = document.getElementById("deposit-amount");
  const depositBtn = document.getElementById("deposit-btn");
  const listBody = document.getElementById("wallet-transactions");

  let currentUser = null;

  async function refreshWalletData() {
    const wallet = await app.getWalletData(50);
    balanceEl.textContent = app.formatMoney(wallet.balance || 0);
    renderTransactions(Array.isArray(wallet.transactions) ? wallet.transactions : []);
  }

  function renderTransactions(rows) {
    if (!rows.length) {
      listBody.innerHTML = "<tr><td colspan='5' class='muted'>No transactions.</td></tr>";
      return;
    }

    const shortRef = (value) => {
      const ref = String(value || "");
      if (ref.length <= 14) return ref || "-";
      return `${ref.slice(0, 10)}...`;
    };

    listBody.innerHTML = rows
      .map((item) => {
        const amount = Number(item.amount || 0);
        const amountText = amount >= 0 ? `+${app.formatMoney(amount)}` : `-${app.formatMoney(Math.abs(amount))}`;
        const amountClass = amount >= 0 ? "tag success" : "tag fail";
        const reference = item.reference || item.details?.reference || "-";

        return `
          <tr>
            <td title="${app.escapeHtml(reference)}">${app.escapeHtml(shortRef(reference))}</td>
            <td>${app.escapeHtml(item.type || "transaction")}</td>
            <td><span class="${amountClass}">${amountText}</span></td>
            <td>${app.formatMoney(item.balance || 0)}</td>
            <td>${app.formatDate(item.timestamp)}</td>
          </tr>
        `;
      })
      .join("");
  }

  async function applyDepositFromCallback() {
    const url = new URL(window.location.href);
    const reference = url.searchParams.get("reference") || url.searchParams.get("trxref");
    if (!reference) {
      return;
    }

    app.setPageNotice("Confirming payment...", "");

    try {
      await app.apiRequest(
        "/api/wallet/credit-deposit",
        {
          method: "POST",
          body: JSON.stringify({ reference }),
        },
        true,
      );

      app.setPageNotice("Deposit confirmed and added to wallet.", "good");
      url.search = "";
      window.history.replaceState({}, document.title, url.pathname);
      await refreshWalletData();
    } catch (error) {
      app.setPageNotice(error.message || "Failed to confirm deposit.", "bad");
    }
  }

  async function startDeposit() {
    const amount = Number(amountInput.value || 0);
    if (!amount || amount < 1) {
      app.setPageNotice("Enter a valid amount (minimum 1).", "bad");
      return;
    }

    depositBtn.disabled = true;
    app.setPageNotice("Starting secure payment...", "");

    try {
      const response = await app.apiRequest("/api/initiate-payment", {
        method: "POST",
        body: JSON.stringify({
          paymentType: "wallet",
          amount,
          reference: `WALLET_${Date.now()}_${currentUser.uid.slice(0, 6)}`,
        }),
      }, true);

      if (!response.data || !response.data.authorization_url) {
        throw new Error("Could not start payment.");
      }

      window.location.href = response.data.authorization_url;
    } catch (error) {
      app.setPageNotice(error.message || "Failed to start deposit.", "bad");
      depositBtn.disabled = false;
    }
  }

  depositBtn.addEventListener("click", startDeposit);

  app.requireUser()
    .then(async (user) => {
      currentUser = user;
      await refreshWalletData();
      await applyDepositFromCallback();
    })
    .catch(() => {
      // Redirect handled by requireUser.
    });
})();