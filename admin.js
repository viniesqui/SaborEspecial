(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const els = {
    // Tabs
    adminTabs:               document.getElementById("adminTabs"),
    operationsTab:           document.getElementById("operationsTab"),
    insightsTab:             document.getElementById("insightsTab"),
    // Operations
    menuForm:                document.getElementById("menuForm"),
    adminSecretInput:        document.getElementById("adminSecret"),
    menuSubmitButton:        document.getElementById("menuSubmitButton"),
    menuFeedback:            document.getElementById("menuFeedback"),
    menuTitleInput:          document.getElementById("menuTitleInput"),
    menuDescriptionInput:    document.getElementById("menuDescriptionInput"),
    menuPriceInput:          document.getElementById("menuPriceInput"),
    exportOrdersButton:      document.getElementById("exportOrdersButton"),
    adminUpdatedAt:          document.getElementById("adminUpdatedAt"),
    currentMenuTitle:        document.getElementById("currentMenuTitle"),
    currentMenuDescription:  document.getElementById("currentMenuDescription"),
    currentMenuPrice:        document.getElementById("currentMenuPrice"),
    currentAvailableMeals:   document.getElementById("currentAvailableMeals"),
    currentSalesWindow:      document.getElementById("currentSalesWindow"),
    currentDeliveryWindow:   document.getElementById("currentDeliveryWindow"),
    adminOrdersTotal:        document.getElementById("adminOrdersTotal"),
    adminOrdersPaid:         document.getElementById("adminOrdersPaid"),
    adminOrdersPending:      document.getElementById("adminOrdersPending"),
    adminOrdersList:         document.getElementById("adminOrdersList"),
    adminOrderRowTemplate:   document.getElementById("adminOrderRowTemplate"),
    adminLogoutButton:       document.getElementById("adminLogoutButton"),
    // Insights
    insightsUpdatedAt:       document.getElementById("insightsUpdatedAt"),
    prepListContent:         document.getElementById("prepListContent"),
    forecastContent:         document.getElementById("forecastContent"),
    heatmapContent:          document.getElementById("heatmapContent"),
    weeklyContent:           document.getElementById("weeklyContent")
  };

  let isSaving = false;
  let accessToken = "";

  // -----------------------------------------------------------------------
  // Auth helpers
  // -----------------------------------------------------------------------

  async function requireAdminSession() {
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

    if (els.adminSecretInput) els.adminSecretInput.closest("label")?.remove();

    return true;
  }

  async function logout() {
    await window.supabaseClient.auth.signOut();
    window.location.replace("./index.html");
  }

  // -----------------------------------------------------------------------
  // Network helpers
  // -----------------------------------------------------------------------

  function authHeaders(extra) {
    return Object.assign({ "Authorization": "Bearer " + accessToken }, extra || {});
  }

  async function fetchJson(path, options) {
    if (!config.apiBaseUrl || config.apiBaseUrl.includes("PEGUE_AQUI")) {
      throw new Error("Debe configurar la URL del backend en config.js");
    }

    const requestOptions = {
      method: options && options.method ? options.method : "GET",
      headers: authHeaders()
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

  async function downloadFile(path, body, filename) {
    if (!config.apiBaseUrl || config.apiBaseUrl.includes("PEGUE_AQUI")) {
      throw new Error("Debe configurar la URL del backend en config.js");
    }

    const response = await fetch(config.apiBaseUrl + path, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body || {})
    });

    if (!response.ok) {
      const maybeJson = await response.json().catch(function () { return null; });
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

  // -----------------------------------------------------------------------
  // UI helpers
  // -----------------------------------------------------------------------

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

  function formatWeekStart(dateStr) {
    if (!dateStr) return "-";
    const d = new Date(dateStr + "T12:00:00Z");
    return new Intl.DateTimeFormat("es-CR", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC"
    }).format(d);
  }

  // -----------------------------------------------------------------------
  // Tab switching
  // -----------------------------------------------------------------------

  function initTabs() {
    els.adminTabs.addEventListener("click", function (e) {
      const btn = e.target.closest(".admin-tab");
      if (!btn) return;

      els.adminTabs.querySelectorAll(".admin-tab").forEach(function (t) {
        t.classList.remove("is-active");
      });
      btn.classList.add("is-active");

      const targetId = btn.dataset.tab;
      [els.operationsTab, els.insightsTab].forEach(function (section) {
        if (section.id === targetId) {
          section.removeAttribute("hidden");
        } else {
          section.setAttribute("hidden", "");
        }
      });
    });
  }

  // -----------------------------------------------------------------------
  // Operations — Rendering
  // -----------------------------------------------------------------------

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
      node.querySelector(".admin-order-meta").textContent =
        [order.buyerPhone, order.paymentReference].filter(Boolean).join(" | ") || "Sin referencia";
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

  // -----------------------------------------------------------------------
  // Insights — Rendering
  // -----------------------------------------------------------------------

  var DOW_NAMES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

  function renderPrepList(prep) {
    if (!prep || prep.length === 0) {
      els.prepListContent.innerHTML = '<p class="insights-empty">No hay pedidos activos para hoy. ¡Hora de preparar el menú!</p>';
      return;
    }

    // Aggregate across all menu_title groups (handles mid-day menu edits)
    var totals = prep.reduce(function (acc, row) {
      acc.total     += Number(row.total_portions     || 0);
      acc.confirmed += Number(row.confirmed_portions || 0);
      acc.pending   += Number(row.pending_portions   || 0);
      acc.sinpe     += Number(row.sinpe_count        || 0);
      acc.cash      += Number(row.cash_count         || 0);
      return acc;
    }, { total: 0, confirmed: 0, pending: 0, sinpe: 0, cash: 0 });

    var menuLabel = prep.length === 1
      ? prep[0].menu_title
      : prep.length + " variantes de menú";

    var confirmPct = totals.total > 0
      ? Math.round((totals.confirmed / totals.total) * 100)
      : 0;

    var html = "";
    html += '<div class="prep-hero">';
    html += '  <div class="prep-hero__count">' + totals.total + '</div>';
    html += '  <div class="prep-hero__label">porciones a preparar hoy</div>';
    html += '</div>';
    html += '<p class="prep-menu-title">' + escHtml(menuLabel) + ' · ' + confirmPct + '% confirmadas</p>';
    html += '<div class="prep-stats">';
    html += '  <div class="prep-stat prep-stat--confirmed">';
    html += '    <strong>' + totals.confirmed + '</strong>';
    html += '    <span>Confirmadas<br>(pago verificado)</span>';
    html += '  </div>';
    html += '  <div class="prep-stat prep-stat--pending">';
    html += '    <strong>' + totals.pending + '</strong>';
    html += '    <span>Pendientes<br>(pago no verificado)</span>';
    html += '  </div>';
    html += '  <div class="prep-stat">';
    html += '    <strong>' + totals.sinpe + '</strong>';
    html += '    <span>Por SINPE</span>';
    html += '  </div>';
    html += '  <div class="prep-stat">';
    html += '    <strong>' + totals.cash + '</strong>';
    html += '    <span>En Efectivo</span>';
    html += '  </div>';
    html += '</div>';

    els.prepListContent.innerHTML = html;
  }

  function renderForecast(todayForecast) {
    if (!todayForecast || Number(todayForecast.sample_days || 0) === 0) {
      els.forecastContent.innerHTML = '<p class="insights-empty">Datos insuficientes. Se necesita al menos una semana de historial para generar predicciones.</p>';
      return;
    }

    var avg      = Number(todayForecast.avg_orders  || 0);
    var maxOrds  = Number(todayForecast.max_orders  || 0);
    var minOrds  = Number(todayForecast.min_orders  || 0);
    var samples  = Number(todayForecast.sample_days || 0);
    var dow      = Number(todayForecast.day_of_week || 0);
    var dayName  = DOW_NAMES[dow] || "Hoy";
    var suggested = Math.ceil(avg * 1.2); // 20 % safety buffer

    var html = "";
    html += '<div class="forecast-main">';
    html += '  <div class="forecast-count">' + avg.toFixed(1) + '</div>';
    html += '  <p class="forecast-tip">Promedio histórico para los <strong>' + dayName + '</strong> de las últimas ' + samples + ' semanas. Se sugiere autorizar <strong>' + suggested + ' almuerzos</strong> (20% de margen).</p>';
    html += '</div>';
    html += '<div class="forecast-details">';
    html += '  <div class="forecast-detail">';
    html += '    <span>Máximo histórico</span>';
    html += '    <strong>' + maxOrds + '</strong>';
    html += '  </div>';
    html += '  <div class="forecast-detail">';
    html += '    <span>Mínimo histórico</span>';
    html += '    <strong>' + minOrds + '</strong>';
    html += '  </div>';
    html += '  <div class="forecast-detail">';
    html += '    <span>Muestras</span>';
    html += '    <strong>' + samples + '</strong>';
    html += '  </div>';
    html += '</div>';

    els.forecastContent.innerHTML = html;
  }

  function renderHeatmap(heatmap) {
    if (!heatmap || heatmap.length === 0) {
      els.heatmapContent.innerHTML = '<p class="insights-empty">Sin datos de horario en las últimas 4 semanas.</p>';
      return;
    }

    var maxAvg = heatmap.reduce(function (m, row) {
      return Math.max(m, Number(row.avg_per_day || 0));
    }, 0);

    var html = '<div class="bar-chart">';
    heatmap.forEach(function (row) {
      var hour    = Number(row.hour_of_day || 0);
      var avg     = Number(row.avg_per_day || 0);
      var isPeak  = maxAvg > 0 && avg >= maxAvg * 0.85;
      var pct     = maxAvg > 0 ? Math.max(2, Math.round((avg / maxAvg) * 100)) : 2;
      var label   = String(hour).padStart(2, "0") + ":00";

      html += '<div class="bar-chart__row">';
      html += '  <span class="bar-chart__label">' + label + '</span>';
      html += '  <div class="bar-chart__track">';
      html += '    <div class="bar-chart__fill' + (isPeak ? ' bar-chart__fill--peak' : '') + '" style="width:' + pct + '%"></div>';
      html += '  </div>';
      html += '  <span class="bar-chart__value">' + avg.toFixed(1) + ' / día</span>';
      html += '</div>';
    });
    html += '</div>';

    // Tip based on peak hours
    var peakRows = heatmap.filter(function (r) {
      return maxAvg > 0 && Number(r.avg_per_day || 0) >= maxAvg * 0.85;
    });
    if (peakRows.length > 0) {
      var peakLabels = peakRows.map(function (r) {
        return String(Number(r.hour_of_day)).padStart(2, "0") + ":00";
      }).join(", ");
      html += '<p class="muted" style="margin-top:0.9rem;font-size:0.85rem;">Pico de mayor demanda: <strong>' + peakLabels + '</strong>. Ideal para tener el equipo completo disponible.</p>';
    }

    els.heatmapContent.innerHTML = html;
  }

  function renderWeeklySummary(weekly) {
    if (!weekly || weekly.length === 0) {
      els.weeklyContent.innerHTML = '<p class="insights-empty">Sin historial financiero disponible todavía.</p>';
      return;
    }

    var html = "";
    html += '<div class="weekly-table">';
    html += '  <div class="weekly-table__head">';
    html += '    <span>Semana</span>';
    html += '    <span>SINPE</span>';
    html += '    <span>Efectivo</span>';
    html += '    <span class="weekly-cell--revenue">Total</span>';
    html += '    <span>Cancelac.</span>';
    html += '  </div>';

    weekly.forEach(function (row) {
      var totalRev   = Number(row.total_revenue  || 0);
      var sinpeRev   = Number(row.sinpe_revenue  || 0);
      var cashRev    = Number(row.cash_revenue   || 0);
      var sinpeCnt   = Number(row.sinpe_count    || 0);
      var cashCnt    = Number(row.cash_count     || 0);
      var cancelled  = Number(row.cancelled_orders      || 0);
      var cancelRate = Number(row.cancellation_rate_pct || 0);

      html += '<div class="weekly-table__row">';
      html += '  <span>' + formatWeekStart(row.week_start) + '</span>';
      html += '  <span>' + formatCurrency(sinpeRev) + '<br><span style="font-size:0.75rem;color:var(--muted)">' + sinpeCnt + ' pedidos</span></span>';
      html += '  <span>' + formatCurrency(cashRev)  + '<br><span style="font-size:0.75rem;color:var(--muted)">' + cashCnt  + ' pedidos</span></span>';
      html += '  <span class="weekly-cell--revenue">' + formatCurrency(totalRev) + '</span>';
      html += '  <span class="' + (cancelled > 0 ? 'weekly-cell--cancel' : '') + '">';
      html += cancelled > 0
        ? cancelled + ' (' + cancelRate + '%)'
        : '0';
      html += '  </span>';
      html += '</div>';
    });

    html += '</div>';
    els.weeklyContent.innerHTML = html;
  }

  function renderAnalytics(payload) {
    els.insightsUpdatedAt.textContent = formatDateTime(payload.updatedAt);
    renderPrepList(payload.prep);
    renderForecast(payload.todayForecast);
    renderHeatmap(payload.heatmap);
    renderWeeklySummary(payload.weekly);
  }

  // -----------------------------------------------------------------------
  // Escape helper (used in innerHTML rendering)
  // -----------------------------------------------------------------------

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // -----------------------------------------------------------------------
  // Online / Offline + Sync status banner
  // -----------------------------------------------------------------------

  function initStatusBanner() {
    const banner = document.getElementById("statusBanner");
    if (!banner) return;

    function update() {
      if (!navigator.onLine) {
        banner.dataset.state = "offline";
        banner.textContent = "Sin conexión — los cambios no se guardarán";
      } else {
        if (banner.dataset.state === "offline") {
          delete banner.dataset.state;
          banner.textContent = "";
        }
      }
    }

    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
  }

  function setBannerSyncing() {
    const banner = document.getElementById("statusBanner");
    if (!banner) return;
    banner.dataset.state = "syncing";
    banner.textContent = "Sincronizando...";
  }

  function setBannerSynced() {
    const banner = document.getElementById("statusBanner");
    if (!banner) return;
    banner.dataset.state = "synced";
    const t = new Date().toLocaleTimeString("es-CR", { hour: "2-digit", minute: "2-digit" });
    banner.textContent = "Sincronizado a las " + t;
    setTimeout(function () {
      delete banner.dataset.state;
      banner.textContent = "";
    }, 3000);
  }

  function setBannerError(retryFn) {
    const banner = document.getElementById("statusBanner");
    if (!banner) return;
    banner.dataset.state = "error";
    banner.textContent = "Error al sincronizar — toca para reintentar";
    banner.onclick = function () {
      banner.onclick = null;
      if (retryFn) retryFn();
    };
  }

  function clearEmailWarning() {
    const el = document.getElementById("emailWarningMsg");
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  function showEmailWarning(message) {
    const el = document.getElementById("emailWarningMsg");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }

  // -----------------------------------------------------------------------
  // Data fetching
  // -----------------------------------------------------------------------

  async function refreshSnapshot() {
    try {
      const snapshot = await fetchJson("/dashboard");
      renderSnapshot(snapshot);
    } catch (error) {
      setMenuFeedback(error.message, true);
    }
  }

  async function refreshAdminOrders() {
    try {
      const snapshot = await fetchJson("/admin-orders", {
        method: "POST",
        body: { action: "list" }
      });
      renderAdminOrders(snapshot);
    } catch (error) {
      setMenuFeedback(error.message, true);
    }
  }

  async function refreshAnalytics() {
    try {
      const payload = await fetchJson("/admin-analytics", {
        method: "POST",
        body: {}
      });
      renderAnalytics(payload);
    } catch (error) {
      // Non-critical: don't surface analytics errors over operations feedback
      if (els.insightsUpdatedAt) {
        els.insightsUpdatedAt.textContent = "Error al cargar análisis";
      }
    }
  }

  async function submitMenu(event) {
    event.preventDefault();
    if (isSaving) return;

    const formData = new FormData(els.menuForm);
    const payload = {
      title:       String(formData.get("title")       || "").trim(),
      description: String(formData.get("description") || "").trim(),
      price:       Number(formData.get("price")        || 0)
    };

    if (!payload.title || !payload.description || payload.price < 0) {
      setMenuFeedback("Complete el nombre, la descripcion y el precio.", true);
      return;
    }

    isSaving = true;
    els.menuSubmitButton.disabled = true;
    setMenuFeedback("Guardando menú del día...", false);

    try {
      const result = await fetchJson("/menu", {
        method: "POST",
        body: { menu: payload }
      });

      setMenuFeedback(result.message || "Menú actualizado correctamente.", false);
      clearEmailWarning();
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
    els.exportOrdersButton.disabled = true;
    setMenuFeedback("Exportando pedidos...", false);

    try {
      const now = new Date();
      const fileDate = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
      ].join("-");

      await downloadFile("/orders-export", {}, `orders-${fileDate}.csv`);
      setMenuFeedback("Archivo exportado correctamente.", false);
    } catch (error) {
      setMenuFeedback(error.message, true);
    } finally {
      els.exportOrdersButton.disabled = false;
    }
  }

  async function updatePaymentStatus(orderId, paymentStatus) {
    setBannerSyncing();
    try {
      const snapshot = await fetchJson("/admin-orders", {
        method: "POST",
        body: { action: "updatePaymentStatus", orderId, paymentStatus }
      });
      renderAdminOrders(snapshot);
      setMenuFeedback("Estado de pago actualizado.", false);
      setBannerSynced();
      if (snapshot.emailWarning) {
        showEmailWarning(snapshot.emailWarning);
      } else {
        clearEmailWarning();
      }
    } catch (error) {
      setMenuFeedback(error.message, true);
      setBannerError(function () { updatePaymentStatus(orderId, paymentStatus); });
    }
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  async function start() {
    if (!(await requireAdminSession())) return;

    initTabs();

    els.menuForm.addEventListener("submit", submitMenu);
    els.exportOrdersButton.addEventListener("click", exportOrders);
    if (els.adminLogoutButton) {
      els.adminLogoutButton.addEventListener("click", logout);
    }

    initStatusBanner();

    // Initial load — all data in parallel
    refreshSnapshot();
    refreshAdminOrders();
    refreshAnalytics();

    // Operations: refresh every 30 s
    window.setInterval(function () {
      refreshSnapshot();
      refreshAdminOrders();
    }, Number(config.refreshIntervalMs || 30000));

    // Analytics: refresh every 5 min (historical data changes slowly)
    window.setInterval(refreshAnalytics, 5 * 60 * 1000);
  }

  start();
})();
