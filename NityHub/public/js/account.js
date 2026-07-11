(function accountPage() {
  const app = window.NityHubApp;
  if (!app) {
    return;
  }

  app.bindHeader("account");

  const nameInput = document.getElementById("account-name-input");
  const phoneInput = document.getElementById("account-phone-input");
  const emailCardEl = document.getElementById("account-email-card");
  const joinedEl = document.getElementById("account-joined");
  const walletEl = document.getElementById("account-wallet");
  const saveBtn = document.getElementById("save-account-btn");

  let currentUser = null;

  function setField(target, value) {
    if (!target) {
      return;
    }

    if ("value" in target) {
      target.value = value;
      return;
    }

    target.textContent = value;
  }

  async function loadProfile() {
    const profile = await app.getUserProfile();
    const wallet = await app.getWalletBalance();
    const email = profile.email || currentUser.email || "-";
    const joined = profile.createdAt ? app.formatDate(profile.createdAt) : "-";

    nameInput.value = profile.username || currentUser.displayName || "";
    phoneInput.value = profile.phone || "";
    setField(emailCardEl, email);
    setField(joinedEl, joined);
    setField(walletEl, app.formatMoney(wallet));
  }

  async function saveProfile() {
    const username = String(nameInput.value || "").trim();
    const phone = app.normalizePhone(phoneInput.value);

    if (!username || username.length < 2) {
      app.setPageNotice("Enter a valid username.", "bad");
      return;
    }

    if (phone.length !== 10) {
      app.setPageNotice("Enter a valid 10-digit phone number.", "bad");
      return;
    }

    saveBtn.disabled = true;
    app.setPageNotice("Saving account details...", "");

    try {
      await app.apiRequest(
        "/api/me/profile",
        {
          method: "PATCH",
          body: JSON.stringify({ username, phone }),
        },
        true,
      );

      phoneInput.value = phone;
      app.setPageNotice("Account updated.", "good");
      await loadProfile();
    } catch (error) {
      app.setPageNotice(error.message || "Failed to save account.", "bad");
    } finally {
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener("click", saveProfile);

  app.requireUser()
    .then(async (user) => {
      currentUser = user;
      await loadProfile();
    })
    .catch(() => {
      // Redirect handled by requireUser.
    });
})();