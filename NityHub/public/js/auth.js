(function authPage() {
  const app = window.NityHubApp;
  if (!app) {
    return;
  }

  const auth = app.auth;

  const tabs = {
    login: document.getElementById("tab-login"),
    signup: document.getElementById("tab-signup"),
    reset: document.getElementById("tab-reset"),
  };

  const forms = {
    login: document.getElementById("form-login"),
    signup: document.getElementById("form-signup"),
    reset: document.getElementById("form-reset"),
  };
  const submitButtons = {
    login: document.getElementById("login-submit-btn"),
    signup: document.getElementById("signup-submit-btn"),
  };

  function setSubmitting(button, isSubmitting, busyText) {
    if (!button) {
      return;
    }

    if (!button.dataset.defaultLabel) {
      button.dataset.defaultLabel = button.textContent.trim();
    }

    button.disabled = isSubmitting;
    button.classList.toggle("is-loading", isSubmitting);
    button.textContent = isSubmitting ? busyText : button.dataset.defaultLabel;
  }

  function showTab(name) {
    Object.keys(forms).forEach((key) => {
      forms[key].classList.toggle("hidden", key !== name);
      tabs[key].classList.toggle("active", key === name);
    });

    app.setPageNotice("", "");
  }

  async function login(event) {
    event.preventDefault();
    const email = forms.login.email.value.trim();
    const password = forms.login.password.value;
    setSubmitting(submitButtons.login, true, "Signing in...");

    try {
      await auth.signInWithEmailAndPassword(email, password);
      window.location.href = "/index.html";
    } catch (error) {
      app.setPageNotice(error.message || "Login failed.", "bad");
    } finally {
      setSubmitting(submitButtons.login, false, "Signing in...");
    }
  }

  async function signup(event) {
    event.preventDefault();

    const username = forms.signup.username.value.trim();
    const email = forms.signup.email.value.trim();
    const phone = app.normalizePhone(forms.signup.phone.value);
    const password = forms.signup.password.value;
    const confirm = forms.signup.confirmPassword.value;

    if (password !== confirm) {
      app.setPageNotice("Passwords do not match.", "bad");
      return;
    }

    if (username.length < 2) {
      app.setPageNotice("Username is too short.", "bad");
      return;
    }

    if (phone.length !== 10) {
      app.setPageNotice("Enter a valid 10-digit phone number.", "bad");
      return;
    }

    setSubmitting(submitButtons.signup, true, "Creating account...");

    try {
      const result = await auth.createUserWithEmailAndPassword(email, password);
      const user = result.user;
      try {
        await app.apiRequest(
          "/api/me/bootstrap",
          {
            method: "POST",
            body: JSON.stringify({ username, phone }),
          },
          true,
        );
      } catch (bootstrapError) {
        await user.delete().catch(() => null);
        throw bootstrapError;
      }

      window.location.href = "/index.html";
    } catch (error) {
      app.setPageNotice(error.message || "Signup failed.", "bad");
    } finally {
      setSubmitting(submitButtons.signup, false, "Creating account...");
    }
  }

  async function resetPassword(event) {
    event.preventDefault();
    const email = forms.reset.email.value.trim();

    try {
      await auth.sendPasswordResetEmail(email);
      app.setPageNotice("Password reset link sent. Check your email.", "good");
      forms.reset.reset();
    } catch (error) {
      app.setPageNotice(error.message || "Reset failed.", "bad");
    }
  }

  tabs.login.addEventListener("click", (event) => {
    event.preventDefault();
    showTab("login");
  });
  tabs.signup.addEventListener("click", (event) => {
    event.preventDefault();
    showTab("signup");
  });
  tabs.reset.addEventListener("click", (event) => {
    event.preventDefault();
    showTab("reset");
  });

  forms.login.addEventListener("submit", login);
  forms.signup.addEventListener("submit", signup);
  forms.reset.addEventListener("submit", resetPassword);

  auth.onAuthStateChanged((user) => {
    if (user) {
      window.location.href = "/index.html";
    }
  });
})();