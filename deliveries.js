(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const SESSION_KEY = "ceep-role-session";
  const els = {
    deliveriesUpdatedAt: document.getElementById("deliveriesUpdatedAt"),
    deliveriesTotalOrders: document.getElementById("deliveriesTotalOrders"),
    deliveriesPendingPaymentCount: document.getElementById("deliveriesPendingPaymentCount"),
    deliveriesPaidOrders: document.getElementById("deliveriesPaidOrders"),
    deliveriesPaidPendingOrders: document.getElementById("deliveriesPaidPendingOrders"),
    deliveriesPendingOrders: document.getElementById("deliveriesPendingOrders"),
    deliveriesDeliveredOrders: document.getElementById("deliveriesDeliveredOrders"),
    deliveriesList: document.getElementById("deliveriesList"),
    deliveryRowTemplate: document.getElementById("deliveryRowTemplate"),
    deliveriesLogoutButton: document.getElementById("deliveriesLogoutButton")
  };

  let ordersPassword = "";

  function getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function requireOrdersSession() {
    const session = getSession();
    if (!session || session.role !== "ORDERS" || !session.password) {
      window.location.replace("./index.html");
      return false;
    }

    ordersPassword = session.password;
    return true;
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.replace("./index.html");
  }

  function getPaymentClass(paymentStatus) {
    return String(paymentStatus || "").toUpperCase() === "PAGADO"
      ? "delivery-payment-status delivery-payment-status--paid"
      : "delivery-payment-status delivery-payment-status--pending";
  }

  function formatDateTime(value) {
    if (!value) return "Sin datos recientes";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Sin datos recientes";

    const formatter = new Intl.DateTimeFormat("es-CR", {
      timeZone: "America/Costa_Rica",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });

    const parts = formatter.formatToParts(date);
    const get = function (type) {
      const part = parts.find(function (item) {
        return item.type === type;
      });
      return part ? part.value : "";
    };

    const weekday = get("weekday");
    const capitalizedWeekday = weekday ? weekday.charAt(0).toUpperCase() + weekday.slice(1) : "";
    const day = get("day");
    const month = get("month");
    const year = get("year");
    const hour = get("hour");
    const minute = get("minute");
    const dayPeriod = get("dayPeriod").replace(/\./g, "").toUpperCase();

    return "Actualizado " + [capitalizedWeekday, day, "de", month, "del", year, "a las", hour + ":" + minute, dayPeriod].join(" ");
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
      els.deliveriesList.innerHTML = '<div class="delivery-table__empty">No hay compras registradas todavía.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    orders.forEach(function (order) {
      const node = els.deliveryRowTemplate.content.cloneNode(true);
      node.querySelector(".buyer-name").textContent = order.buyerName;
      node.querySelector(".delivery-order-meta").textContent = [order.paymentMethod, order.timestampLabel].filter(Boolean).join(" | ");
      node.querySelector(".delivery-order-status").textContent = order.orderStatus || "SOLICITADO";
      node.querySelector(".delivery-created-at").textContent = order.createdAtLabel || "";
      const paymentNode = node.querySelector(".delivery-payment-status");
      paymentNode.textContent = order.paymentStatus || "PENDIENTE DE PAGO";
      paymentNode.className = getPaymentClass(order.paymentStatus);
      node.querySelector(".delivery-payment-confirmed-at").textContent = order.paymentConfirmedAtLabel || "";
      node.querySelector(".delivery-delivered-at").textContent = order.deliveredAtLabel || "";

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
    els.deliveriesUpdatedAt.textContent = formatDateTime(snapshot.updatedAt);
    els.deliveriesTotalOrders.textContent = String(snapshot.totalOrders || 0);
    els.deliveriesPendingPaymentCount.textContent = String(snapshot.pendingPaymentCount || 0);
    els.deliveriesPaidOrders.textContent = String(snapshot.paidOrders || 0);
    els.deliveriesPaidPendingOrders.textContent = String(snapshot.paidPendingDeliveryCount || 0);
    els.deliveriesPendingOrders.textContent = String(snapshot.pendingDeliveries || 0);
    els.deliveriesDeliveredOrders.textContent = String(snapshot.deliveredOrders || 0);
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

  function start() {
    if (!requireOrdersSession()) return;
    if (els.deliveriesLogoutButton) {
      els.deliveriesLogoutButton.addEventListener("click", logout);
    }

    refreshSnapshot().catch(function () {
      return null;
    });

    window.setInterval(function () {
      if (!ordersPassword) return;
      refreshSnapshot().catch(function () {
        return null;
      });
    }, Number(config.refreshIntervalMs || 30000));
  }

  start();
})();
