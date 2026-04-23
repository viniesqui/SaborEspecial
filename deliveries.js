(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const els = {
    deliveriesUpdatedAt:        document.getElementById("deliveriesUpdatedAt"),
    deliveriesTotalOrders:      document.getElementById("deliveriesTotalOrders"),
    deliveriesPaidOrders:       document.getElementById("deliveriesPaidOrders"),
    deliveriesPaidPendingOrders: document.getElementById("deliveriesPaidPendingOrders"),
    deliveriesPendingOrders:    document.getElementById("deliveriesPendingOrders"),
    deliveriesDeliveredOrders:  document.getElementById("deliveriesDeliveredOrders"),
    deliveriesList:             document.getElementById("deliveriesList"),
    deliveryRowTemplate:        document.getElementById("deliveryRowTemplate"),
    deliveriesLogoutButton:     document.getElementById("deliveriesLogoutButton")
  };

  let accessToken = "";

  // -----------------------------------------------------------------------
  // Auth helpers
  // -----------------------------------------------------------------------

  async function requireOrdersSession() {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) {
      window.location.replace("./index.html");
      return false;
    }
    accessToken = session.access_token;

    window.supabaseClient.auth.onAuthStateChange(function (event, newSession) {
      if (!newSession) {
        window.location.replace("./index.html");
        return;
      }
      accessToken = newSession.access_token;
    });

    return true;
  }

  async function logout() {
    await window.supabaseClient.auth.signOut();
    window.location.replace("./index.html");
  }

  // -----------------------------------------------------------------------
  // Network helpers
  // -----------------------------------------------------------------------

  async function fetchJson(path, options) {
    if (!config.apiBaseUrl || config.apiBaseUrl.includes("PEGUE_AQUI")) {
      throw new Error("Debe configurar la URL del backend en config.js");
    }

    const requestOptions = {
      method: options && options.method ? options.method : "GET",
      headers: { "Authorization": "Bearer " + accessToken }
    };

    if (options && options.body) {
      requestOptions.headers["Content-Type"] = "application/json";
      requestOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(config.apiBaseUrl + path, requestOptions);
    const payload = await response.json().catch(function () { return null; });

    if (!response.ok) {
      throw new Error((payload && payload.message) || "No fue posible completar la solicitud.");
    }

    return payload;
  }

  // -----------------------------------------------------------------------
  // UI helpers
  // -----------------------------------------------------------------------

  function getPaymentClass(paymentStatus) {
    return String(paymentStatus || "").toUpperCase() === "PAGADO"
      ? "delivery-payment-status delivery-payment-status--paid"
      : "delivery-payment-status delivery-payment-status--pending";
  }

  function getPaymentLabel(paymentStatus) {
    const normalized = String(paymentStatus || "").toUpperCase();
    if (normalized === "PAGADO") return "PAGADO";
    if (normalized === "PENDIENTE_DE_PAGO" || normalized === "POR_VERIFICAR") return "PENDIENTE DE PAGO";
    return normalized.replaceAll("_", " ") || "PENDIENTE DE PAGO";
  }

  // Human-readable labels for each delivery_status value
  const DELIVERY_LABELS = {
    PENDIENTE_ENTREGA:  "Solicitado",
    EN_PREPARACION:     "En Preparación",
    LISTO_PARA_ENTREGA: "Listo para Entrega",
    ENTREGADO:          "Entregado"
  };

  // Workflow: map each status to the next logical step { status, label }
  const NEXT_STEP = {
    PENDIENTE_ENTREGA:  { status: "EN_PREPARACION",     label: "→ En Preparación" },
    EN_PREPARACION:     { status: "LISTO_PARA_ENTREGA", label: "→ Listo para Entrega" },
    LISTO_PARA_ENTREGA: { status: "ENTREGADO",          label: "✓ Marcar Entregado" }
  };

  function buildWorkflowCell(node, order) {
    const statusKey = String(order.deliveryStatus || "PENDIENTE_ENTREGA").toUpperCase();

    // Column 4 — current delivery status pill
    const statusPill = node.querySelector(".delivery-workflow-status");
    if (statusPill) {
      statusPill.textContent = DELIVERY_LABELS[statusKey] || statusKey.replaceAll("_", " ");
    }

    // Column 5 — next-step button (none if already delivered)
    const actionsCell = node.querySelector(".delivery-workflow-actions");
    if (!actionsCell) return;
    actionsCell.innerHTML = "";

    const next = NEXT_STEP[statusKey];
    if (!next) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "delivery-action";
    btn.textContent = next.label;
    btn.addEventListener("click", function () {
      updateDeliveryStatus(order.id, next.status);
    });
    actionsCell.appendChild(btn);
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
      const part = parts.find(function (item) { return item.type === type; });
      return part ? part.value : "";
    };

    const weekday = get("weekday");
    const capitalizedWeekday = weekday ? weekday.charAt(0).toUpperCase() + weekday.slice(1) : "";
    const dayPeriod = get("dayPeriod").replace(/\./g, "").toUpperCase();

    return "Actualizado " + [
      capitalizedWeekday, get("day"), "de", get("month"), "del", get("year"),
      "a las", get("hour") + ":" + get("minute"), dayPeriod
    ].join(" ");
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

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
      node.querySelector(".delivery-order-meta").textContent =
        [order.paymentMethod, order.timestampLabel].filter(Boolean).join(" | ");
      node.querySelector(".delivery-order-status").textContent = order.orderStatus || "SOLICITADO";
      node.querySelector(".delivery-created-at").textContent = order.createdAtLabel || "";

      const paymentNode = node.querySelector(".delivery-payment-status");
      paymentNode.textContent = getPaymentLabel(order.paymentStatus);
      paymentNode.className = getPaymentClass(order.paymentStatus);

      node.querySelector(".delivery-payment-confirmed-at").textContent = order.paymentConfirmedAtLabel || "";
      node.querySelector(".delivery-delivered-at").textContent = order.deliveredAtLabel || "";

      buildWorkflowCell(node, order);

      fragment.appendChild(node);
    });

    els.deliveriesList.appendChild(fragment);
  }

  function renderSnapshot(snapshot) {
    els.deliveriesUpdatedAt.textContent = formatDateTime(snapshot.updatedAt);
    els.deliveriesTotalOrders.textContent = String(snapshot.totalOrders || 0);
    els.deliveriesPaidOrders.textContent = String(snapshot.paidOrders || 0);
    els.deliveriesPaidPendingOrders.textContent = String(snapshot.paidPendingDeliveryCount || 0);
    els.deliveriesPendingOrders.textContent = String(snapshot.pendingDeliveries || 0);
    els.deliveriesDeliveredOrders.textContent = String(snapshot.deliveredOrders || 0);
    renderOrders(snapshot.orders || []);
  }

  // -----------------------------------------------------------------------
  // Data fetching
  // -----------------------------------------------------------------------

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
      // deliveries.js had a reference to setGateFeedback which didn't exist.
      // Silently log until a proper feedback element is added to the template.
      console.error("Error actualizando entrega:", error.message);
    }
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  async function start() {
    if (!(await requireOrdersSession())) return;

    if (els.deliveriesLogoutButton) {
      els.deliveriesLogoutButton.addEventListener("click", logout);
    }

    refreshSnapshot().catch(function () { return null; });

    window.setInterval(function () {
      refreshSnapshot().catch(function () { return null; });
    }, Number(config.refreshIntervalMs || 30000));
  }

  start();
})();
