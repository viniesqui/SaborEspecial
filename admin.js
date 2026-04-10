(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const SESSION_KEY = "ceep-role-session";
  const els = {
    menuForm: document.getElementById("menuForm"),
    adminSecretInput: document.getElementById("adminSecret"),
    menuSubmitButton: document.getElementById("menuSubmitButton"),
    menuFeedback: document.getElementById("menuFeedback"),
    menuTitleInput: document.getElementById("menuTitleInput"),
    menuDescriptionInput: document.getElementById("menuDescriptionInput"),
    menuPriceInput: document.getElementById("menuPriceInput"),
    exportOrdersButton: document.getElementById("exportOrdersButton"),
    adminUpdatedAt: document.getElementById("adminUpdatedAt"),
    currentMenuTitle: document.getElementById("currentMenuTitle"),
    currentMenuDescription: document.getElementById("currentMenuDescription"),
    currentMenuPrice: document.getElementById("currentMenuPrice"),
    currentAvailableMeals: document.getElementById("currentAvailableMeals"),
    currentSalesWindow: document.getElementById("currentSalesWindow"),
    currentDeliveryWindow: document.getElementById("currentDeliveryWindow"),
    adminOrdersTotal: document.getElementById("adminOrdersTotal"),
    adminOrdersPaid: document.getElementById("adminOrdersPaid"),
    adminOrdersPending: document.getElementById("adminOrdersPending"),
    adminOrdersList: document.getElementById("adminOrdersList"),
    adminOrderRowTemplate: document.getElementById("adminOrderRowTemplate"),
    adminLogoutButton: document.getElementById("adminLogoutButton")
  };

  let isSaving = false;
  let adminSecret = "";

  function formatCurrency(amount) {
    return new Intl.NumberFormat("es-CR", {
      style: "currency",
      currency: "CRC",
      maximumFractionDigits: 0
    }).format(Number(amount || 0));
  }

  function setMenuFeedback(message, isError) {
    els.menuFeedback.textContent = message || "";
    els.menuFeedback.style.color = isError ? "#842f3d" : "#705d52";
  }

  function getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function formatDateTime(value) {
    if (!value) return "Sin datos recientes";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Sin datos recientes";
    return "Actualizado " + new Intl.DateTimeFormat("es-CR", {
      hour: "numeric",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit"
    }).format(date);
  }

  async function fetchJson(path, options) {
    if (!config.apiBaseUrl || config.apiBaseUrl.includes("PEGUE_AQUI")) {
      throw new Error("Debe configurar la URL del backend en config.js");
    }

    const requestOptions = {
      method: options && options.method ? options.method : "GET"
    };

    if (options && options.body) {
      requestOptions.headers = {
        "Content-Type": "application/json"
      };
      requestOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(config.apiBaseUrl + path, requestOptions);
    const payload = await response.json().catch(function () {
      return null;
    });

    if (!response.ok) {
      throw new Error((payload && payload.message) || "No fue posible completar la solicitud.");
    }

    return payload;
  }

  async function downloadFile(path, body, filename) {
    if (!config.apiBaseUrl || config.apiBaseUrl.includes("PEGUE_AQUI")) {
      throw new Error("Debe configurar la URL del backend en config.js");
    }

    const response = await fetch(config.apiBaseUrl + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    });

    if (!response.ok) {
      const maybeJson = await response.json().catch(function () {
        return null;
      });
      throw new Error((maybeJson && maybeJson.message) || "No fue posible exportar el archivo.");
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  }

  function requireAdminSession() {
    const session = getSession();
    if (!session || session.role !== "ADMIN" || !session.password) {
      window.location.replace("./index.html");
      return false;
    }

    adminSecret = session.password;
    els.adminSecretInput.value = session.password;
    return true;
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.replace("./index.html");
  }

  function renderSnapshot(snapshot) {
    const menu = snapshot.menu || {};
    els.adminUpdatedAt.textContent = formatDateTime(snapshot.updatedAt);
    els.currentMenuTitle.textContent = menu.title || "Menú no configurado";
    els.currentMenuDescription.textContent = menu.description || "No hay descripción disponible.";
    els.currentMenuPrice.textContent = formatCurrency(menu.price);
    els.currentAvailableMeals.textContent = String(snapshot.availableMeals || 0);
    els.currentSalesWindow.textContent = snapshot.salesWindow || "-";
    els.currentDeliveryWindow.textContent = snapshot.deliveryWindow || "-";

    if (!isSaving) {
      els.menuTitleInput.value = menu.title || "";
      els.menuDescriptionInput.value = menu.description || "";
      els.menuPriceInput.value = menu.price || "";
    }
  }

  async function refreshSnapshot() {
    try {
      const snapshot = await fetchJson("/dashboard");
      renderSnapshot(snapshot);
    } catch (error) {
      setMenuFeedback(error.message, true);
    }
  }

  function getMethodLabel(method) {
    return String(method || "").toUpperCase() === "SINPE" ? "SINPE" : "EFECTIVO";
  }

  function getPaymentStatusLabel(status) {
    return String(status || "").toUpperCase() === "PAGADO" ? "PAGADO" : "PENDIENTE DE PAGO";
  }

  function getPaymentStatusClass(status) {
    return String(status || "").toUpperCase() === "PAGADO"
      ? "admin-order-status admin-order-status--paid"
      : "admin-order-status admin-order-status--pending";
  }

  function renderAdminOrders(snapshot) {
    els.adminOrdersTotal.textContent = String(snapshot.totalOrders || 0);
    els.adminOrdersPaid.textContent = String(snapshot.paidCount || 0);
    els.adminOrdersPending.textContent = String(snapshot.pendingPaymentCount || 0);
    els.adminOrdersList.innerHTML = "";

    if (!snapshot.orders || snapshot.orders.length === 0) {
      els.adminOrdersList.innerHTML = '<div class="admin-orders-table__empty">No hay pedidos registrados hoy.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    snapshot.orders.forEach(function (order) {
      const node = els.adminOrderRowTemplate.content.cloneNode(true);
      node.querySelector(".admin-order-name").textContent = order.buyerName;
      node.querySelector(".admin-order-meta").textContent = [order.buyerPhone, order.paymentReference].filter(Boolean).join(" | ") || "Sin referencia";
      node.querySelector(".admin-order-date").textContent = order.createdAtLabel || "-";
      node.querySelector(".admin-order-method").textContent = getMethodLabel(order.paymentMethod);

      const statusNode = node.querySelector(".admin-order-status");
      statusNode.textContent = getPaymentStatusLabel(order.paymentStatus);
      statusNode.className = getPaymentStatusClass(order.paymentStatus);

      node.querySelector(".admin-order-confirmed-at").textContent = order.paymentConfirmedAtLabel || "Pendiente";

      node.querySelectorAll(".payment-toggle").forEach(function (button) {
        const isSelected = button.dataset.paymentStatus === order.paymentStatus;
        button.classList.toggle("is-selected", isSelected);
        button.addEventListener("click", function () {
          updatePaymentStatus(order.id, button.dataset.paymentStatus);
        });
      });

      fragment.appendChild(node);
    });

    els.adminOrdersList.appendChild(fragment);
  }

  async function refreshAdminOrders() {
    if (!adminSecret) return;

    try {
      const snapshot = await fetchJson("/admin-orders", {
        method: "POST",
        body: {
          adminSecret,
          action: "list"
        }
      });
      renderAdminOrders(snapshot);
    } catch (error) {
      setMenuFeedback(error.message, true);
    }
  }

  function getMenuPayload() {
    const formData = new FormData(els.menuForm);
    return {
      adminSecret: String(formData.get("adminSecret") || "").trim(),
      title: String(formData.get("title") || "").trim(),
      description: String(formData.get("description") || "").trim(),
      price: Number(formData.get("price") || 0)
    };
  }

  async function submitMenu(event) {
    event.preventDefault();

    if (isSaving) return;

    const payload = getMenuPayload();
    payload.adminSecret = adminSecret;

    if (!payload.adminSecret || !payload.title || !payload.description || payload.price < 0) {
      setMenuFeedback("Complete la clave, el nombre, la descripcion y el precio.", true);
      return;
    }

    isSaving = true;
    els.menuSubmitButton.disabled = true;
    setMenuFeedback("Guardando menú del día...", false);

    try {
      const result = await fetchJson("/menu", {
        method: "POST",
        body: {
          adminSecret: payload.adminSecret,
          menu: {
            title: payload.title,
            description: payload.description,
            price: payload.price
          }
        }
      });

      setMenuFeedback(result.message || "Menú actualizado correctamente.", false);
      if (result.snapshot) {
        renderSnapshot(result.snapshot);
      } else {
        await refreshSnapshot();
      }
      await refreshAdminOrders();
    } catch (error) {
      setMenuFeedback(error.message, true);
    } finally {
      isSaving = false;
      els.menuSubmitButton.disabled = false;
    }
  }

  async function exportOrders() {
    if (!adminSecret) {
      setMenuFeedback("Primero ingrese con la clave administrativa.", true);
      return;
    }

    els.exportOrdersButton.disabled = true;
    setMenuFeedback("Exportando pedidos...", false);

    try {
      const now = new Date();
      const fileDate = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
      ].join("-");

      await downloadFile("/orders-export", { adminSecret }, `orders-${fileDate}.csv`);
      setMenuFeedback("Archivo exportado correctamente.", false);
    } catch (error) {
      setMenuFeedback(error.message, true);
    } finally {
      els.exportOrdersButton.disabled = false;
    }
  }

  async function updatePaymentStatus(orderId, paymentStatus) {
    if (!adminSecret) {
      setMenuFeedback("Primero ingrese con la clave administrativa.", true);
      return;
    }

    try {
      const snapshot = await fetchJson("/admin-orders", {
        method: "POST",
        body: {
          adminSecret,
          action: "updatePaymentStatus",
          orderId,
          paymentStatus
        }
      });
      renderAdminOrders(snapshot);
      setMenuFeedback("Estado de pago actualizado.", false);
    } catch (error) {
      setMenuFeedback(error.message, true);
    }
  }

  function start() {
    if (!requireAdminSession()) return;

    els.menuForm.addEventListener("submit", submitMenu);
    els.exportOrdersButton.addEventListener("click", exportOrders);
    if (els.adminLogoutButton) {
      els.adminLogoutButton.addEventListener("click", logout);
    }

    refreshSnapshot();
    refreshAdminOrders();

    window.setInterval(function () {
      if (!adminSecret) return;
      refreshSnapshot();
      refreshAdminOrders();
    }, Number(config.refreshIntervalMs || 30000));
  }

  start();
})();
