(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const els = {
    helperUpdatedAt:            document.getElementById("helperUpdatedAt"),
    helperMenuForm:             document.getElementById("helperMenuForm"),
    helperMenuTitleInput:       document.getElementById("helperMenuTitleInput"),
    helperMenuDescriptionInput: document.getElementById("helperMenuDescriptionInput"),
    helperMenuPriceInput:       document.getElementById("helperMenuPriceInput"),
    helperMenuSubmitButton:     document.getElementById("helperMenuSubmitButton"),
    helperMenuFeedback:         document.getElementById("helperMenuFeedback"),
    helperTotalOrders:          document.getElementById("helperTotalOrders"),
    helperPendingPaymentCount:  document.getElementById("helperPendingPaymentCount"),
    helperPaidOrders:           document.getElementById("helperPaidOrders"),
    helperDeliveredOrders:      document.getElementById("helperDeliveredOrders"),
    helperPendingOrders:        document.getElementById("helperPendingOrders"),
    helperDeliveriesList:       document.getElementById("helperDeliveriesList"),
    helperDeliveryRowTemplate:  document.getElementById("helperDeliveryRowTemplate"),
    helperLogoutButton:         document.getElementById("helperLogoutButton")
  };

  let accessToken = "";
  let isSaving = false;

  // -----------------------------------------------------------------------
  // Auth helpers
  // -----------------------------------------------------------------------

  async function requireStaffSession() {
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

  function setFeedback(message, isError) {
    els.helperMenuFeedback.textContent = message || "";
    els.helperMenuFeedback.style.color = isError ? "#842f3d" : "#705d52";
  }

  async function fetchJson(path, options) {
    const requestOptions = {
      method: options?.method || "GET",
      headers: { "Authorization": "Bearer " + accessToken }
    };

    if (options?.body) {
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

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  function renderOrders(orders) {
    els.helperDeliveriesList.innerHTML = "";

    if (!orders || orders.length === 0) {
      els.helperDeliveriesList.innerHTML = '<div class="delivery-table__empty">No hay compras registradas todavía.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    orders.forEach(function (order) {
      const node = els.helperDeliveryRowTemplate.content.cloneNode(true);
      node.querySelector(".buyer-name").textContent = order.buyerName;
      node.querySelector(".delivery-order-meta").textContent =
        [order.paymentMethod, order.timestampLabel].filter(Boolean).join(" | ");
      node.querySelector(".helper-order-status").textContent = order.orderStatus || "SOLICITADO";
      node.querySelector(".helper-created-at").textContent = order.createdAtLabel || "";

      const paymentNode = node.querySelector(".helper-payment-status");
      paymentNode.textContent = getPaymentLabel(order.paymentStatus);
      paymentNode.className = getPaymentClass(order.paymentStatus);

      node.querySelector(".helper-payment-confirmed-at").textContent = order.paymentConfirmedAtLabel || "";
      node.querySelector(".helper-delivered-at").textContent = order.deliveredAtLabel || "";

      node.querySelectorAll(".helper-delivery-action").forEach(function (button) {
        const isSelected = button.dataset.deliveryStatus === order.deliveryStatus;
        button.classList.toggle("is-selected", isSelected);
        button.addEventListener("click", function () {
          updateDeliveryStatus(order.id, button.dataset.deliveryStatus);
        });
      });

      fragment.appendChild(node);
    });

    els.helperDeliveriesList.appendChild(fragment);
  }

  function renderSnapshot(snapshot) {
    els.helperUpdatedAt.textContent = formatDateTime(snapshot.updatedAt);
    els.helperTotalOrders.textContent = String(snapshot.totalOrders || 0);
    els.helperPendingPaymentCount.textContent = String(snapshot.pendingPaymentCount || 0);
    els.helperPaidOrders.textContent = String(snapshot.paidOrders || 0);
    els.helperDeliveredOrders.textContent = String(snapshot.deliveredOrders || 0);
    els.helperPendingOrders.textContent = String(snapshot.pendingDeliveries || 0);

    const menu = snapshot.menu || {};
    if (!isSaving) {
      els.helperMenuTitleInput.value = menu.title || "";
      els.helperMenuDescriptionInput.value = menu.description || "";
      els.helperMenuPriceInput.value = menu.price || "";
    }

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
      setFeedback(error.message, true);
    }
  }

  async function submitMenu(event) {
    event.preventDefault();
    if (isSaving) return;

    const formData = new FormData(els.helperMenuForm);
    const title       = String(formData.get("title")       || "").trim();
    const description = String(formData.get("description") || "").trim();
    const price       = Number(formData.get("price")        || 0);

    if (!title || !description || price < 0) {
      setFeedback("Complete nombre, descripcion y precio.", true);
      return;
    }

    isSaving = true;
    els.helperMenuSubmitButton.disabled = true;
    setFeedback("Guardando menú del día...", false);

    try {
      await fetchJson("/menu", {
        method: "POST",
        body: { menu: { title, description, price } }
      });

      setFeedback("Menú actualizado correctamente.", false);
      await refreshSnapshot();
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      isSaving = false;
      els.helperMenuSubmitButton.disabled = false;
    }
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  async function start() {
    if (!(await requireStaffSession())) return;

    els.helperLogoutButton.addEventListener("click", logout);
    els.helperMenuForm.addEventListener("submit", submitMenu);

    refreshSnapshot().catch(function (error) {
      setFeedback(error.message, true);
    });

    window.setInterval(function () {
      refreshSnapshot().catch(function () { return null; });
    }, Number(config.refreshIntervalMs || 30000));
  }

  start();
})();
