(function setupLayout() {
  const toggle = document.getElementById("menu-toggle");
  const overlay = document.getElementById("mobile-overlay");
  const closeButtons = document.querySelectorAll("[data-close-menu]");
  const sidebar = document.getElementById("sidebar");
  const mainShell = document.querySelector(".main-shell");
  const mobileTitle = document.querySelector(".mobile-title");
  const pageLabelMap = {
    account: "Profile",
  };
  const navIconMap = {
    home: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3 10.5 12 3l9 7.5"></path>
        <path d="M5 9.5V20h14V9.5"></path>
      </svg>
    `,
    buy: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 7h13l-1.4 7H8.4L7 6H4"></path>
        <circle cx="9.5" cy="18" r="1.2"></circle>
        <circle cx="17" cy="18" r="1.2"></circle>
      </svg>
    `,
    orders: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="5" y="4" width="14" height="16" rx="2"></rect>
        <path d="M9 8h6"></path>
        <path d="M9 12h6"></path>
        <path d="M9 16h4"></path>
      </svg>
    `,
    wallet: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 8.5h14a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8.5Z"></path>
        <path d="M4 8.5V7a2 2 0 0 1 2-2h11"></path>
        <path d="M15 13h5"></path>
      </svg>
    `,
    account: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="8" r="3.5"></circle>
        <path d="M5 19a7 7 0 0 1 14 0"></path>
      </svg>
    `,
    afa: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M7 3h8l4 4v14H7z"></path>
        <path d="M15 3v4h4"></path>
        <path d="M10 12h6"></path>
        <path d="M10 16h6"></path>
      </svg>
    `,
  };

  const menuIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <line x1="4" y1="7" x2="20" y2="7"></line>
      <line x1="4" y1="12" x2="20" y2="12"></line>
      <line x1="4" y1="17" x2="20" y2="17"></line>
    </svg>
  `;

  function closeMenu() {
    document.body.classList.remove("menu-open");
  }

  function openMenu() {
    document.body.classList.add("menu-open");
  }

  if (toggle) {
    toggle.innerHTML = menuIcon;
    toggle.addEventListener("click", () => {
      if (document.body.classList.contains("menu-open")) {
        closeMenu();
      } else {
        openMenu();
      }
    });
  }

  if (mobileTitle) {
    mobileTitle.textContent = "NityHub";
  }

  if (overlay) {
    overlay.addEventListener("click", closeMenu);
  }

  closeButtons.forEach((btn) => {
    btn.addEventListener("click", closeMenu);
  });

  if (sidebar) {
    sidebar.querySelectorAll('.side-nav a[data-page="admin"], [data-admin-link]').forEach((link) => {
      link.remove();
    });

    sidebar.querySelectorAll(".side-nav a[data-page]").forEach((link) => {
      const page = link.dataset.page;
      const firstLabel = link.querySelector("span");
      const rawLabel = firstLabel ? firstLabel.textContent.trim() : link.textContent.trim();
      const label = pageLabelMap[page] || rawLabel;
      const icon = navIconMap[page] || "";
      link.innerHTML = `
        <span class="nav-icon" aria-hidden="true">${icon}</span>
        <span class="nav-label">${label}</span>
      `;
    });

    sidebar.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        if (window.innerWidth < 1024) {
          closeMenu();
        }
      });
    });
  }

  if (mainShell && !mainShell.querySelector(".app-footer")) {
    const footer = document.createElement("footer");
    footer.className = "app-footer";
    footer.innerHTML = `
      <div class="app-footer__inner">
        <div class="app-footer__brand">
          <strong>NityHub</strong>
          <span>Reliable data and wallet flow</span>
        </div>
      </div>
    `;
    mainShell.appendChild(footer);
  }

  window.addEventListener("resize", () => {
    if (window.innerWidth >= 1024) {
      closeMenu();
    }
  });
})();