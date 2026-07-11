(function ordersPage() {
  const app = window.NityHubApp;
  if (!app) {
    return;
  }

  app.bindHeader("orders");

  const tbody = document.getElementById("orders-body");
  const searchInput = document.getElementById("order-search");
  const reportNumber = "233593554394";

  let allRows = [];

  function statusClass(status) {
    const value = String(status || "").toLowerCase();
    if (value === "completed" || value === "delivered") return "tag success";
    if (value === "accepted") return "tag info";
    if (value === "pending" || value === "processing") return "tag warn";
    return "tag fail";
  }

  function statusLabel(status) {
    const value = String(status || "").trim().replace(/_/g, " ");
    if (!value) return "Unknown";
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function shortRef(value) {
    const ref = String(value || "");
    return ref || "-";
  }

  function buildReportLink(item) {
    const lines = [
      "Hello, I want to report an order.",
      `Reference: ${item.reference || "-"}`,
      `Network: ${String(item.network || "-").toUpperCase()}`,
      `Phone: ${item.phone || "-"}`,
      `Bundle: ${item.label || `${item.volume || "-"}MB`}`,
      `Amount: ${app.formatMoney(item.amount || 0)}`,
      `Status: ${statusLabel(item.status)}`,
      `Date: ${app.formatDate(item.timestamp || item.createdAt)}`,
    ];

    return `https://wa.me/${reportNumber}?text=${encodeURIComponent(lines.join("\n"))}`;
  }

  function renderRows(rows) {
    if (!rows.length) {
      tbody.innerHTML = "<tr><td colspan='8' class='muted'>No orders found.</td></tr>";
      return;
    }

    tbody.innerHTML = rows
      .map((item) => {
        const volumeText = item.label || `${item.volume || "-"}MB`;
        return `
          <tr>
            <td title="${app.escapeHtml(item.reference || "")}">${app.escapeHtml(shortRef(item.reference))}</td>
            <td>${app.escapeHtml(String(item.network || "-").toUpperCase())}</td>
            <td>${app.escapeHtml(item.phone || "-")}</td>
            <td>${app.escapeHtml(volumeText)}</td>
            <td>${app.formatMoney(item.amount || 0)}</td>
            <td><span class="${statusClass(item.status)}">${app.escapeHtml(statusLabel(item.status))}</span></td>
            <td>${app.formatDate(item.timestamp || item.createdAt)}</td>
            <td class="table-action-cell">
              <a class="btn subtle table-action-btn" href="${buildReportLink(item)}" target="_blank" rel="noopener noreferrer">Report</a>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function applyFilters() {
    const search = String(searchInput.value || "").trim().toLowerCase();

    const filtered = allRows.filter((row) => {
      const rowRef = String(row.reference || "").toLowerCase();
      const rowPhone = String(row.phone || "").toLowerCase();

      if (search && !rowRef.includes(search) && !rowPhone.includes(search)) return false;
      return true;
    });

    renderRows(filtered);
  }

  searchInput.addEventListener("input", applyFilters);

  app.requireUser()
    .then(async () => {
      allRows = await app.getUserOrders(200);
      applyFilters();
    })
    .catch(() => {
      // Redirect handled by requireUser.
    });
})();