(function afaPage() {
  const app = window.NityHubApp;
  if (!app) {
    return;
  }

  app.bindHeader("afa");

  const form = document.getElementById("afa-form");
  const feeEl = document.getElementById("afa-fee");
  const walletEl = document.getElementById("afa-wallet");
  const listBody = document.getElementById("afa-rows");
  const submitBtn = document.getElementById("afa-submit");

  let currentUser = null;

  async function loadFee() {
    try {
      const response = await app.apiRequest("/api/afa/fee");
      feeEl.textContent = app.formatMoney(response.data.fee);
    } catch (error) {
      feeEl.textContent = app.formatMoney(6);
    }
  }

  async function refreshWallet() {
    const balance = await app.getWalletBalance();
    walletEl.textContent = app.formatMoney(balance);
  }

  async function loadRegistrations() {
    const response = await app.apiRequest("/api/me/afa-registrations?limit=30", {}, true);
    const rows = Array.isArray(response.data) ? response.data : [];

    if (!rows.length) {
      listBody.innerHTML = "<tr><td colspan='5' class='muted'>No registrations yet.</td></tr>";
      return;
    }

    listBody.innerHTML = rows
      .map((item) => {
        return `
          <tr>
            <td>${app.escapeHtml(item.fullname || "-")}</td>
            <td>${app.escapeHtml(item.phone || "-")}</td>
            <td>${app.escapeHtml(item.location || "-")}</td>
            <td>${app.formatMoney(item.fee || 0)}</td>
            <td>${app.formatDate(item.timestamp)}</td>
          </tr>
        `;
      })
      .join("");
  }

  async function submitRegistration(event) {
    event.preventDefault();

    const payload = {
      fullname: form.fullname.value.trim(),
      phone: app.normalizePhone(form.phone.value),
      dob: form.dob.value,
      ghanaCard: form.ghanaCard.value.trim(),
      location: form.location.value.trim(),
    };

    if (!payload.fullname || payload.phone.length !== 10 || !payload.dob || !payload.ghanaCard || !payload.location) {
      app.setPageNotice("Fill all required fields with valid values.", "bad");
      return;
    }

    submitBtn.disabled = true;
    app.setPageNotice("Submitting AFA registration...", "");

    try {
      await app.apiRequest(
        "/api/afa/register",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        true,
      );

      app.setPageNotice("AFA registration completed.", "good");
      form.reset();
      await refreshWallet();
      await loadRegistrations();
    } catch (error) {
      app.setPageNotice(error.message || "Failed to complete registration.", "bad");
    } finally {
      submitBtn.disabled = false;
    }
  }

  form.addEventListener("submit", submitRegistration);

  app.requireUser()
    .then(async (user) => {
      currentUser = user;
      await loadFee();
      await refreshWallet();
      await loadRegistrations();
    })
    .catch(() => {
      // Redirect handled by requireUser.
    });
})();