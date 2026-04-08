(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const state = {
    snapshot: null,
    isSubmitting: false
  };

  const els = {
    statusBadge: document.getElementById("statusBadge"),
    updatedAt: document.getElementById("updatedAt"),
    menuTitle: document.getElementById("menuTitle"),
    menuDescription: document.getElementById("menuDescription"),
    menuPrice: document.getElementById("menuPrice"),
    deliveryWindow: document.getElementById("deliveryWindow"),
    salesWindow: document.getElementById("salesWindow"),
    dailyMessage: document.getElementById("dailyMessage"),
    availableCount: document.getElementById("availableCount"),
    soldCount: document.getElementById("soldCount"),
    sinpeCount: document.getElementById("sinpeCount"),
    cashCount: document.getElementById("cashCount"),
    totalAmount: document.getElementById("totalAmount"),
    buyersList: document.getElementById("buyersList"),
    orderForm: document.getElementById("orderForm"),
    submitButton: document.getElementById("submitButton"),
    formFeedback: document.getElementById("formFeedback"),
    refreshButton: document.getElementById("refreshButton"),
    buyerRowTemplate: document.getElementById("buyerRowTemplate")
  };

  function formatCurrency(amount) {
    return new Intl.NumberFormat("es-CR", {
      style: "currency",
      currency: "CRC",
      maximumFractionDigits: 0
    }).format(Number(amount || 0));
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

  function setFeedback(message, isError) {
    els.formFeedback.textContent = message || "";
    els.formFeedback.style.color = isError ? "#842f3d" : "#705d52";
  }

  function loadCachedSnapshot() {
    try {
      const raw = localStorage.getItem(config.cacheKey);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function saveCachedSnapshot(snapshot) {
    try {
      localStorage.setItem(config.cacheKey, JSON.stringify(snapshot));
    } catch (error) {
      console.warn("No se pudo guardar el cache local.", error);
    }
  }

  function setStatus(snapshot, fromCache) {
    if (!snapshot) {
      els.statusBadge.textContent = "Sin conexión";
      els.statusBadge.className = "badge badge--warning";
      return;
    }

    if (!snapshot.isSalesOpen) {
      els.statusBadge.textContent = "Venta cerrada";
      els.statusBadge.className = "badge badge--warning";
      return;
    }

    if ((snapshot.availableMeals || 0) <= 0) {
      els.statusBadge.textContent = "Agotado";
      els.statusBadge.className = "badge badge--warning";
      return;
    }

    els.statusBadge.textContent = fromCache ? "Mostrando datos guardados" : "Venta abierta";
    els.statusBadge.className = fromCache ? "badge badge--warning" : "badge badge--success";
  }

  function renderBuyers(orders) {
    els.buyersList.innerHTML = "";

    if (!orders || orders.length === 0) {
      els.buyersList.innerHTML = '<p class="empty-state">No hay compras registradas todavía.</p>';
      return;
    }

    const fragment = document.createDocumentFragment();
    orders.forEach((order) => {
      const node = els.buyerRowTemplate.content.cloneNode(true);
      node.querySelector(".buyer-name").textContent = order.buyerName;
      node.querySelector(".buyer-meta").textContent =
        [order.paymentMethod, order.paymentStatus, order.timestampLabel].filter(Boolean).join(" | ");

      const badge = node.querySelector(".buyer-payment");
      badge.textContent = order.paymentMethod;
      badge.className = order.paymentMethod === "SINPE" ? "badge badge--success buyer-payment" : "badge badge--warning buyer-payment";
      fragment.appendChild(node);
    });

    els.buyersList.appendChild(fragment);
  }

  function renderSnapshot(snapshot, fromCache) {
    state.snapshot = snapshot;
    setStatus(snapshot, fromCache);
    els.updatedAt.textContent = formatDateTime(snapshot.updatedAt);

    const menu = snapshot.menu || {};
    els.menuTitle.textContent = menu.title || "Menú no configurado";
    els.menuDescription.textContent = menu.description || "No hay descripción disponible.";
    els.menuPrice.textContent = formatCurrency(menu.price);
    els.deliveryWindow.textContent = snapshot.deliveryWindow || "12:00 m. - 12:30 p. m.";
    els.salesWindow.textContent = snapshot.salesWindow || "10:00 a. m. - 12:00 m.";
    els.dailyMessage.textContent = snapshot.message || "La cantidad máxima es de 15 almuerzos por día.";

    els.availableCount.textContent = String(snapshot.availableMeals || 0);
    els.soldCount.textContent = String(snapshot.soldMeals || 0);
    els.sinpeCount.textContent = String(snapshot.sinpeCount || 0);
    els.cashCount.textContent = String(snapshot.cashCount || 0);
    els.totalAmount.textContent = formatCurrency(snapshot.totalAmount || 0);

    renderBuyers(snapshot.orders || []);

    const canBuy = Boolean(snapshot.isSalesOpen) && Number(snapshot.availableMeals || 0) > 0;
    els.submitButton.disabled = !canBuy || state.isSubmitting;
    if (!canBuy) {
      setFeedback("La venta está cerrada o ya se alcanzó el máximo diario.", false);
    } else if (!state.isSubmitting) {
      setFeedback("", false);
    }
  }

  async function fetchJson(path, options) {
    if (!config.apiBaseUrl || config.apiBaseUrl.includes("PEGUE_AQUI")) {
      throw new Error("Debe configurar la URL del Apps Script en config.js");
    }

    const requestOptions = {
      method: options && options.method ? options.method : "GET"
    };

    if (options && options.body) {
      requestOptions.headers = {
        "Content-Type": "text/plain;charset=utf-8"
      };
      requestOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(config.apiBaseUrl + path, requestOptions);

    if (!response.ok) {
      throw new Error("No fue posible completar la solicitud.");
    }

    return response.json();
  }

  async function refreshSnapshot(showErrors) {
    try {
      const snapshot = await fetchJson("?action=dashboard");
      saveCachedSnapshot(snapshot);
      renderSnapshot(snapshot, false);
    } catch (error) {
      const cached = loadCachedSnapshot();
      if (cached) {
        renderSnapshot(cached, true);
      }
      if (showErrors) {
        setFeedback(error.message, true);
      }
    }
  }

  function getFormPayload() {
    const formData = new FormData(els.orderForm);
    return {
      buyerName: String(formData.get("buyerName") || "").trim(),
      buyerId: String(formData.get("buyerId") || "").trim(),
      buyerPhone: String(formData.get("buyerPhone") || "").trim(),
      paymentMethod: String(formData.get("paymentMethod") || "").trim(),
      paymentReference: String(formData.get("paymentReference") || "").trim(),
      notes: String(formData.get("notes") || "").trim()
    };
  }

  async function submitOrder(event) {
    event.preventDefault();

    if (state.isSubmitting) return;

    const payload = getFormPayload();
    if (!payload.buyerName || !payload.buyerId || !payload.buyerPhone || !payload.paymentMethod) {
      setFeedback("Complete todos los campos obligatorios.", true);
      return;
    }

    state.isSubmitting = true;
    els.submitButton.disabled = true;
    setFeedback("Registrando compra...", false);

    try {
      const result = await fetchJson("", {
        method: "POST",
        body: {
          action: "createOrder",
          order: payload
        }
      });

      if (!result.ok) {
        throw new Error(result.message || "No se pudo registrar la compra.");
      }

      els.orderForm.reset();
      setFeedback(result.message || "Compra registrada correctamente.", false);
      if (result.snapshot) {
        saveCachedSnapshot(result.snapshot);
        renderSnapshot(result.snapshot, false);
      } else {
        await refreshSnapshot(false);
      }
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      state.isSubmitting = false;
      if (state.snapshot) {
        renderSnapshot(state.snapshot, false);
      } else {
        els.submitButton.disabled = false;
      }
    }
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(function () {
        return null;
      });
    }
  }

  function start() {
    const cached = loadCachedSnapshot();
    if (cached) {
      renderSnapshot(cached, true);
    }

    els.orderForm.addEventListener("submit", submitOrder);
    els.refreshButton.addEventListener("click", function () {
      refreshSnapshot(true);
    });

    refreshSnapshot(false);
    window.setInterval(function () {
      refreshSnapshot(false);
    }, Number(config.refreshIntervalMs || 30000));

    registerServiceWorker();
  }

  start();
})();
