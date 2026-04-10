(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const els = {
    deliveriesGate: document.getElementById("deliveriesGate"),
    deliveriesContent: document.getElementById("deliveriesContent"),
    deliveriesGateForm: document.getElementById("deliveriesGateForm"),
    deliveriesSecret: document.getElementById("deliveriesSecret"),
    deliveriesGateSubmitButton: document.getElementById("deliveriesGateSubmitButton"),
    deliveriesGateFeedback: document.getElementById("deliveriesGateFeedback"),
    deliveriesUpdatedAt: document.getElementById("deliveriesUpdatedAt"),
    deliveriesMenuTitle: document.getElementById("deliveriesMenuTitle"),
    deliveriesMenuPrice: document.getElementById("deliveriesMenuPrice"),
    deliveriesSalesWindow: document.getElementById("deliveriesSalesWindow"),
    deliveriesDeliveryWindow: document.getElementById("deliveriesDeliveryWindow"),
    deliveriesTotalOrders: document.getElementById("deliveriesTotalOrders"),
    deliveriesPendingOrders: document.getElementById("deliveriesPendingOrders"),
    deliveriesDeliveredOrders: document.getElementById("deliveriesDeliveredOrders"),
    deliveriesTotalAmount: document.getElementById("deliveriesTotalAmount"),
    deliveriesList: document.getElementById("deliveriesList"),
    deliveriesRefreshButton: document.getElementById("deliveriesRefreshButton"),
    deliveryRowTemplate: document.getElementById("deliveryRowTemplate")
  };

  let ordersPassword = "";

  function formatCurrency(amount) {
    return new Intl.NumberFormat("es-CR", {
      style: "currency",
      currency: "CRC",
      maximumFractionDigits: 0
    }).format(Number(amount || 0));
  }

  function setGateFeedback(message, isError) {
    els.deliveriesGateFeedback.textContent = message || "";
    els.deliveriesGateFeedback.style.color = isError ? "#842f3d" : "#705d52";
  }

  function getPaymentLabel(paymentStatus) {
    const normalized = String(paymentStatus || "").toUpperCase();
    if (["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"].includes(normalized)) {
      return "PAGADO";
    }
    return "PENDIENTE DE PAGO";
  }

  function getPaymentClass(paymentStatus) {
    return getPaymentLabel(paymentStatus) === "PAGADO"
      ? "delivery-payment-status delivery-payment-status--paid"
      : "delivery-payment-status delivery-payment-status--pending";
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
      method: options && options.method ? options.method : "GET",
      headers: {}
    };

    if (ordersPassword) {
      requestOptions.headers["x-orders-password"] = ordersPassword;
    }

    if (options && options.body) {
      requestOptions.headers["Content-Type"] = "application/json";
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

  function renderOrders(orders) {
    els.deliveriesList.innerHTML = "";

    if (!orders || orders.length === 0) {
      els.deliveriesList.innerHTML = '<p class="empty-state">No hay compras registradas todavía.</p>';
      return;
    }

    const fragment = document.createDocumentFragment();
    orders.forEach(function (order) {
      const node = els.deliveryRowTemplate.content.cloneNode(true);
      node.querySelector(".buyer-name").textContent = order.buyerName;
      node.querySelector(".buyer-meta").textContent =
        [order.paymentMethod, order.timestampLabel].filter(Boolean).join(" | ");
      const paymentNode = node.querySelector(".delivery-payment-status");
      paymentNode.textContent = getPaymentLabel(order.paymentStatus);
      paymentNode.className = getPaymentClass(order.paymentStatus);
      node.querySelector(".delivery-delivered-at").textContent = order.deliveredAtLabel || "-";

      node.querySelectorAll(".delivery-action").forEach(function (button) {
        const isSelected = button.dataset.deliveryStatus === order.deliveryStatus;
        button.classList.toggle("is-selected", isSelected);
        button.addEventListener("click", function () {
          updateDeliveryStatus(order.id, button.dataset.deliveryStatus);
        });
      });

      fragment.appendChild(node);
    });

    els.deliveriesList.appendChild(fragment);
  }

  function renderSnapshot(snapshot) {
    const menu = snapshot.menu || {};
    els.deliveriesUpdatedAt.textContent = formatDateTime(snapshot.updatedAt);
    els.deliveriesMenuTitle.textContent = menu.title || "Menú no configurado";
    els.deliveriesMenuPrice.textContent = formatCurrency(menu.price);
    els.deliveriesSalesWindow.textContent = snapshot.salesWindow || "-";
    els.deliveriesDeliveryWindow.textContent = snapshot.deliveryWindow || "-";
    els.deliveriesTotalOrders.textContent = String(snapshot.totalOrders || 0);
    els.deliveriesPendingOrders.textContent = String(snapshot.pendingDeliveries || 0);
    els.deliveriesDeliveredOrders.textContent = String(snapshot.deliveredOrders || 0);
    els.deliveriesTotalAmount.textContent = formatCurrency(snapshot.totalAmount || 0);
    renderOrders(snapshot.orders || []);
  }

  async function refreshSnapshot() {
    const snapshot = await fetchJson("/deliveries");
    renderSnapshot(snapshot);
  }

  async function updateDeliveryStatus(orderId, deliveryStatus) {
    try {
      const snapshot = await fetchJson("/deliveries", {
        method: "POST",
        body: { orderId, deliveryStatus }
      });
      renderSnapshot(snapshot);
    } catch (error) {
      setGateFeedback(error.message, true);
    }
  }

  async function submitGate(event) {
    event.preventDefault();
    const password = String(els.deliveriesSecret.value || "").trim();

    if (!password) {
      setGateFeedback("Ingrese la clave de entregas.", true);
      return;
    }

    els.deliveriesGateSubmitButton.disabled = true;
    setGateFeedback("Verificando acceso...", false);

    try {
      ordersPassword = password;
      const snapshot = await fetchJson("/deliveries");
      els.deliveriesGate.hidden = true;
      els.deliveriesContent.hidden = false;
      setGateFeedback("");
      renderSnapshot(snapshot);
    } catch (error) {
      ordersPassword = "";
      setGateFeedback(error.message, true);
    } finally {
      els.deliveriesGateSubmitButton.disabled = false;
    }
  }

  function start() {
    els.deliveriesGateForm.addEventListener("submit", submitGate);
    els.deliveriesRefreshButton.addEventListener("click", function () {
      refreshSnapshot().catch(function (error) {
        setGateFeedback(error.message, true);
      });
    });
  }

  start();
})();
