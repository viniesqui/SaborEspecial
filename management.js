(function () {
  "use strict";

  var accessToken      = "";
  var userRole         = "";
  var cafeteriaId      = "";
  var isSaving         = false;
  var realtimeChannel  = null;
  var selectedDayKey   = "";   // The day currently loaded in the menu form
  var weekMenus        = [];   // Cache of the 7-day grid data

  var banner = window.SE.banner;
  var fmt    = window.SE.fmt;
  var api;

  // Spanish day abbreviations — index matches Date.getDay() (0=Sun, 1=Mon…)
  var DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

  // ── Element refs ──────────────────────────────────────────────────
  var els = {
    pageTitle:         document.getElementById("mgmtPageTitle"),
    tabs:              document.getElementById("mgmtTabs"),
    updatedAt:         document.getElementById("mgmtUpdatedAt"),
    // Weekly grid
    weekCards:         document.getElementById("mgmtWeekCards"),
    // Menu form
    menuForm:          document.getElementById("mgmtMenuForm"),
    menuDayKey:        document.getElementById("mgmtMenuDayKey"),
    menuTitleInput:    document.getElementById("mgmtMenuTitle"),
    menuDescInput:     document.getElementById("mgmtMenuDescription"),
    menuPriceInput:    document.getElementById("mgmtMenuPrice"),
    menuCostInput:     document.getElementById("mgmtMenuCost"),
    menuSubmit:        document.getElementById("mgmtMenuSubmit"),
    menuFeedback:      document.getElementById("mgmtMenuFeedback"),
    emailWarning:      document.getElementById("mgmtEmailWarning"),
    selectedDayLabel:  document.getElementById("mgmtSelectedDayLabel"),
    exportButton:      document.getElementById("mgmtExportButton"),
    // Admin current-menu summary
    currentMenuTitle:  document.getElementById("mgmtCurrentMenuTitle"),
    currentMenuDesc:   document.getElementById("mgmtCurrentMenuDescription"),
    currentMenuPrice:  document.getElementById("mgmtCurrentMenuPrice"),
    availableMeals:    document.getElementById("mgmtAvailableMeals"),
    salesWindow:       document.getElementById("mgmtSalesWindow"),
    deliveryWindow:    document.getElementById("mgmtDeliveryWindow"),
    digitalCount:      document.getElementById("mgmtDigitalCount"),
    walkInCount:       document.getElementById("mgmtWalkInCount"),
    // Admin orders
    adminTotal:        document.getElementById("mgmtAdminTotal"),
    adminPaid:         document.getElementById("mgmtAdminPaid"),
    adminPending:      document.getElementById("mgmtAdminPending"),
    adminOrdersList:   document.getElementById("mgmtAdminOrdersList"),
    adminRowTemplate:  document.getElementById("adminOrderRowTemplate"),
    // Admin delivery-status overview
    adminDeliveriesList:    document.getElementById("mgmtAdminDeliveriesList"),
    adminDeliveryRowTpl:    document.getElementById("adminDeliveryRowTemplate"),
    adminPendingDeliveries: document.getElementById("mgmtAdminPendingDeliveries"),
    adminDeliveredOrders:   document.getElementById("mgmtAdminDeliveredOrders"),
    // Settings
    settingsCard:      document.getElementById("mgmtSettingsCard"),
    settingsForm:      document.getElementById("mgmtSettingsForm"),
    settingsFeedback:  document.getElementById("mgmtSettingsFeedback"),
    settingsUpdatedAt: document.getElementById("mgmtSettingsUpdatedAt"),
    setMaxMeals:       document.getElementById("setMaxMeals"),
    setSalesStart:     document.getElementById("setSalesStart"),
    setSalesEnd:       document.getElementById("setSalesEnd"),
    setCutoffTime:     document.getElementById("setCutoffTime"),
    setDeliveryWindow: document.getElementById("setDeliveryWindow"),
    setMessage:        document.getElementById("setMessage"),
    setDisableWindow:  document.getElementById("setDisableWindow"),
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
    // Accounting
    accountingMonth:       document.getElementById("accountingMonth"),
    accountingExportBtn:   document.getElementById("accountingExportBtn"),
    accountingUpdatedAt:   document.getElementById("accountingUpdatedAt"),
    accountingKpis:        document.getElementById("accountingKpis"),
    accountingStability:   document.getElementById("accountingStability"),
    accountingRecommendations: document.getElementById("accountingRecommendations"),
    accountingDaily:       document.getElementById("accountingDaily"),
    // Manual sale modal
    manualSaleButton:   document.getElementById("mgmtManualSaleButton"),
    manualSaleDialog:   document.getElementById("manualSaleDialog"),
    manualSaleForm:     document.getElementById("manualSaleForm"),
    manualSaleName:     document.getElementById("manualSaleName"),
    manualSaleMethod:   document.getElementById("manualSaleMethod"),
    manualSaleSubmit:   document.getElementById("manualSaleSubmit"),
    manualSaleCancel:   document.getElementById("manualSaleCancel"),
    manualSaleFeedback: document.getElementById("manualSaleFeedback"),
    // Staff (Equipo)
    staffInviteForm:    document.getElementById("staffInviteForm"),
    staffInviteEmail:   document.getElementById("staffInviteEmail"),
    staffInviteRole:    document.getElementById("staffInviteRole"),
    staffInviteSubmit:  document.getElementById("staffInviteSubmit"),
    staffInviteFeedback: document.getElementById("staffInviteFeedback"),
    staffList:          document.getElementById("staffList"),
    // Diagnostics
    diagnosticsContent:    document.getElementById("diagnosticsContent"),
    diagnosticsRefreshBtn: document.getElementById("diagnosticsRefreshBtn"),
    // Logout
    logoutButton:      document.getElementById("mgmtLogoutButton")
  };

  // ── Helpers ───────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function todayKeyFromBrowser() {
    // Mirrors getDayKey() from lib/dashboard.js: UTC-6 shift.
    return new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function formatDateLabel(dateStr) {
    // "2026-04-28" → "Mar 28 abr"
    var d    = new Date(dateStr + "T12:00:00Z");
    var day  = DIAS[d.getUTCDay()];
    var dom  = d.getUTCDate();
    var mon  = d.toLocaleDateString("es-CR", { month: "short", timeZone: "UTC" });
    return day + " " + dom + " " + mon;
  }

  // ── Role-based UI adaptation ──────────────────────────────────────

  function adaptToRole(role) {
    var isAdmin = role === "ADMIN";
    document.querySelectorAll(".admin-only").forEach(function (el) { el.hidden = !isAdmin; });
    document.querySelectorAll(".helper-only").forEach(function (el) { el.hidden = isAdmin; });
    if (els.pageTitle) els.pageTitle.textContent = isAdmin ? "Administración" : "Asistente";
    document.title = (isAdmin ? "Administración" : "Asistente") + " | Almuerzos CEEP";
  }

  // ── Tab switching (ADMIN only) ────────────────────────────────────

  var TAB_IDS = ["mgmtOperationsTab", "mgmtInsightsTab", "mgmtAccountingTab", "mgmtStaffTab", "mgmtDiagnosticsTab"];

  function showTab(targetId) {
    TAB_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = (el.id !== targetId);
    });
    if (els.tabs) {
      els.tabs.querySelectorAll(".admin-tab").forEach(function (t) {
        t.classList.toggle("is-active", t.dataset.tab === targetId);
      });
    }
    if (targetId === "mgmtInsightsTab")    refreshAnalytics();
    if (targetId === "mgmtAccountingTab")  refreshAccounting();
    if (targetId === "mgmtStaffTab")       refreshStaff();
    if (targetId === "mgmtDiagnosticsTab") refreshDiagnostics();
  }

  function initTabs() {
    if (!els.tabs) return;
    els.tabs.addEventListener("click", function (e) {
      var btn = e.target.closest(".admin-tab");
      if (!btn) return;
      showTab(btn.dataset.tab);
    });
    // adaptToRole flipped every .admin-only element to hidden=false, including
    // the two non-active tab panels. Re-assert the active tab so only one shows.
    var active = els.tabs.querySelector(".admin-tab.is-active");
    showTab(active ? active.dataset.tab : "mgmtOperationsTab");
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

  // ── Weekly grid ───────────────────────────────────────────────────

  function renderWeekGrid(days) {
    weekMenus = days || [];
    if (!els.weekCards) return;
    if (!weekMenus.length) {
      els.weekCards.innerHTML = '<p class="insights-empty">No se pudo cargar la programación semanal.</p>';
      return;
    }

    var todayKey = todayKeyFromBrowser();
    var html = "";
    weekMenus.forEach(function (day) {
      var isToday    = day.date === todayKey;
      var isSelected = day.date === selectedDayKey;
      var hasMenu    = Boolean(day.menu);
      var statusText = hasMenu ? escHtml(day.menu.title) : "Sin menú";
      var cardClass  = "week-grid__card" +
        (isSelected ? " is-active"   : "") +
        (isToday    ? " is-today"    : "") +
        (!hasMenu   ? " is-no-menu"  : "");

      html +=
        '<div class="' + cardClass + '" role="listitem">' +
          '<button type="button" class="week-grid__btn" data-day-key="' + escHtml(day.date) + '" ' +
            'aria-pressed="' + (isSelected ? "true" : "false") + '">' +
            '<span class="week-grid__day-name">' + escHtml(formatDateLabel(day.date)) + (isToday ? ' <em>(hoy)</em>' : '') + '</span>' +
            '<span class="week-grid__menu-title">' + statusText + '</span>' +
            (hasMenu ? '<span class="week-grid__price">' + escHtml(fmt.currency(day.menu.price)) + '</span>' : '') +
          '</button>' +
        '</div>';
    });
    els.weekCards.innerHTML = html;

    // Attach click handlers to each day button
    els.weekCards.querySelectorAll(".week-grid__btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectDay(btn.dataset.dayKey);
      });
    });
  }

  function selectDay(dayKey) {
    selectedDayKey = dayKey;

    // Update form state
    if (els.menuDayKey) els.menuDayKey.value = dayKey;

    var todayKey   = todayKeyFromBrowser();
    var dateLabel  = dayKey === todayKey ? "hoy (" + formatDateLabel(dayKey) + ")" : formatDateLabel(dayKey);
    if (els.selectedDayLabel) els.selectedDayLabel.textContent = dateLabel;

    // Pre-fill form with this day's existing menu if available
    if (!isSaving) {
      var day  = weekMenus.find(function (d) { return d.date === dayKey; });
      var menu = day && day.menu;
      if (els.menuTitleInput) els.menuTitleInput.value = menu ? menu.title       : "";
      if (els.menuDescInput)  els.menuDescInput.value  = menu ? menu.description : "";
      if (els.menuPriceInput) els.menuPriceInput.value = menu ? menu.price       : "";
      if (els.menuCostInput)  els.menuCostInput.value  = (menu && menu.cost_per_dish) ? menu.cost_per_dish : "";
    }

    // Refresh the visual selection state in the grid
    if (els.weekCards) {
      els.weekCards.querySelectorAll(".week-grid__card").forEach(function (card) {
        var btn = card.querySelector(".week-grid__btn");
        var isActive = btn && btn.dataset.dayKey === dayKey;
        card.classList.toggle("is-active", isActive);
        if (btn) btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }

    setFeedback("", false);
  }

  // ── ADMIN rendering ───────────────────────────────────────────────

  function renderDashboard(snapshot) {
    var menu    = snapshot.menu;  // may be null when no menu is configured
    var hasMenu = Boolean(menu);
    if (els.updatedAt)          els.updatedAt.textContent         = fmt.dateTime(snapshot.updatedAt);
    if (els.currentMenuTitle)   els.currentMenuTitle.textContent  = hasMenu ? menu.title : "No hay menú para hoy";
    if (els.currentMenuDesc)    els.currentMenuDesc.textContent   = hasMenu
      ? (menu.description || "No hay descripción disponible.")
      : "Publica el menú del día desde la pestaña de menú para habilitar las ventas.";
    if (els.currentMenuPrice)   els.currentMenuPrice.textContent  = hasMenu ? fmt.currency(menu.price) : "-";
    if (els.availableMeals)     els.availableMeals.textContent    = String(snapshot.availableMeals || 0);
    if (els.salesWindow)        els.salesWindow.textContent       = snapshot.salesWindow    || "-";
    if (els.deliveryWindow)     els.deliveryWindow.textContent    = snapshot.deliveryWindow || "-";
    if (els.digitalCount)       els.digitalCount.textContent      = String(snapshot.digitalCount || 0);
    if (els.walkInCount)        els.walkInCount.textContent       = String(snapshot.walkInCount  || 0);

    // Walk-in POS sales require a menu — disable the button when it's missing
    // so the staff doesn't get a confusing "No hay menú" error mid-checkout.
    if (els.manualSaleButton) {
      els.manualSaleButton.disabled = !hasMenu;
      els.manualSaleButton.title    = hasMenu ? "" : "Publica el menú del día para habilitar ventas manuales.";
    }
  }

  function renderAdminOrders(snapshot) {
    if (els.adminTotal)   els.adminTotal.textContent   = String(snapshot.totalOrders         || 0);
    if (els.adminPaid)    els.adminPaid.textContent    = String(snapshot.paidCount           || 0);
    if (els.adminPending) els.adminPending.textContent = String(snapshot.pendingPaymentCount || 0);
    if (els.digitalCount) els.digitalCount.textContent = String(snapshot.digitalCount || 0);
    if (els.walkInCount)  els.walkInCount.textContent  = String(snapshot.walkInCount  || 0);

    if (!els.adminOrdersList || !els.adminRowTemplate) return;
    els.adminOrdersList.innerHTML = "";

    var orders = snapshot.orders || [];
    if (!orders.length) {
      els.adminOrdersList.innerHTML = '<div class="admin-orders-table__empty">No hay pedidos registrados hoy.</div>';
      return;
    }

    var fragment = document.createDocumentFragment();
    orders.forEach(function (order) {
      var node     = els.adminRowTemplate.content.cloneNode(true);
      var isWalkIn = order.orderChannel === "WALK_IN";

      node.querySelector(".admin-order-name").textContent   = order.buyerName;

      var channelBadge = node.querySelector(".channel-badge--walk-in");
      if (channelBadge) channelBadge.hidden = !isWalkIn;

      node.querySelector(".admin-order-meta").textContent   = [order.buyerPhone, order.paymentReference].filter(Boolean).join(" | ") || "Sin referencia";
      node.querySelector(".admin-order-date").textContent   = order.createdAtLabel || "-";
      node.querySelector(".admin-order-method").textContent = String(order.paymentMethod || "").toUpperCase() === "SINPE" ? "SINPE" : "EFECTIVO";

      var statusNode = node.querySelector(".admin-order-status");
      var isPaid     = fmt.paymentLabel(order.paymentStatus) === "PAGADO";
      statusNode.textContent = isPaid ? "PAGADO" : "PENDIENTE DE PAGO";
      statusNode.className   = isPaid
        ? "admin-order-status admin-order-status--paid"
        : "admin-order-status admin-order-status--pending";

      node.querySelector(".admin-order-confirmed-at").textContent = order.paymentConfirmedAtLabel || "Sin verificar";

      node.querySelectorAll(".payment-toggle").forEach(function (btn) {
        if (!btn.dataset.paymentStatus) return; // skip non-status buttons (e.g. delete)
        btn.classList.toggle("is-selected", btn.dataset.paymentStatus === order.paymentStatus);
        btn.addEventListener("click", function () { updatePaymentStatus(order.id, btn.dataset.paymentStatus); });
      });

      var deleteBtn = node.querySelector(".admin-order-delete");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", function () {
          var confirmMsg = "¿Eliminar el pedido de " + (order.buyerName || "este cliente") +
            "? Esta acción no se puede deshacer.";
          if (window.confirm(confirmMsg)) deleteOrder(order.id);
        });
      }

      fragment.appendChild(node);
    });
    els.adminOrdersList.appendChild(fragment);
  }

  // ── ADMIN delivery-status overview (read-only) ───────────────────
  var DELIVERY_LABEL = {
    PENDIENTE_ENTREGA:   { text: "PENDIENTE",     mod: "pending"  },
    EN_PREPARACION:      { text: "EN PREPARACIÓN", mod: "prep"     },
    LISTO_PARA_ENTREGA:  { text: "LISTO",         mod: "ready"    },
    ENTREGADO:           { text: "ENTREGADO",     mod: "done"     }
  };

  function renderAdminDeliveries(snapshot) {
    if (els.adminPendingDeliveries) els.adminPendingDeliveries.textContent = String(snapshot.pendingDeliveries || 0);
    if (els.adminDeliveredOrders)   els.adminDeliveredOrders.textContent   = String(snapshot.deliveredOrders   || 0);

    if (!els.adminDeliveriesList || !els.adminDeliveryRowTpl) return;
    els.adminDeliveriesList.innerHTML = "";

    var orders = snapshot.orders || [];
    if (!orders.length) {
      els.adminDeliveriesList.innerHTML = '<div class="delivery-table__empty">No hay pedidos registrados hoy.</div>';
      return;
    }

    var fragment = document.createDocumentFragment();
    orders.forEach(function (order) {
      var node  = els.adminDeliveryRowTpl.content.cloneNode(true);
      var label = DELIVERY_LABEL[order.deliveryStatus] || DELIVERY_LABEL.PENDIENTE_ENTREGA;
      var paid  = fmt.paymentLabel(order.paymentStatus) === "PAGADO";

      node.querySelector(".buyer-name").textContent = order.buyerName;
      node.querySelector(".admin-delivery-meta").textContent =
        [order.paymentMethod, order.paymentReference].filter(Boolean).join(" · ") || "—";
      node.querySelector(".admin-delivery-created-at").textContent = order.createdAtLabel || "-";

      var pay = node.querySelector(".admin-delivery-payment");
      pay.textContent = paid ? "PAGADO" : "PENDIENTE";
      pay.className   = "delivery-payment-status admin-delivery-payment " +
        (paid ? "delivery-payment-status--paid" : "delivery-payment-status--pending");

      node.querySelectorAll(".admin-delivery-action").forEach(function (btn) {
        btn.classList.toggle("is-selected", btn.dataset.deliveryStatus === order.deliveryStatus);
        btn.addEventListener("click", function () { updateDeliveryStatus(order.id, btn.dataset.deliveryStatus); });
      });

      node.querySelector(".admin-delivery-delivered-at").textContent = order.deliveredAtLabel || "";
      fragment.appendChild(node);
    });
    els.adminDeliveriesList.appendChild(fragment);
  }

  // ── ADMIN settings card ──────────────────────────────────────────
  function timeToInputValue(t) {
    if (!t) return "";
    return String(t).slice(0, 5);
  }

  function fillSettingsForm(s) {
    if (!s) return;
    if (els.setMaxMeals)       els.setMaxMeals.value       = s.max_meals || 15;
    if (els.setSalesStart)     els.setSalesStart.value     = timeToInputValue(s.sales_start);
    if (els.setSalesEnd)       els.setSalesEnd.value       = timeToInputValue(s.sales_end);
    if (els.setCutoffTime)     els.setCutoffTime.value     = timeToInputValue(s.cutoff_time || "09:00");
    if (els.setDeliveryWindow) els.setDeliveryWindow.value = s.delivery_window || "";
    if (els.setMessage)        els.setMessage.value        = s.message || "";
    if (els.setDisableWindow)  els.setDisableWindow.checked = !!s.disable_sales_window;
    if (els.settingsUpdatedAt) els.settingsUpdatedAt.textContent =
      s.updated_at ? "Actualizado " + fmt.dateTime(s.updated_at) : "";
  }

  async function loadSettings() {
    if (!els.settingsForm) return;
    try {
      var resp = await api.fetchJson("/admin-orders", {
        method: "POST", body: { action: "getSettings" }
      });
      fillSettingsForm(resp.settings || {});
    } catch (err) {
      if (els.settingsFeedback) {
        els.settingsFeedback.textContent = "No se pudo cargar la configuración: " + (err.message || "");
        els.settingsFeedback.style.color = "#842f3d";
      }
    }
  }

  async function submitSettings(e) {
    e.preventDefault();
    if (!els.settingsForm) return;
    if (els.settingsFeedback) {
      els.settingsFeedback.textContent = "Guardando…";
      els.settingsFeedback.style.color = "#705d52";
    }
    var settings = {
      max_meals:            Number(els.setMaxMeals.value),
      sales_start:          els.setSalesStart.value,
      sales_end:            els.setSalesEnd.value,
      cutoff_time:          els.setCutoffTime.value,
      delivery_window:      els.setDeliveryWindow.value,
      message:              els.setMessage.value,
      disable_sales_window: !!els.setDisableWindow.checked
    };
    try {
      var resp = await api.fetchJson("/admin-orders", {
        method: "POST", body: { action: "updateSettings", settings: settings }
      });
      fillSettingsForm(resp.settings || settings);
      if (els.settingsFeedback) {
        els.settingsFeedback.textContent = "Configuración actualizada.";
        els.settingsFeedback.style.color = "#2f7a3a";
      }
      // Refresh dependent panels (availability / windows shown on operations card).
      loadAll();
    } catch (err) {
      if (els.settingsFeedback) {
        els.settingsFeedback.textContent = err.message || "No se pudo guardar la configuración.";
        els.settingsFeedback.style.color = "#842f3d";
      }
    }
  }

  // ── HELPER rendering ──────────────────────────────────────────────

  function renderDeliveries(snapshot) {
    if (els.updatedAt)          els.updatedAt.textContent          = fmt.dateTime(snapshot.updatedAt);
    if (els.totalOrders)        els.totalOrders.textContent        = String(snapshot.totalOrders        || 0);
    if (els.pendingPayment)     els.pendingPayment.textContent     = String(snapshot.pendingPaymentCount || 0);
    if (els.paidOrders)         els.paidOrders.textContent         = String(snapshot.paidOrders         || 0);
    if (els.deliveredOrders)    els.deliveredOrders.textContent    = String(snapshot.deliveredOrders    || 0);
    if (els.pendingDeliveries)  els.pendingDeliveries.textContent  = String(snapshot.pendingDeliveries  || 0);

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
        btn.addEventListener("click", function () { updateDeliveryStatus(order.id, btn.dataset.deliveryStatus); });
      });

      fragment.appendChild(node);
    });
    els.helperOrdersList.appendChild(fragment);
  }

  // ── Insights rendering (ADMIN only) ──────────────────────────────

  var DOW_NAMES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

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
      html += '<p class="muted" style="margin-top:0.9rem;font-size:0.85rem;">Pico de mayor demanda: <strong>' + escHtml(labels) + '</strong>.</p>';
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
      var weekLabel  = row.week_start
        ? new Intl.DateTimeFormat("es-CR", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(row.week_start + "T12:00:00Z"))
        : "-";
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

  // ── Accounting rendering (ADMIN only) ────────────────────────────

  var PRIORITY_LABELS = { high: "Alta prioridad", medium: "Importante", info: "Información" };

  function renderAccountingRecommendations(recs) {
    if (!els.accountingRecommendations) return;
    if (!recs || !recs.length) {
      els.accountingRecommendations.innerHTML =
        '<p class="insights-empty">Sin recomendaciones para este período.</p>';
      return;
    }
    var html = '<div class="rec-list">';
    recs.forEach(function (r) {
      var cls = "rec-card rec-card--" + (r.priority || "info");
      html +=
        '<div class="' + cls + '">' +
          '<div class="rec-card__header">' +
            '<span class="rec-card__badge">' + escHtml(PRIORITY_LABELS[r.priority] || "Aviso") + '</span>' +
            '<strong class="rec-card__title">' + escHtml(r.title) + '</strong>' +
          '</div>' +
          '<p class="rec-card__body">' + escHtml(r.message) + '</p>' +
        '</div>';
    });
    html += '</div>';
    els.accountingRecommendations.innerHTML = html;
  }

  function renderAccountingKpis(summary) {
    if (!els.accountingKpis) return;
    if (!summary) {
      els.accountingKpis.innerHTML = '<p class="insights-empty">Sin datos.</p>';
      return;
    }

    var hasCost = summary.estimatedCosts !== null;

    function kpi(label, value, sub, highlight) {
      return '<div class="kpi-card' + (highlight ? ' kpi-card--highlight' : '') + '">' +
        '<span class="kpi-card__label">' + escHtml(label) + '</span>' +
        '<strong class="kpi-card__value">' + escHtml(String(value)) + '</strong>' +
        (sub ? '<span class="kpi-card__sub">' + escHtml(sub) + '</span>' : '') +
        '</div>';
    }

    var html = '<div class="accounting-kpis">';
    html += kpi("Ingresos brutos",  fmt.currency(summary.grossRevenue), null, true);
    if (hasCost) {
      html += kpi("Costos estimados", fmt.currency(summary.estimatedCosts));
      html += kpi("Ganancia estimada", fmt.currency(summary.estimatedProfit),
        "Margen: " + summary.profitMarginPct + "%", true);
    }
    html += kpi("Almuerzos vendidos", summary.totalMealsSold + " platos",
      summary.activeDays + " días activos");
    html += kpi("Cupos sin vender",  summary.totalWastedMeals + " en total",
      "Prom. " + Math.round(summary.avgWaste * 10) / 10 + "/día");
    html += kpi("Efectivo",  fmt.currency(summary.cashRevenue));
    html += kpi("SINPE",     fmt.currency(summary.sinpeRevenue));
    html += kpi("Créditos",  fmt.currency(summary.creditRevenue),
      summary.avgCreditValuePerMeal > 0
        ? "Valor promedio por crédito: " + fmt.currency(summary.avgCreditValuePerMeal)
        : null);
    html += '</div>';

    els.accountingKpis.innerHTML = html;
  }

  function renderAccountingStability(summary) {
    if (!els.accountingStability) return;
    if (!summary || summary.totalMealsSold === 0) {
      els.accountingStability.innerHTML = '<p class="insights-empty">Sin ventas en este período.</p>';
      return;
    }

    var alacarteCount = summary.alacarteMeals;
    var creditCount   = summary.creditMeals;
    var total         = summary.totalMealsSold;
    var pkgPct        = Math.round((creditCount / total) * 100);
    var alaCartePct   = 100 - pkgPct;

    var barColor = pkgPct >= 30 ? "var(--success)" : pkgPct >= 15 ? "var(--warning)" : "var(--primary)";

    els.accountingStability.innerHTML =
      '<div class="stability-block">' +
        '<div class="stability-labels">' +
          '<span>A la carta <strong>' + alacarteCount + '</strong> (' + alaCartePct + '%)</span>' +
          '<span>Paquetes <strong>' + creditCount + '</strong> (' + pkgPct + '%)</span>' +
        '</div>' +
        '<div class="stability-bar">' +
          '<div class="stability-bar__fill stability-bar__fill--alacarte" style="width:' + alaCartePct + '%"></div>' +
          '<div class="stability-bar__fill stability-bar__fill--package" style="width:' + pkgPct + '%;background:' + barColor + '"></div>' +
        '</div>' +
        '<p class="stability-note">' +
          (pkgPct >= 30
            ? 'Tienes una base sólida de ingresos garantizados por paquetes.'
            : 'Menos del 30% de tus ventas son de paquetes. Mayor proporción = ingresos más predecibles.') +
        '</p>' +
      '</div>';
  }

  function renderAccountingDaily(daily) {
    if (!els.accountingDaily) return;
    if (!daily || !daily.length) {
      els.accountingDaily.innerHTML = '<p class="insights-empty">Sin ventas registradas en este período.</p>';
      return;
    }

    var hasCost = daily.some(function (d) { return d.costPerDish > 0; });

    var head =
      '<div class="acc-daily-head">' +
        '<span>Fecha / Menú</span>' +
        '<span>Vendidos / Cupo</span>' +
        '<span>Ingresos</span>' +
        (hasCost ? '<span>Costo / Ganancia</span>' : '') +
        '<span>Paquetes</span>' +
      '</div>';

    var rows = daily.map(function (d) {
      var dateLabel  = new Intl.DateTimeFormat("es-CR", { day: "2-digit", month: "short", weekday: "short", timeZone: "UTC" })
                         .format(new Date(d.date + "T12:00:00Z"));
      var wasteClass = d.wastedMeals > 3 ? " acc-waste--high" : d.wastedMeals > 0 ? " acc-waste--low" : "";
      var costCell   = hasCost
        ? '<span class="acc-daily__cost">' +
            (d.costPerDish > 0
              ? fmt.currency(d.estimatedCost) + '<br><span class="' +
                (d.estimatedProfit >= 0 ? 'acc-profit--pos' : 'acc-profit--neg') + '">' +
                (d.estimatedProfit >= 0 ? '+' : '') + fmt.currency(d.estimatedProfit) +
                (d.profitMarginPct !== null ? ' (' + d.profitMarginPct + '%)' : '') +
                '</span>'
              : '<span class="muted">Sin costo</span>') +
          '</span>'
        : '';
      return '<div class="acc-daily__row">' +
        '<span class="acc-daily__date"><strong>' + escHtml(dateLabel) + '</strong><br>' +
          '<span class="muted" style="font-size:0.8rem">' + escHtml(d.menuTitle) + '</span></span>' +
        '<span class="acc-daily__meals">' +
          '<strong>' + d.mealsSold + '</strong> / ' + d.maxMeals +
          '<br><span class="' + (wasteClass ? 'acc-waste' + wasteClass : 'muted') + '" style="font-size:0.8rem">' +
          (d.wastedMeals > 0 ? d.wastedMeals + ' sin vender' : 'Lleno') + '</span></span>' +
        '<span class="acc-daily__revenue">' + fmt.currency(d.grossRevenue) + '<br>' +
          '<span style="font-size:0.75rem;color:var(--muted)">SINPE ' + fmt.currency(d.sinpeRevenue) +
          ' · Cash ' + fmt.currency(d.cashRevenue) + '</span></span>' +
        costCell +
        '<span class="acc-daily__pkg">' +
          (d.creditRedemptions > 0
            ? '<span class="pkg-badge">' + d.creditRedemptions + ' crédito' + (d.creditRedemptions !== 1 ? 's' : '') + '</span>'
            : '<span class="muted">—</span>') +
        '</span>' +
      '</div>';
    }).join("");

    els.accountingDaily.innerHTML =
      '<div class="acc-daily-table">' + head + '<div class="acc-daily-body">' + rows + '</div></div>';
  }

  // ── Data fetching ─────────────────────────────────────────────────

  async function loadWeekMenus() {
    try {
      var result = await api.fetchJson("/menu");
      renderWeekGrid(result.weekMenus || []);
      // Auto-select today if nothing is selected yet
      if (!selectedDayKey && result.weekMenus && result.weekMenus.length) {
        selectDay(result.weekMenus[0].date);
      }
    } catch (_) {
      if (els.weekCards) els.weekCards.innerHTML = '<p class="insights-empty">Error al cargar la semana.</p>';
    }
  }

  async function refreshDashboard() {
    try {
      var snapshot = await api.fetchJson("/dashboard");
      renderDashboard(snapshot);
      banner.setSynced();
    } catch (err) {
      setFeedback(err.message, true);
    }
  }

  async function refreshAdminOrders() {
    try {
      var snapshot = await api.fetchJson("/admin-orders", { method: "POST", body: { action: "list" } });
      renderAdminOrders(snapshot);
      renderAdminDeliveries(snapshot);
    } catch (err) {
      setFeedback(err.message, true);
    }
  }

  async function refreshDeliveries() {
    try {
      var snapshot = await api.fetchJson("/deliveries");
      renderDeliveries(snapshot);
      banner.setSynced();
    } catch (err) {
      setFeedback(err.message, true);
      banner.setError(err.message, err.retryable !== false ? loadAll : null);
    }
  }

  function setAnalyticsError(message) {
    var msg = '<p class="insights-empty">' + escHtml(message || "No se pudo cargar el análisis.") + '</p>';
    if (els.prepList) els.prepList.innerHTML = msg;
    if (els.forecast) els.forecast.innerHTML = msg;
    if (els.heatmap)  els.heatmap.innerHTML  = msg;
    if (els.weekly)   els.weekly.innerHTML   = msg;
  }

  async function refreshAnalytics() {
    if (els.insightsUpdatedAt) els.insightsUpdatedAt.textContent = "Cargando...";
    if (els.prepList) els.prepList.innerHTML = '<p class="insights-empty">Cargando datos de producción...</p>';
    if (els.forecast) els.forecast.innerHTML = '<p class="insights-empty">Cargando predicción...</p>';
    if (els.heatmap)  els.heatmap.innerHTML  = '<p class="insights-empty">Cargando heatmap...</p>';
    if (els.weekly)   els.weekly.innerHTML   = '<p class="insights-empty">Cargando resumen financiero...</p>';
    try {
      var payload = await api.fetchJson("/admin-orders", { method: "POST", body: { action: "analytics" } });
      if (els.insightsUpdatedAt) els.insightsUpdatedAt.textContent = fmt.dateTime(payload.updatedAt);
      // Each renderer handles its own empty state; placeholders never linger.
      renderPrepList(payload.prep);
      renderForecast(payload.todayForecast);
      renderHeatmap(payload.heatmap);
      renderWeekly(payload.weekly);
    } catch (err) {
      if (els.insightsUpdatedAt) els.insightsUpdatedAt.textContent = "Error al cargar análisis";
      setAnalyticsError(err && err.message);
    }
  }

  async function refreshAccounting() {
    if (!els.accountingMonth) return;
    var month = els.accountingMonth.value; // "YYYY-MM"
    if (!month) return;

    if (els.accountingUpdatedAt) els.accountingUpdatedAt.textContent = "Cargando reporte...";
    if (els.accountingRecommendations) els.accountingRecommendations.innerHTML = '<p class="insights-empty">Calculando...</p>';
    if (els.accountingKpis)            els.accountingKpis.innerHTML = '<p class="insights-empty">Calculando...</p>';
    if (els.accountingStability)       els.accountingStability.innerHTML = '<p class="insights-empty">Calculando...</p>';
    if (els.accountingDaily)           els.accountingDaily.innerHTML = '<p class="insights-empty">Calculando...</p>';

    try {
      var payload = await api.fetchJson("/accounting", { method: "POST", body: { month } });
      if (els.accountingUpdatedAt) els.accountingUpdatedAt.textContent = fmt.dateTime(payload.updatedAt);
      renderAccountingRecommendations(payload.recommendations);
      renderAccountingKpis(payload.summary);
      renderAccountingStability(payload.summary);
      renderAccountingDaily(payload.daily);
    } catch (err) {
      if (els.accountingUpdatedAt) els.accountingUpdatedAt.textContent = "Error al cargar el reporte";
      var msg = '<p class="insights-empty">No se pudo cargar el reporte: ' + escHtml(err.message || "") + '</p>';
      if (els.accountingRecommendations) els.accountingRecommendations.innerHTML = msg;
      if (els.accountingKpis)            els.accountingKpis.innerHTML            = msg;
      if (els.accountingStability)       els.accountingStability.innerHTML       = msg;
      if (els.accountingDaily)           els.accountingDaily.innerHTML           = msg;
    }
  }

  async function exportAccounting() {
    if (!els.accountingExportBtn || !els.accountingMonth) return;
    var month = els.accountingMonth.value;
    if (!month) { setFeedback("Selecciona un mes antes de exportar.", true); return; }

    els.accountingExportBtn.disabled = true;
    try {
      await api.downloadFile("/accounting", { action: "export", month }, "rentabilidad-" + month + ".csv");
    } catch (err) {
      setFeedback(err.message, true);
    } finally {
      els.accountingExportBtn.disabled = false;
    }
  }

  async function loadAll() {
    banner.setSyncing();
    if (userRole === "ADMIN") {
      await Promise.all([refreshDashboard(), refreshAdminOrders(), loadWeekMenus()]);
    } else {
      await Promise.all([refreshDeliveries(), loadWeekMenus()]);
    }
  }

  // ── Mutations ─────────────────────────────────────────────────────

  async function submitMenu(event) {
    event.preventDefault();
    if (isSaving) return;

    var fd     = new FormData(els.menuForm);
    var title  = String(fd.get("title") || "").trim();
    var desc   = String(fd.get("description") || "").trim();
    var price  = Number(fd.get("price") || 0);
    var dayKey = String(fd.get("dayKey") || selectedDayKey || "").trim();
    var costRaw = fd.get("cost");
    var cost   = (costRaw !== null && costRaw !== "") ? Number(costRaw) : null;

    if (!title || !desc || price < 0) {
      setFeedback("Complete el nombre, descripción y precio.", true);
      return;
    }
    if (!dayKey) {
      setFeedback("Selecciona un día en la cuadrícula semanal.", true);
      return;
    }

    isSaving = true;
    els.menuSubmit.disabled = true;
    setFeedback("Guardando menú...", false);
    banner.setSyncing();

    try {
      var result = await api.fetchJson("/menu", {
        method: "POST",
        body:   { menu: { title, description: desc, price, cost }, dayKey }
      });
      setFeedback(result.message || "Menú actualizado correctamente.", false);
      clearEmailWarning();
      // Refresh the weekly grid so the saved day shows the new menu
      await loadWeekMenus();
      if (result.snapshot && userRole === "ADMIN") renderDashboard(result.snapshot);
      if (userRole === "ADMIN") await refreshAdminOrders();
      else                      await refreshDeliveries();
      banner.setSynced();
    } catch (err) {
      setFeedback(err.message, true);
      banner.setError(err.message, null);
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
      banner.setError(err.message, err.retryable !== false ? function () { updatePaymentStatus(orderId, paymentStatus); } : null);
    }
  }

  async function deleteOrder(orderId) {
    banner.setSyncing();
    try {
      var snapshot = await api.fetchJson("/admin-orders", {
        method: "POST",
        body:   { action: "deleteOrder", orderId: orderId }
      });
      renderAdminOrders(snapshot);
      setFeedback("Pedido eliminado.", false);
      banner.setSynced();
      // Refresh the rest of the dashboard so deletion is reflected everywhere.
      loadAll();
    } catch (err) {
      setFeedback(err.message, true);
      banner.setError(err.message, err.retryable !== false ? function () { deleteOrder(orderId); } : null);
    }
  }

  async function updateDeliveryStatus(orderId, deliveryStatus) {
    banner.setSyncing();
    setFeedback("Actualizando...", false);
    try {
      var snapshot = await api.fetchJson("/deliveries", { method: "POST", body: { orderId, deliveryStatus } });
      renderDeliveries(snapshot);
      renderAdminDeliveries(snapshot);
      banner.setSynced();
      if (snapshot.emailWarning) setFeedback(snapshot.emailWarning, false);
      else                       setFeedback("", false);
    } catch (err) {
      setFeedback(err.message, true);
      banner.setError(err.message, err.retryable !== false ? function () { updateDeliveryStatus(orderId, deliveryStatus); } : null);
    }
  }

  async function exportOrders() {
    if (!els.exportButton) return;
    els.exportButton.disabled = true;
    setFeedback("Exportando pedidos...", false);
    try {
      var fromInput = document.getElementById("mgmtExportFrom");
      var toInput   = document.getElementById("mgmtExportTo");
      var fromDate  = fromInput && fromInput.value ? fromInput.value : "";
      var toDate    = toInput   && toInput.value   ? toInput.value   : "";

      if (fromDate && toDate && fromDate > toDate) {
        setFeedback("La fecha 'Desde' no puede ser posterior a 'Hasta'.", true);
        els.exportButton.disabled = false;
        return;
      }

      var now       = new Date();
      var todayKey  = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
      var rangeTag  = fromDate || toDate
        ? "-" + (fromDate || "inicio") + "_a_" + (toDate || todayKey)
        : "-todos-" + todayKey;
      var filename  = "orders" + rangeTag + ".csv";

      await api.downloadFile(
        "/orders",
        { action: "export", fromDate: fromDate, toDate: toDate },
        filename
      );
      setFeedback("Archivo exportado correctamente.", false);
    } catch (err) {
      setFeedback(err.message, true);
    } finally {
      els.exportButton.disabled = false;
    }
  }

  // ── Manual sale modal ─────────────────────────────────────────────

  function openManualSaleDialog() {
    if (!els.manualSaleDialog) return;
    // Reset state
    if (els.manualSaleName)     els.manualSaleName.value   = "";
    if (els.manualSaleMethod)   els.manualSaleMethod.value = "EFECTIVO";
    if (els.manualSaleFeedback) els.manualSaleFeedback.textContent = "";
    if (els.manualSaleSubmit)   els.manualSaleSubmit.disabled = false;
    // Restore default selection on payment options
    els.manualSaleDialog.querySelectorAll(".manual-sale-payment-option").forEach(function (btn) {
      btn.classList.toggle("is-selected", btn.dataset.method === "EFECTIVO");
    });
    els.manualSaleDialog.showModal();
    if (els.manualSaleName) els.manualSaleName.focus();
  }

  async function submitManualOrder() {
    if (isSaving) return;

    var name   = (els.manualSaleName  ? els.manualSaleName.value  : "").trim() || "Cliente";
    var method = (els.manualSaleMethod ? els.manualSaleMethod.value : "EFECTIVO");
    var target = todayKeyFromBrowser();

    isSaving = true;
    if (els.manualSaleSubmit)   els.manualSaleSubmit.disabled = true;
    if (els.manualSaleFeedback) {
      els.manualSaleFeedback.textContent = "Registrando venta...";
      els.manualSaleFeedback.style.color = "var(--muted)";
    }

    try {
      var result = await api.fetchJson("/orders", {
        method: "POST",
        body: {
          order: {
            buyerName:     name,
            paymentMethod: method,
            targetDate:    target
          }
        }
      });

      if (!result.ok) throw new Error(result.message || "No se pudo registrar la venta.");

      els.manualSaleDialog.close();
      setFeedback("Venta manual registrada: " + escHtml(name), false);
      await loadAll();
    } catch (err) {
      if (els.manualSaleFeedback) {
        els.manualSaleFeedback.textContent = err.message || "Error al registrar la venta.";
        els.manualSaleFeedback.style.color = "var(--primary-dark)";
      }
    } finally {
      isSaving = false;
      if (els.manualSaleSubmit) els.manualSaleSubmit.disabled = false;
    }
  }

  function initManualSaleModal() {
    if (!els.manualSaleButton || !els.manualSaleDialog) return;

    els.manualSaleButton.addEventListener("click", openManualSaleDialog);

    if (els.manualSaleCancel) {
      els.manualSaleCancel.addEventListener("click", function () {
        if (!isSaving) els.manualSaleDialog.close();
      });
    }

    // Close on backdrop click
    els.manualSaleDialog.addEventListener("click", function (e) {
      if (e.target === els.manualSaleDialog && !isSaving) els.manualSaleDialog.close();
    });

    // Payment method toggle
    els.manualSaleDialog.querySelectorAll(".manual-sale-payment-option").forEach(function (btn) {
      btn.addEventListener("click", function () {
        els.manualSaleDialog.querySelectorAll(".manual-sale-payment-option").forEach(function (b) {
          b.classList.remove("is-selected");
        });
        btn.classList.add("is-selected");
        if (els.manualSaleMethod) els.manualSaleMethod.value = btn.dataset.method;
      });
    });

    if (els.manualSaleSubmit) {
      els.manualSaleSubmit.addEventListener("click", submitManualOrder);
    }
  }

  // ── Supabase Realtime subscription ───────────────────────────────

  function subscribeRealtime(cid) {
    var cfg = window.APP_CONFIG || {};
    if (!cfg.supabaseUrl || cfg.supabaseUrl.includes("REPLACE_WITH") ||
        !cfg.supabaseAnonKey || cfg.supabaseAnonKey.includes("REPLACE_WITH")) {
      return;
    }
    if (realtimeChannel) window.supabaseClient.removeChannel(realtimeChannel);

    realtimeChannel = window.supabaseClient
      .channel("management-" + cid)
      .on("postgres_changes", {
        event:  "*",
        schema: "public",
        table:  "orders",
        filter: "cafeteria_id=eq." + cid
      }, function () { loadAll(); })
      .subscribe();
  }

  // ── Staff (Equipo) management ─────────────────────────────────────

  var ROLE_LABELS = { ADMIN: "Administrador", HELPER: "Asistente", ORDERS: "Entregas" };

  function renderStaffList(staff) {
    if (!els.staffList) return;
    if (!staff || !staff.length) {
      els.staffList.innerHTML = '<p class="insights-empty">No hay miembros aún.</p>';
      return;
    }
    var rows = staff.map(function (s) {
      var lastSeen = s.lastSignInAt
        ? new Date(s.lastSignInAt).toLocaleDateString("es-CR")
        : (s.invitedAt ? "Pendiente de aceptar" : "—");
      var roleLabel = ROLE_LABELS[s.role] || s.role;
      return '' +
        '<div class="admin-orders-table__row" style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:0.6rem;align-items:center;padding:0.6rem 0;border-bottom:1px solid #eee;">' +
          '<div><strong>' + escHtml(s.email) + '</strong></div>' +
          '<div>' +
            '<select class="staff-role-select" data-user-id="' + escHtml(s.userId) + '" data-current="' + escHtml(s.role) + '">' +
              '<option value="ADMIN"' + (s.role === "ADMIN" ? " selected" : "") + '>ADMIN</option>' +
              '<option value="HELPER"' + (s.role === "HELPER" ? " selected" : "") + '>HELPER</option>' +
              '<option value="ORDERS"' + (s.role === "ORDERS" ? " selected" : "") + '>ORDERS</option>' +
            '</select>' +
          '</div>' +
          '<div class="muted" title="Último acceso">' + escHtml(lastSeen) + '</div>' +
          '<div>' +
            '<button type="button" class="button button--ghost staff-remove-btn" data-user-id="' + escHtml(s.userId) + '" data-email="' + escHtml(s.email) + '">Eliminar</button>' +
          '</div>' +
        '</div>';
    }).join("");
    els.staffList.innerHTML = rows;

    els.staffList.querySelectorAll(".staff-remove-btn").forEach(function (btn) {
      btn.addEventListener("click", onRemoveStaff);
    });
    els.staffList.querySelectorAll(".staff-role-select").forEach(function (sel) {
      sel.addEventListener("change", onChangeStaffRole);
    });
  }

  async function refreshStaff() {
    if (!els.staffList) return;
    els.staffList.innerHTML = '<p class="insights-empty">Cargando equipo...</p>';
    try {
      var data = await api.fetchJson("/auth-role?staff=1");
      renderStaffList(data.staff || []);
    } catch (err) {
      els.staffList.innerHTML = '<p class="insights-empty">Error: ' + escHtml(err.message) + '</p>';
    }
  }

  async function submitInviteStaff(event) {
    event.preventDefault();
    if (!els.staffInviteEmail || !els.staffInviteRole) return;
    var email = String(els.staffInviteEmail.value || "").trim();
    var role  = String(els.staffInviteRole.value  || "").trim();
    if (!email) {
      els.staffInviteFeedback.textContent = "Ingrese un correo.";
      return;
    }
    els.staffInviteSubmit.disabled = true;
    els.staffInviteFeedback.textContent = "Enviando invitación...";
    try {
      var result = await api.fetchJson("/auth-role", {
        method: "POST",
        body:   { action: "staff_invite", email: email, role: role }
      });
      els.staffInviteFeedback.textContent = result.message || "Invitación enviada.";
      els.staffInviteEmail.value = "";
      await refreshStaff();
    } catch (err) {
      els.staffInviteFeedback.textContent = "Error: " + err.message;
    } finally {
      els.staffInviteSubmit.disabled = false;
    }
  }

  async function onRemoveStaff(event) {
    var btn = event.currentTarget;
    var userId = btn.dataset.userId;
    var email  = btn.dataset.email;
    if (!userId) return;
    if (!window.confirm("¿Eliminar a " + email + " de esta cafetería?")) return;
    btn.disabled = true;
    try {
      await api.fetchJson("/auth-role", {
        method: "POST",
        body:   { action: "staff_remove", userId: userId }
      });
      await refreshStaff();
    } catch (err) {
      window.alert("Error: " + err.message);
      btn.disabled = false;
    }
  }

  async function onChangeStaffRole(event) {
    var sel = event.currentTarget;
    var userId  = sel.dataset.userId;
    var current = sel.dataset.current;
    var next    = sel.value;
    if (next === current) return;
    sel.disabled = true;
    try {
      await api.fetchJson("/auth-role", {
        method: "POST",
        body:   { action: "staff_update_role", userId: userId, role: next }
      });
      sel.dataset.current = next;
    } catch (err) {
      window.alert("Error: " + err.message);
      sel.value = current;
    } finally {
      sel.disabled = false;
    }
  }

  // ── Diagnostics ────────────────────────────────────────────────────

  function renderDiagnostics(payload) {
    if (!els.diagnosticsContent) return;
    var checks = payload.checks || {};
    var orphaned = payload.orphanedAuthUsers || [];
    var noAdmin  = payload.cafeteriasWithoutAdmin || [];

    var html = '';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.8rem;margin-bottom:1rem;">';
    Object.keys(checks).forEach(function (k) {
      var c = checks[k];
      var color = c.ok ? "#2c6e49" : "#842f3d";
      html += '<div class="card" style="padding:0.8rem;"><strong>' + escHtml(k) + '</strong><br><span style="color:' + color + '">' +
        (c.ok ? "OK" : "FALLA") + '</span>' +
        (c.detail ? '<p class="muted">' + escHtml(c.detail) + '</p>' : '') +
        '</div>';
    });
    html += '</div>';

    html += '<h3>Usuarios huérfanos (' + orphaned.length + ')</h3>';
    html += '<p class="muted">Cuentas auth sin membresía en ninguna cafetería.</p>';
    if (!orphaned.length) {
      html += '<p class="insights-empty">Ninguno.</p>';
    } else {
      html += '<ul>' + orphaned.map(function (u) {
        return '<li>' + escHtml(u.email) + ' — creado ' + escHtml(new Date(u.createdAt).toLocaleString("es-CR")) + '</li>';
      }).join("") + '</ul>';
    }

    html += '<h3>Cafeterías sin administrador (' + noAdmin.length + ')</h3>';
    if (!noAdmin.length) {
      html += '<p class="insights-empty">Ninguna.</p>';
    } else {
      html += '<ul>' + noAdmin.map(function (c) {
        return '<li><strong>' + escHtml(c.name) + '</strong> (' + escHtml(c.slug) + ')</li>';
      }).join("") + '</ul>';
    }

    els.diagnosticsContent.innerHTML = html;
  }

  async function refreshDiagnostics() {
    if (!els.diagnosticsContent) return;
    els.diagnosticsContent.innerHTML = '<p class="insights-empty">Ejecutando diagnóstico...</p>';
    try {
      var payload = await api.fetchJson("/auth-role?diagnostics=1");
      renderDiagnostics(payload);
    } catch (err) {
      els.diagnosticsContent.innerHTML = '<p class="insights-empty">Error: ' + escHtml(err.message) + '</p>';
    }
  }

  function setBannerSynced() { banner.setSynced(); }
  function setBannerError(msg, fn) { banner.setError(msg, fn); }

  // ── Init ──────────────────────────────────────────────────────────

  async function start() {
    banner.init();

    var sessionResult = await window.supabaseClient.auth.getSession();
    var session       = sessionResult.data && sessionResult.data.session;
    if (!session) { window.location.replace("./index.html"); return; }
    accessToken = session.access_token;

    window.supabaseClient.auth.onAuthStateChange(function (event, newSession) {
      if (!newSession) { window.location.replace("./index.html"); return; }
      accessToken = newSession.access_token;
    });

    api = window.SE.api.make(function () { return accessToken; });

    var roleData;
    try {
      roleData = await api.fetchJson("/auth-role");
    } catch (_) {
      window.location.replace("./index.html");
      return;
    }
    userRole    = roleData.role;
    cafeteriaId = roleData.cafeteriaId;

    adaptToRole(userRole);
    if (userRole === "ADMIN") initTabs();

    if (els.menuForm)     els.menuForm.addEventListener("submit", submitMenu);
    if (els.exportButton) els.exportButton.addEventListener("click", exportOrders);

    // Accounting module
    if (els.accountingMonth) {
      // Default to the current Costa Rica month
      var crNow = new Date(Date.now() - 6 * 60 * 60 * 1000);
      els.accountingMonth.value =
        crNow.getUTCFullYear() + "-" + String(crNow.getUTCMonth() + 1).padStart(2, "0");
      els.accountingMonth.addEventListener("change", refreshAccounting);
    }
    if (els.accountingExportBtn) els.accountingExportBtn.addEventListener("click", exportAccounting);

    if (userRole === "ADMIN" && els.settingsForm) {
      els.settingsForm.addEventListener("submit", submitSettings);
      loadSettings();
    }

    if (els.staffInviteForm)      els.staffInviteForm.addEventListener("submit", submitInviteStaff);
    if (els.diagnosticsRefreshBtn) els.diagnosticsRefreshBtn.addEventListener("click", refreshDiagnostics);

    initManualSaleModal();
    if (els.logoutButton) els.logoutButton.addEventListener("click", function () {
      window.supabaseClient.auth.signOut();
      window.location.replace("./index.html");
    });

    await loadAll();
    subscribeRealtime(cafeteriaId);
    window.setInterval(loadAll, 60000);

    if (userRole === "ADMIN") {
      window.setInterval(function () {
        var insightsTab = document.getElementById("mgmtInsightsTab");
        if (insightsTab && !insightsTab.hidden) refreshAnalytics();
      }, 5 * 60 * 1000);
    } else {
      // Helper has no tabs — make sure the operations panel is the only one visible.
      ["mgmtInsightsTab", "mgmtAccountingTab", "mgmtStaffTab", "mgmtDiagnosticsTab"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.hidden = true;
      });
    }
  }

  start();
})();
