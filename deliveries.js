(function () {
  "use strict";

  var config  = window.APP_CONFIG || {};
  var banner  = window.SE.banner;
  var fmt     = window.SE.fmt;

  var CACHE_KEY = "ceep-deliveries-cache-v1";
  var accessToken      = "";
  var realtimeChannel  = null;
  var api; // created after session is available

  var els = {
    updatedAt:          document.getElementById("deliveriesUpdatedAt"),
    totalOrders:        document.getElementById("deliveriesTotalOrders"),
    paidOrders:         document.getElementById("deliveriesPaidOrders"),
    paidPendingOrders:  document.getElementById("deliveriesPaidPendingOrders"),
    pendingOrders:      document.getElementById("deliveriesPendingOrders"),
    deliveredOrders:    document.getElementById("deliveriesDeliveredOrders"),
    ordersList:         document.getElementById("deliveriesList"),
    rowTemplate:        document.getElementById("deliveryRowTemplate"),
    logoutButton:       document.getElementById("deliveriesLogoutButton")
  };

  // ── Cache ─────────────────────────────────────────────────────────

  function loadCached() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (_) { return null; }
  }
  function saveCache(snapshot) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot)); } catch (_) {}
  }

  // ── Feedback ──────────────────────────────────────────────────────

  function setFeedback(message, isError) {
    var el = document.getElementById("deliveriesFeedback");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = isError ? "var(--primary-dark,#842f3d)" : "var(--muted,#888)";
  }

  // ── Render ────────────────────────────────────────────────────────

  var DELIVERY_LABELS = {
    PENDIENTE_ENTREGA:  "Solicitado",
    EN_PREPARACION:     "En Preparación",
    LISTO_PARA_ENTREGA: "Listo para Entrega",
    ENTREGADO:          "Entregado"
  };

  // Workflow: each status maps to the next step to show as a button.
  var NEXT_STEP = {
    PENDIENTE_ENTREGA:  { status: "EN_PREPARACION",     label: "→ En Preparación" },
    EN_PREPARACION:     { status: "LISTO_PARA_ENTREGA", label: "→ Listo para Entrega" },
    LISTO_PARA_ENTREGA: { status: "ENTREGADO",          label: "✓ Marcar Entregado" }
  };

  function buildWorkflowCell(node, order) {
    var key      = String(order.deliveryStatus || "PENDIENTE_ENTREGA").toUpperCase();
    var pillNode = node.querySelector(".delivery-workflow-status");
    if (pillNode) pillNode.textContent = DELIVERY_LABELS[key] || key.replace(/_/g, " ");

    var actionsCell = node.querySelector(".delivery-workflow-actions");
    if (!actionsCell) return;
    actionsCell.innerHTML = "";

    // SINPE orders waiting for manual verification get a dedicated confirm button.
    if (order.needsSinpeVerification) {
      var sinpeBtn = document.createElement("button");
      sinpeBtn.type      = "button";
      sinpeBtn.className = "delivery-action delivery-action--sinpe-verify";
      sinpeBtn.textContent = "Confirmar Pago SINPE";
      sinpeBtn.addEventListener("click", function () {
        updatePaymentStatus(order.id, "PAGADO");
      });
      actionsCell.appendChild(sinpeBtn);
    }

    var next = NEXT_STEP[key];
    if (!next) return;

    var btn = document.createElement("button");
    btn.type        = "button";
    btn.className   = "delivery-action";
    btn.textContent = next.label;
    btn.addEventListener("click", function () {
      updateDeliveryStatus(order.id, next.status);
    });
    actionsCell.appendChild(btn);
  }

  function renderOrders(orders) {
    els.ordersList.innerHTML = "";
    if (!orders || !orders.length) {
      els.ordersList.innerHTML = '<div class="delivery-table__empty">No hay compras registradas todavía.</div>';
      return;
    }

    var fragment = document.createDocumentFragment();
    orders.forEach(function (order) {
      var node = els.rowTemplate.content.cloneNode(true);

      // Highlight rows where a SINPE transfer is waiting for manual confirmation.
      if (order.needsSinpeVerification) {
        var row = node.querySelector(".delivery-table__row");
        if (row) row.classList.add("is-sinpe-pending");
      }

      node.querySelector(".buyer-name").textContent             = order.buyerName;
      node.querySelector(".delivery-order-meta").textContent    = [order.paymentMethod, order.timestampLabel].filter(Boolean).join(" | ");
      node.querySelector(".delivery-order-status").textContent  = order.orderStatus || "SOLICITADO";
      node.querySelector(".delivery-created-at").textContent    = order.createdAtLabel || "";

      var payNode = node.querySelector(".delivery-payment-status");
      payNode.textContent = fmt.paymentLabel(order.paymentStatus);
      payNode.className   = fmt.paymentClass(order.paymentStatus);

      node.querySelector(".delivery-payment-confirmed-at").textContent = order.paymentConfirmedAtLabel || "";
      node.querySelector(".delivery-delivered-at").textContent         = order.deliveredAtLabel        || "";

      buildWorkflowCell(node, order);
      fragment.appendChild(node);
    });
    els.ordersList.appendChild(fragment);
  }

  function renderSnapshot(snapshot) {
    if (els.updatedAt)         els.updatedAt.textContent         = fmt.dateTime(snapshot.updatedAt);
    if (els.totalOrders)       els.totalOrders.textContent       = String(snapshot.totalOrders              || 0);
    if (els.paidOrders)        els.paidOrders.textContent        = String(snapshot.paidOrders               || 0);
    if (els.paidPendingOrders) els.paidPendingOrders.textContent = String(snapshot.paidPendingDeliveryCount  || 0);
    if (els.pendingOrders)     els.pendingOrders.textContent     = String(snapshot.pendingDeliveries         || 0);
    if (els.deliveredOrders)   els.deliveredOrders.textContent   = String(snapshot.deliveredOrders           || 0);
    renderOrders(snapshot.orders || []);
  }

  // ── Network ───────────────────────────────────────────────────────

  async function refreshSnapshot() {
    try {
      var snapshot = await api.fetchJson("/deliveries");
      saveCache(snapshot);
      renderSnapshot(snapshot);
      setFeedback("", false);
      banner.setSynced();
    } catch (err) {
      var cached = loadCached();
      if (cached) { renderSnapshot(cached); setFeedback("Mostrando datos guardados.", false); }
      else        { setFeedback("Error al cargar datos: " + err.message, true); }
      if (navigator.onLine) banner.setError(refreshSnapshot);
    }
  }

  async function updateDeliveryStatus(orderId, deliveryStatus) {
    banner.setSyncing();
    setFeedback("Actualizando...", false);
    try {
      var snapshot = await api.fetchJson("/deliveries", { method: "POST", body: { orderId, deliveryStatus } });
      saveCache(snapshot);
      renderSnapshot(snapshot);
      banner.setSynced();
      setFeedback(snapshot.emailWarning || "", false);
    } catch (err) {
      setFeedback("Error: " + err.message + " — toca el banner para reintentar.", true);
      banner.setError(function () { updateDeliveryStatus(orderId, deliveryStatus); });
    }
  }

  async function updatePaymentStatus(orderId, paymentStatus) {
    banner.setSyncing();
    setFeedback("Verificando pago SINPE...", false);
    try {
      var snapshot = await api.fetchJson("/deliveries", { method: "POST", body: { orderId, paymentStatus } });
      saveCache(snapshot);
      renderSnapshot(snapshot);
      banner.setSynced();
      setFeedback(snapshot.emailWarning || "", false);
    } catch (err) {
      setFeedback("Error: " + err.message + " — toca el banner para reintentar.", true);
      banner.setError(function () { updatePaymentStatus(orderId, paymentStatus); });
    }
  }

  // ── Realtime (Priority 6) ─────────────────────────────────────────
  // Subscribes to all order changes for this cafeteria.
  // Receives cafeteriaId from the auth-role response.

  function subscribeRealtime(cid) {
    var cfg = window.APP_CONFIG || {};
    if (!cfg.supabaseUrl || cfg.supabaseUrl.includes("REPLACE_WITH") ||
        !cfg.supabaseAnonKey || cfg.supabaseAnonKey.includes("REPLACE_WITH")) {
      return;
    }

    if (realtimeChannel) window.supabaseClient.removeChannel(realtimeChannel);

    realtimeChannel = window.supabaseClient
      .channel("deliveries-" + cid)
      .on("postgres_changes", {
        event:  "*",
        schema: "public",
        table:  "orders",
        filter: "cafeteria_id=eq." + cid
      }, function () {
        refreshSnapshot();
      })
      .subscribe();
  }

  // ── Init ──────────────────────────────────────────────────────────

  async function start() {
    banner.init();

    // 1. Require valid session.
    var { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) { window.location.replace("./index.html"); return; }
    accessToken = session.access_token;

    window.supabaseClient.auth.onAuthStateChange(function (event, newSession) {
      if (!newSession) { window.location.replace("./index.html"); return; }
      accessToken = newSession.access_token;
    });

    api = window.SE.api.make(function () { return accessToken; });

    // 2. Get cafeteriaId for the Realtime filter.
    var roleData;
    try {
      roleData = await api.fetchJson("/auth-role");
    } catch (_) {
      window.location.replace("./index.html");
      return;
    }

    if (els.logoutButton) {
      els.logoutButton.addEventListener("click", function () {
        window.supabaseClient.auth.signOut();
        window.location.replace("./index.html");
      });
    }

    // 3. Show cached data immediately while the network call is in-flight.
    var cached = loadCached();
    if (cached) renderSnapshot(cached);

    await refreshSnapshot();

    // 4. Realtime — instant push updates.
    subscribeRealtime(roleData.cafeteriaId);

    // 5. 60 s fallback for environments where WebSockets are blocked.
    window.setInterval(refreshSnapshot, 60000);
  }

  start();
})();
