(function () {
  "use strict";

  var accessToken  = "";
  var userRole     = "";
  var cafeteriaId  = "";
  var isSaving     = false;
  var realtimeChannel = null;

  // Shared modules loaded via <script> tags before this file.
  var banner = window.SE.banner;
  var fmt    = window.SE.fmt;
  // api is created after accessToken is available; see init().
  var api;

  // ── Element refs ──────────────────────────────────────────────────
  var els = {
    pageTitle:         document.getElementById("mgmtPageTitle"),
    tabs:              document.getElementById("mgmtTabs"),
    updatedAt:         document.getElementById("mgmtUpdatedAt"),
    // Menu form
    menuForm:          document.getElementById("mgmtMenuForm"),
    menuTitleInput:    document.getElementById("mgmtMenuTitle"),
    menuDescInput:     document.getElementById("mgmtMenuDescription"),
    menuPriceInput:    document.getElementById("mgmtMenuPrice"),
    menuSubmit:        document.getElementById("mgmtMenuSubmit"),
    menuFeedback:      document.getElementById("mgmtMenuFeedback"),
    emailWarning:      document.getElementById("mgmtEmailWarning"),
    exportButton:      document.getElementById("mgmtExportButton"),
    // Admin current-menu summary
    currentMenuTitle:  document.getElementById("mgmtCurrentMenuTitle"),
    currentMenuDesc:   document.getElementById("mgmtCurrentMenuDescription"),
    currentMenuPrice:  document.getElementById("mgmtCurrentMenuPrice"),
    availableMeals:    document.getElementById("mgmtAvailableMeals"),
    salesWindow:       document.getElementById("mgmtSalesWindow"),
    deliveryWindow:    document.getElementById("mgmtDeliveryWindow"),
    // Admin orders
    adminTotal:        document.getElementById("mgmtAdminTotal"),
    adminPaid:         document.getElementById("mgmtAdminPaid"),
    adminPending:      document.getElementById("mgmtAdminPending"),
    adminOrdersList:   document.getElementById("mgmtAdminOrdersList"),
    adminRowTemplate:  document.getElementById("adminOrderRowTemplate"),
    // Helper stats
    totalOrders:       document.getElementById("mgmtTotalOrders"),
    pendingPayment:    document.getElementById("mgmtPendingPayment"),
    paidOrders:        document.getElementById("mgmtPaidOrders"),
    deliveredOrders:   document.getElementById("mgmtDeliveredOrders"),
    pendingDeliveries: document.getElementById("mgmtPendingDeliveries"),
    // Helper orders
    helperOrdersList:  document.getElementById("mgmtHelperOrdersList"),
    helperRowTemplate: document.getElementById("helperOrderRowTemplate"),
    // Insights
    insightsUpdatedAt: document.getElementById("mgmtInsightsUpdatedAt"),
    prepList:          document.getElementById("mgmtPrepList"),
    forecast:          document.getElementById("mgmtForecast"),
    heatmap:           document.getElementById("mgmtHeatmap"),
    weekly:            document.getElementById("mgmtWeekly"),
    // Logout
    logoutButton:      document.getElementById("mgmtLogoutButton")
  };

  // ── Role-based UI adaptation ──────────────────────────────────────

  function adaptToRole(role) {
    var isAdmin = role === "ADMIN";

    // Show/hide role-specific sections
    document.querySelectorAll(".admin-only").forEach(function (el) {
      el.hidden = !isAdmin;
    });
    document.querySelectorAll(".helper-only").forEach(function (el) {
      el.hidden = isAdmin;
    });

    if (els.pageTitle) {
      els.pageTitle.textContent = isAdmin ? "Administración" : "Asistente";
    }
    document.title = (isAdmin ? "Administración" : "Asistente") + " | Almuerzos CEEP";
  }

  // ── Tab switching (ADMIN only) ────────────────────────────────────

  function initTabs() {
    if (!els.tabs) return;
    els.tabs.addEventListener("click", function (e) {
      var btn = e.target.closest(".admin-tab");
      if (!btn) return;

      els.tabs.querySelectorAll(".admin-tab").forEach(function (t) {
        t.classList.remove("is-active");
      });
      btn.classList.add("is-active");

      var targetId = btn.dataset.tab;
      ["mgmtOperationsTab", "mgmtInsightsTab"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.hidden = (el.id !== targetId);
      });

      // Lazy-load analytics when the tab is first opened.
      if (targetId === "mgmtInsightsTab") {
        refreshAnalytics();
      }
    });
  }

  // ── Feedback helpers ──────────────────────────────────────────────

  function setFeedback(message, isError) {
    if (!els.menuFeedback) return;
    els.menuFeedback.textContent = message || "";
    els.menuFeedback.style.color = isError ? "#842f3d" : "#705d52";
  }

  function clearEmailWarning() {
    if (!els.emailWarning) return;
    els.emailWarning.hidden = true;
    els.emailWarning.textContent = "";
  }

  function showEmailWarning(msg) {
    if (!els.emailWarning) return;
    els.emailWarning.textContent = msg;
    els.emailWarning.hidden = false;
  }

  // ── ADMIN rendering ───────────────────────────────────────────────

  function renderDashboard(snapshot) {
    var menu = snapshot.menu || {};
    if (els.updatedAt)          els.updatedAt.textContent         = fmt.dateTime(snapshot.updatedAt);
    if (els.currentMenuTitle)   els.currentMenuTitle.textContent  = menu.title       || "Menú no configurado";
    if (els.currentMenuDesc)    els.currentMenuDesc.textContent   = menu.description || "No hay descripción disponible.";
    if (els.currentMenuPrice)   els.currentMenuPrice.textContent  = fmt.currency(menu.price);
    if (els.availableMeals)     els.availableMeals.textContent    = String(snapshot.availableMeals || 0);
    if (els.salesWindow)        els.salesWindow.textContent       = snapshot.salesWindow    || "-";
    if (els.deliveryWindow)     els.deliveryWindow.textContent    = snapshot.deliveryWindow || "-";

    if (!isSaving) {
      if (els.menuTitleInput)   els.menuTitleInput.value  = menu.title       || "";
      if (els.menuDescInput)    els.menuDescInput.value   = menu.description || "";
      if (els.menuPriceInput)   els.menuPriceInput.value  = menu.price       || "";
    }
  }

  function renderAdminOrders(snapshot) {
    if (els.adminTotal)   els.adminTotal.textContent   = String(snapshot.totalOrders        || 0);
    if (els.adminPaid)    els.adminPaid.textContent    = String(snapshot.paidCount          || 0);
    if (els.adminPending) els.adminPending.textContent = String(snapshot.pendingPaymentCount|| 0);

    if (!els.adminOrdersList || !els.adminRowTemplate) return;
    els.adminOrdersList.innerHTML = "";

    var orders = snapshot.orders || [];
    if (!orders.length) {
      els.adminOrdersList.innerHTML = '<div class="admin-orders-table__empty">No hay pedidos registrados hoy.</div>';
      return;
    }

    var fragment = document.createDocumentFragment();
    orders.forEach(function (order) {
      var node = els.adminRowTemplate.content.cloneNode(true);
      node.querySelector(".admin-order-name").textContent   = order.buyerName;
      node.querySelector(".admin-order-meta").textContent   = [order.buyerPhone, order.paymentReference].filter(Boolean).join(" | ") || "Sin referencia";
      node.querySelector(".admin-order-date").textContent   = order.createdAtLabel || "-";
      node.querySelector(".admin-order-method").textContent = String(order.paymentMethod || "").toUpperCase() === "SINPE" ? "SINPE" : "EFECTIVO";

      var statusNode = node.querySelector(".admin-order-status");
      var isPaid     = fmt.paymentLabel(order.paymentStatus) === "PAGADO";
      statusNode.textContent = isPaid ? "PAGADO" : "PENDIENTE DE PAGO";
      statusNode.className   = isPaid
        ? "admin-order-status admin-order-status--paid"
        : "admin-order-status admin-order-status--pending";

      node.querySelector(".admin-order-confirmed-at").textContent = order.paymentConfirmedAtLabel || "Pendiente";

      node.querySelectorAll(".payment-toggle").forEach(function (btn) {
        btn.classList.toggle("is-selected", btn.dataset.paymentStatus === order.paymentStatus);
        btn.addEventListener("click", function () {
          updatePaymentStatus(order.id, btn.dataset.paymentStatus);
        });
      });

      fragment.appendChild(node);
    });
    els.adminOrdersList.appendChild(fragment);
  }

  // ── HELPER rendering ──────────────────────────────────────────────

  function renderDeliveries(snapshot) {
    if (els.updatedAt)          els.updatedAt.textContent          = fmt.dateTime(snapshot.updatedAt);
    if (els.totalOrders)        els.totalOrders.textContent        = String(snapshot.totalOrders       || 0);
    if (els.pendingPayment)     els.pendingPayment.textContent     = String(snapshot.pendingPaymentCount|| 0);
    if (els.paidOrders)         els.paidOrders.textContent         = String(snapshot.paidOrders        || 0);
    if (els.deliveredOrders)    els.deliveredOrders.textContent    = String(snapshot.deliveredOrders   || 0);
    if (els.pendingDeliveries)  els.pendingDeliveries.textContent  = String(snapshot.pendingDeliveries || 0);

    var menu = snapshot.menu || {};
    if (!isSaving) {
      if (els.menuTitleInput)  els.menuTitleInput.value  = menu.title       || "";
      if (els.menuDescInput)   els.menuDescInput.value   = menu.description || "";
      if (els.menuPriceInput)  els.menuPriceInput.value  = menu.price       || "";
    }

    if (!els.helperOrdersList || !els.helperRowTemplate) return;
    els.helperOrdersList.innerHTML = "";

    var orders = snapshot.orders || [];
    if (!orders.length) {
      els.helperOrdersList.innerHTML = '<div class="delivery-table__empty">No hay compras registradas todavía.</div>';
      return;
    }

    var fragment = document.createDocumentFragment();
    orders.forEach(function (order) {
      var node = els.helperRowTemplate.content.cloneNode(true);
      node.querySelector(".buyer-name").textContent          = order.buyerName;
      node.querySelector(".delivery-order-meta").textContent = [order.paymentMethod, order.timestampLabel].filter(Boolean).join(" | ");
      node.querySelector(".helper-order-status").textContent = order.orderStatus || "SOLICITADO";
      node.querySelector(".helper-created-at").textContent   = order.createdAtLabel || "";

      var payNode = node.querySelector(".helper-payment-status");
      payNode.textContent = fmt.paymentLabel(order.paymentStatus);
      payNode.className   = fmt.paymentClass(order.paymentStatus);

      node.querySelector(".helper-payment-confirmed-at").textContent = order.paymentConfirmedAtLabel || "";
      node.querySelector(".helper-delivered-at").textContent         = order.deliveredAtLabel        || "";

      node.querySelectorAll(".helper-delivery-action").forEach(function (btn) {
        btn.classList.toggle("is-selected", btn.dataset.deliveryStatus === order.deliveryStatus);
        btn.addEventListener("click", function () {
          updateDeliveryStatus(order.id, btn.dataset.deliveryStatus);
        });
      });

      fragment.appendChild(node);
    });
    els.helperOrdersList.appendChild(fragment);
  }

  // ── Insights rendering (ADMIN only) ──────────────────────────────

  var DOW_NAMES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderPrepList(prep) {
    if (!prep || !prep.length) {
      els.prepList.innerHTML = '<p class="insights-empty">No hay pedidos activos para hoy.</p>';
      return;
    }
    var totals = prep.reduce(function (a, r) {
      a.total     += Number(r.total_portions     || 0);
      a.confirmed += Number(r.confirmed_portions || 0);
      a.pending   += Number(r.pending_portions   || 0);
      a.sinpe     += Number(r.sinpe_count        || 0);
      a.cash      += Number(r.cash_count         || 0);
      return a;
    }, { total: 0, confirmed: 0, pending: 0, sinpe: 0, cash: 0 });

    var label   = prep.length === 1 ? prep[0].menu_title : prep.length + " variantes de menú";
    var pct     = totals.total > 0 ? Math.round((totals.confirmed / totals.total) * 100) : 0;

    els.prepList.innerHTML =
      '<div class="prep-hero">' +
        '<div class="prep-hero__count">' + totals.total + '</div>' +
        '<div class="prep-hero__label">porciones a preparar hoy</div>' +
      '</div>' +
      '<p class="prep-menu-title">' + escHtml(label) + ' · ' + pct + '% confirmadas</p>' +
      '<div class="prep-stats">' +
        '<div class="prep-stat prep-stat--confirmed"><strong>' + totals.confirmed + '</strong><span>Confirmadas<br>(pago verificado)</span></div>' +
        '<div class="prep-stat prep-stat--pending"><strong>'   + totals.pending   + '</strong><span>Pendientes<br>(pago no verificado)</span></div>' +
        '<div class="prep-stat"><strong>' + totals.sinpe + '</strong><span>Por SINPE</span></div>' +
        '<div class="prep-stat"><strong>' + totals.cash  + '</strong><span>En Efectivo</span></div>' +
      '</div>';
  }

  function renderForecast(todayForecast) {
    if (!todayForecast || Number(todayForecast.sample_days || 0) === 0) {
      els.forecast.innerHTML = '<p class="insights-empty">Datos insuficientes. Se necesita al menos una semana de historial.</p>';
      return;
    }
    var avg      = Number(todayForecast.avg_orders  || 0);
    var max      = Number(todayForecast.max_orders  || 0);
    var min      = Number(todayForecast.min_orders  || 0);
    var samples  = Number(todayForecast.sample_days || 0);
    var dayName  = DOW_NAMES[Number(todayForecast.day_of_week || 0)] || "Hoy";
    var suggested = Math.ceil(avg * 1.2);

    els.forecast.innerHTML =
      '<div class="forecast-main">' +
        '<div class="forecast-count">' + avg.toFixed(1) + '</div>' +
        '<p class="forecast-tip">Promedio histórico para los <strong>' + escHtml(dayName) + '</strong> de las últimas ' + samples + ' semanas. Se sugiere autorizar <strong>' + suggested + ' almuerzos</strong> (20% de margen).</p>' +
      '</div>' +
      '<div class="forecast-details">' +
        '<div class="forecast-detail"><span>Máximo histórico</span><strong>' + max + '</strong></div>' +
        '<div class="forecast-detail"><span>Mínimo histórico</span><strong>' + min + '</strong></div>' +
        '<div class="forecast-detail"><span>Muestras</span><strong>'         + samples + '</strong></div>' +
      '</div>';
  }

  function renderHeatmap(heatmap) {
    if (!heatmap || !heatmap.length) {
      els.heatmap.innerHTML = '<p class="insights-empty">Sin datos de horario en las últimas 4 semanas.</p>';
      return;
    }
    var maxAvg = heatmap.reduce(function (m, r) { return Math.max(m, Number(r.avg_per_day || 0)); }, 0);

    var html = '<div class="bar-chart">';
    heatmap.forEach(function (row) {
      var hour   = Number(row.hour_of_day || 0);
      var avg    = Number(row.avg_per_day || 0);
      var isPeak = maxAvg > 0 && avg >= maxAvg * 0.85;
      var pct    = maxAvg > 0 ? Math.max(2, Math.round((avg / maxAvg) * 100)) : 2;
      html +=
        '<div class="bar-chart__row">' +
          '<span class="bar-chart__label">' + String(hour).padStart(2, "0") + ':00</span>' +
          '<div class="bar-chart__track"><div class="bar-chart__fill' + (isPeak ? ' bar-chart__fill--peak' : '') + '" style="width:' + pct + '%"></div></div>' +
          '<span class="bar-chart__value">' + avg.toFixed(1) + ' / día</span>' +
        '</div>';
    });
    html += '</div>';

    var peaks = heatmap.filter(function (r) { return maxAvg > 0 && Number(r.avg_per_day || 0) >= maxAvg * 0.85; });
    if (peaks.length) {
      var labels = peaks.map(function (r) { return String(Number(r.hour_of_day)).padStart(2, "0") + ":00"; }).join(", ");
      html += '<p class="muted" style="margin-top:0.9rem;font-size:0.85rem;">Pico de mayor demanda: <strong>' + escHtml(labels) + '</strong>. Ideal para tener el equipo completo disponible.</p>';
    }
    els.heatmap.innerHTML = html;
  }

  function renderWeekly(weekly) {
    if (!weekly || !weekly.length) {
      els.weekly.innerHTML = '<p class="insights-empty">Sin historial financiero disponible todavía.</p>';
      return;
    }
    var html =
      '<div class="weekly-table">' +
        '<div class="weekly-table__head"><span>Semana</span><span>SINPE</span><span>Efectivo</span><span class="weekly-cell--revenue">Total</span><span>Cancelac.</span></div>';

    weekly.forEach(function (row) {
      var cancelled  = Number(row.cancelled_orders      || 0);
      var cancelRate = Number(row.cancellation_rate_pct || 0);
      var weekLabel  = row.week_start ? new Intl.DateTimeFormat("es-CR", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(row.week_start + "T12:00:00Z")) : "-";

      html +=
        '<div class="weekly-table__row">' +
          '<span>' + escHtml(weekLabel) + '</span>' +
          '<span>' + fmt.currency(row.sinpe_revenue) + '<br><span style="font-size:0.75rem;color:var(--muted)">' + (row.sinpe_count || 0) + ' pedidos</span></span>' +
          '<span>' + fmt.currency(row.cash_revenue)  + '<br><span style="font-size:0.75rem;color:var(--muted)">' + (row.cash_count  || 0) + ' pedidos</span></span>' +
          '<span class="weekly-cell--revenue">' + fmt.currency(row.total_revenue) + '</span>' +
          '<span class="' + (cancelled > 0 ? 'weekly-cell--cancel' : '') + '">' + (cancelled > 0 ? cancelled + ' (' + cancelRate + '%)' : '0') + '</span>' +
        '</div>';
    });
    html += '</div>';
    els.weekly.innerHTML = html;
  }

  // ── Data fetching ─────────────────────────────────────────────────

  async function refreshDashboard() {
    try {
      var snapshot = await api.fetchJson("/dashboard");
      renderDashboard(snapshot);
      setBannerSynced();
    } catch (err) {
      setFeedback(err.message, true);
    }
  }

  async function refreshAdminOrders() {
    try {
      var snapshot = await api.fetchJson("/admin-orders", { method: "POST", body: { action: "list" } });
      renderAdminOrders(snapshot);
    } catch (err) {
      setFeedback(err.message, true);
    }
  }

  async function refreshDeliveries() {
    try {
      var snapshot = await api.fetchJson("/deliveries");
      renderDeliveries(snapshot);
      setBannerSynced();
    } catch (err) {
      setFeedback(err.message, true);
      setBannerError(loadAll);
    }
  }

  async function refreshAnalytics() {
    try {
      var payload = await api.fetchJson("/admin-analytics", { method: "POST", body: {} });
      if (els.insightsUpdatedAt) els.insightsUpdatedAt.textContent = fmt.dateTime(payload.updatedAt);
      renderPrepList(payload.prep);
      renderForecast(payload.todayForecast);
      renderHeatmap(payload.heatmap);
      renderWeekly(payload.weekly);
    } catch (_) {
      if (els.insightsUpdatedAt) els.insightsUpdatedAt.textContent = "Error al cargar análisis";
    }
  }

  async function loadAll() {
    banner.setSyncing();
    if (userRole === "ADMIN") {
      await Promise.all([refreshDashboard(), refreshAdminOrders()]);
    } else {
      await refreshDeliveries();
    }
  }

  // ── Mutations ─────────────────────────────────────────────────────

  async function submitMenu(event) {
    event.preventDefault();
    if (isSaving) return;

    var fd    = new FormData(els.menuForm);
    var title = String(fd.get("title") || "").trim();
    var desc  = String(fd.get("description") || "").trim();
    var price = Number(fd.get("price") || 0);

    if (!title || !desc || price < 0) {
      setFeedback("Complete el nombre, descripción y precio.", true);
      return;
    }

    isSaving = true;
    els.menuSubmit.disabled = true;
    setFeedback("Guardando menú del día...", false);
    banner.setSyncing();

    try {
      var result = await api.fetchJson("/menu", { method: "POST", body: { menu: { title, description: desc, price } } });
      setFeedback(result.message || "Menú actualizado correctamente.", false);
      clearEmailWarning();
      if (result.snapshot && userRole === "ADMIN") renderDashboard(result.snapshot);
      if (userRole === "ADMIN") await refreshAdminOrders();
      else                      await refreshDeliveries();
      banner.setSynced();
    } catch (err) {
      setFeedback(err.message, true);
      banner.setError(null);
    } finally {
      isSaving = false;
      els.menuSubmit.disabled = false;
    }
  }

  async function updatePaymentStatus(orderId, paymentStatus) {
    banner.setSyncing();
    try {
      var snapshot = await api.fetchJson("/admin-orders", {
        method: "POST",
        body:   { action: "updatePaymentStatus", orderId, paymentStatus }
      });
      renderAdminOrders(snapshot);
      setFeedback("Estado de pago actualizado.", false);
      banner.setSynced();
      if (snapshot.emailWarning) showEmailWarning(snapshot.emailWarning);
      else                       clearEmailWarning();
    } catch (err) {
      setFeedback(err.message, true);
      banner.setError(function () { updatePaymentStatus(orderId, paymentStatus); });
    }
  }

  async function updateDeliveryStatus(orderId, deliveryStatus) {
    banner.setSyncing();
    setFeedback("Actualizando...", false);
    try {
      var snapshot = await api.fetchJson("/deliveries", { method: "POST", body: { orderId, deliveryStatus } });
      renderDeliveries(snapshot);
      banner.setSynced();
      if (snapshot.emailWarning) setFeedback(snapshot.emailWarning, false);
      else                       setFeedback("", false);
    } catch (err) {
      setFeedback(err.message, true);
      banner.setError(function () { updateDeliveryStatus(orderId, deliveryStatus); });
    }
  }

  async function exportOrders() {
    if (!els.exportButton) return;
    els.exportButton.disabled = true;
    setFeedback("Exportando pedidos...", false);
    try {
      var now      = new Date();
      var fileDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
      await api.downloadFile("/orders-export", {}, "orders-" + fileDate + ".csv");
      setFeedback("Archivo exportado correctamente.", false);
    } catch (err) {
      setFeedback(err.message, true);
    } finally {
      els.exportButton.disabled = false;
    }
  }

  // ── Supabase Realtime subscription (Priority 6) ───────────────────
  // When any order changes for this cafeteria, trigger a lightweight
  // refresh. The 60 s setInterval below is the offline fallback only.

  function subscribeRealtime(cid) {
    var cfg = window.APP_CONFIG || {};
    if (!cfg.supabaseUrl || cfg.supabaseUrl.includes("REPLACE_WITH") ||
        !cfg.supabaseAnonKey || cfg.supabaseAnonKey.includes("REPLACE_WITH")) {
      return;
    }

    if (realtimeChannel) {
      window.supabaseClient.removeChannel(realtimeChannel);
    }

    realtimeChannel = window.supabaseClient
      .channel("management-" + cid)
      .on("postgres_changes", {
        event:  "*",
        schema: "public",
        table:  "orders",
        filter: "cafeteria_id=eq." + cid
      }, function () {
        // Ignore events triggered by this same session's mutations
        // (the mutation handlers already update the UI synchronously).
        loadAll();
      })
      .subscribe();
  }

  // Banner wrappers (used by async functions above)
  function setBannerSynced() { banner.setSynced(); }
  function setBannerError(fn) { banner.setError(fn); }

  // ── Init ──────────────────────────────────────────────────────────

  async function start() {
    banner.init();

    // 1. Verify Supabase session.
    var sessionResult = await window.supabaseClient.auth.getSession();
    var session       = sessionResult.data && sessionResult.data.session;
    if (!session) {
      window.location.replace("./index.html");
      return;
    }
    accessToken = session.access_token;

    // 2. Keep token fresh.
    window.supabaseClient.auth.onAuthStateChange(function (event, newSession) {
      if (!newSession) { window.location.replace("./index.html"); return; }
      accessToken = newSession.access_token;
    });

    // 3. Bind api client now that accessToken is set.
    api = window.SE.api.make(function () { return accessToken; });

    // 4. Fetch authoritative role + cafeteriaId from the server.
    var roleData;
    try {
      roleData = await api.fetchJson("/auth-role");
    } catch (_) {
      window.location.replace("./index.html");
      return;
    }
    userRole    = roleData.role;
    cafeteriaId = roleData.cafeteriaId;

    // 5. Adapt the page to this role.
    adaptToRole(userRole);
    if (userRole === "ADMIN") initTabs();

    // 6. Wire up interactions.
    if (els.menuForm)     els.menuForm.addEventListener("submit", submitMenu);
    if (els.exportButton) els.exportButton.addEventListener("click", exportOrders);
    if (els.logoutButton) els.logoutButton.addEventListener("click", function () {
      window.supabaseClient.auth.signOut();
      window.location.replace("./index.html");
    });

    // 7. Initial data load.
    await loadAll();

    // 8. Realtime — instant updates on order changes.
    subscribeRealtime(cafeteriaId);

    // 9. 60 s fallback for environments where WebSockets are blocked.
    window.setInterval(loadAll, 60000);

    // 10. Analytics: background refresh every 5 min (ADMIN only, lazy).
    if (userRole === "ADMIN") {
      window.setInterval(function () {
        var insightsTab = document.getElementById("mgmtInsightsTab");
        if (insightsTab && !insightsTab.hidden) refreshAnalytics();
      }, 5 * 60 * 1000);
    }
  }

  start();
})();
