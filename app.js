(function () {
  "use strict";

  var config  = window.APP_CONFIG || {};
  var banner  = window.SE.banner;
  var fmt     = window.SE.fmt;
  var api     = window.SE.api.make(null);

  var slug = String(config.cafeteriaSlug || "ceep");

  // State
  var state = {
    snapshot:        null,
    weekMenus:       [],
    selectedDate:    "",   // YYYY-MM-DD the buyer has selected
    isSubmitting:    false,
    creditBalance:   0,
    selectedPkg:     null, // { id, title, mealCount, price }
    isPkgSubmitting: false
  };

  var els = {
    weekDayTabs:          document.getElementById("weekDayTabs"),
    menuDayEyebrow:       document.getElementById("menuDayEyebrow"),
    menuTitle:            document.getElementById("menuTitle"),
    menuDescription:      document.getElementById("menuDescription"),
    menuPrice:            document.getElementById("menuPrice"),
    dailyMessage:         document.getElementById("dailyMessage"),
    availableCount:       document.getElementById("availableCount"),
    buyersList:           document.getElementById("buyersList"),
    orderForm:            document.getElementById("orderForm"),
    submitButton:         document.getElementById("submitButton"),
    formFeedback:         document.getElementById("formFeedback"),
    paymentMethodInput:   document.getElementById("paymentMethod"),
    paymentOptions:       Array.from(document.querySelectorAll(".payment-option:not(.pkg-payment-option)")),
    buyerRowTemplate:     document.getElementById("buyerRowTemplate"),
    logoutButton:         document.getElementById("logoutButton"),
    trackingLinkSection:  document.getElementById("trackingLinkSection"),
    trackingLink:         document.getElementById("trackingLink"),
    creditBalanceBadge:   document.getElementById("creditBalanceBadge"),
    creditPaymentOption:  document.getElementById("creditPaymentOption"),
    // Packages section
    packagesList:         document.getElementById("packagesList"),
    packageForm:          document.getElementById("packageForm"),
    pkgSubmitButton:      document.getElementById("pkgSubmitButton"),
    pkgFormFeedback:      document.getElementById("pkgFormFeedback"),
    pkgPaymentMethodInput:document.getElementById("pkgPaymentMethod"),
    pkgPaymentOptions:    Array.from(document.querySelectorAll(".pkg-payment-option")),
    selectedPackageLabel: document.getElementById("selectedPackageLabel"),
    pkgTrackingSection:   document.getElementById("pkgTrackingSection"),
    pkgTrackingLink:      document.getElementById("pkgTrackingLink"),
    pkgTrackingMessage:   document.getElementById("pkgTrackingMessage")
  };

  // ── Day key utilities (mirrors lib/dashboard.js) ──────────────────

  function todayKey() {
    return new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  // ── Cache helpers ─────────────────────────────────────────────────

  function loadCached() {
    try { return JSON.parse(localStorage.getItem(config.cacheKey)); }
    catch (_) { return null; }
  }

  function saveCache(snapshot) {
    try { localStorage.setItem(config.cacheKey, JSON.stringify(snapshot)); }
    catch (_) {}
  }

  // ── Feedback ──────────────────────────────────────────────────────

  function setFeedback(message, isError) {
    els.formFeedback.textContent = message || "";
    els.formFeedback.style.color = isError ? "#842f3d" : "#705d52";
  }

  // ── Week day tabs ─────────────────────────────────────────────────

  function renderWeekTabs(weekMenus) {
    state.weekMenus = weekMenus || [];
    if (!els.weekDayTabs) return;
    if (!state.weekMenus.length) {
      els.weekDayTabs.innerHTML = '<span class="week-tab week-tab--loading">Sin datos</span>';
      return;
    }

    var html = "";
    state.weekMenus.forEach(function (day) {
      var isSelected   = day.date === state.selectedDate;
      var hasMenu      = Boolean(day.menu);
      var isOpen       = day.isOrderingOpen;
      var tabClass     = "week-tab" +
        (isSelected ? " is-active"  : "") +
        (!hasMenu   ? " is-no-menu" : "") +
        (!isOpen && hasMenu ? " is-closed" : "");

      html +=
        '<button type="button" class="' + tabClass + '" ' +
          'data-date="' + day.date + '" ' +
          'aria-selected="' + (isSelected ? "true" : "false") + '" ' +
          'role="tab" ' +
          (!hasMenu ? 'aria-disabled="true" ' : '') + '>' +
          '<span class="week-tab__day">' + day.dayLabel + (day.isToday ? ' <em>(hoy)</em>' : '') + '</span>' +
          '<span class="week-tab__status">' + (hasMenu ? (isOpen ? String(day.availableMeals) + ' disp.' : 'Cerrado') : 'No disponible') + '</span>' +
        '</button>';
    });
    els.weekDayTabs.innerHTML = html;

    els.weekDayTabs.querySelectorAll(".week-tab").forEach(function (btn) {
      if (btn.getAttribute("aria-disabled") === "true") return;
      btn.addEventListener("click", function () {
        selectDate(btn.dataset.date);
      });
    });
  }

  function selectDate(date) {
    state.selectedDate = date;

    // Refresh active state in the tab bar
    if (els.weekDayTabs) {
      els.weekDayTabs.querySelectorAll(".week-tab").forEach(function (btn) {
        var isActive = btn.dataset.date === date;
        btn.classList.toggle("is-active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
      });
    }

    // Find the day's data and render the menu card
    var day = state.weekMenus.find(function (d) { return d.date === date; });
    renderDayMenu(day);
  }

  function renderDayMenu(day) {
    if (!day) return;

    var menu = day.menu || null;

    // Eyebrow label: "Menú de hoy" vs "Menú del Mar 28 abr"
    if (els.menuDayEyebrow) {
      els.menuDayEyebrow.textContent = day.isToday
        ? "Menú de hoy"
        : "Menú del " + day.dayLabel;
    }

    if (menu) {
      els.menuTitle.textContent       = menu.title;
      els.menuDescription.textContent = menu.description || "No hay descripción disponible.";
      els.menuPrice.textContent       = fmt.currency(menu.price);
    } else {
      els.menuTitle.textContent       = "No disponible";
      els.menuDescription.textContent = "No hay menú programado para este día.";
      els.menuPrice.textContent       = "-";
    }

    els.availableCount.textContent = String(day.availableMeals || 0);

    var canBuy = day.isOrderingOpen && !state.isSubmitting;
    els.submitButton.disabled = !canBuy;

    if (!canBuy) {
      if (!menu) {
        setFeedback("No hay menú disponible para este día.", false);
      } else if (!day.isOrderingOpen) {
        setFeedback("La venta está cerrada o ya se alcanzó el máximo para este día.", false);
      }
    } else if (!state.isSubmitting) {
      setFeedback("", false);
    }

    // Show orders list for the selected date from the current snapshot
    if (state.snapshot) {
      renderBuyers(state.snapshot.orders || []);
    }
  }

  // ── Render buyers list ────────────────────────────────────────────

  function renderBuyers(orders) {
    els.buyersList.innerHTML = "";
    if (!orders || !orders.length) {
      els.buyersList.innerHTML = '<div class="delivery-table__empty">No hay compras registradas todavía.</div>';
      return;
    }

    var fragment = document.createDocumentFragment();
    orders.forEach(function (order) {
      var node     = els.buyerRowTemplate.content.cloneNode(true);
      var payLabel = fmt.paymentLabel(order.paymentStatus);

      node.querySelector(".buyer-name").textContent            = order.buyerName;
      node.querySelector(".buyer-meta").textContent            = [order.paymentMethod, payLabel, order.timestampLabel].filter(Boolean).join(" | ");
      node.querySelector(".customer-order-status").textContent = order.orderStatus || "SOLICITADO";
      node.querySelector(".customer-created-at").textContent   = order.createdAtLabel || order.timestampLabel || "";

      var payNode = node.querySelector(".customer-payment-status");
      payNode.textContent = payLabel;
      payNode.className   = fmt.paymentClass(order.paymentStatus) + " customer-payment-status";

      node.querySelector(".customer-payment-confirmed-at").textContent = order.paymentConfirmedAtLabel || "";

      var delivery  = order.deliveryStatus || "PENDIENTE_ENTREGA";
      var isDone    = delivery === "ENTREGADO" || delivery === "LISTO_PARA_ENTREGA";
      var badgeNode = node.querySelector(".customer-delivery-badge");
      var LABELS    = {
        ENTREGADO:          "Entregado",
        LISTO_PARA_ENTREGA: "Listo para Entrega",
        EN_PREPARACION:     "En Preparación",
        PENDIENTE_ENTREGA:  "Solicitado"
      };
      badgeNode.textContent = LABELS[delivery] || "Solicitado";
      badgeNode.className   = (isDone ? "delivery-action is-selected" : "delivery-action") + " customer-delivery-badge";

      node.querySelector(".customer-delivered-at").textContent = order.deliveredAtLabel || "";
      fragment.appendChild(node);
    });
    els.buyersList.appendChild(fragment);
  }

  function renderSnapshot(snapshot) {
    state.snapshot = snapshot;
    if (els.dailyMessage) els.dailyMessage.textContent = snapshot.message || "";

    // Rebuild week tabs if weekly data is present
    if (snapshot.weekMenus && snapshot.weekMenus.length) {
      renderWeekTabs(snapshot.weekMenus);

      // On first load auto-select today (or first available day)
      if (!state.selectedDate) {
        var today = todayKey();
        var firstOpen = snapshot.weekMenus.find(function (d) { return d.isOrderingOpen; });
        var todayEntry = snapshot.weekMenus.find(function (d) { return d.date === today; });
        selectDate((todayEntry || firstOpen || snapshot.weekMenus[0]).date);
      } else {
        // Re-render the current day's card in case availability changed
        var current = snapshot.weekMenus.find(function (d) { return d.date === state.selectedDate; });
        if (current) renderDayMenu(current);
      }
    } else {
      // Fallback: single-day mode (no weekMenus in response)
      var menu = snapshot.menu || {};
      els.menuTitle.textContent       = menu.title       || "Menú no configurado";
      els.menuDescription.textContent = menu.description || "No hay descripción disponible.";
      els.menuPrice.textContent       = fmt.currency(menu.price);
      els.availableCount.textContent  = String(snapshot.availableMeals || 0);
      renderBuyers(snapshot.orders || []);

      var canBuy = Boolean(snapshot.isSalesOpen) && Number(snapshot.availableMeals || 0) > 0;
      els.submitButton.disabled = !canBuy || state.isSubmitting;
      if (!canBuy) setFeedback("La venta está cerrada o ya se alcanzó el máximo diario.", false);
      else if (!state.isSubmitting) setFeedback("", false);
    }
  }

  function showTrackingLink(trackingUrl) {
    if (!els.trackingLinkSection || !els.trackingLink) return;
    els.trackingLink.href        = trackingUrl;
    els.trackingLink.textContent = trackingUrl;
    els.trackingLinkSection.hidden = false;
  }

  // ── Optimistic UI ─────────────────────────────────────────────────

  function addOptimisticOrder(buyerName, paymentMethod) {
    var empty = els.buyersList.querySelector(".delivery-table__empty");
    if (empty) empty.remove();

    var fragment = els.buyerRowTemplate.content.cloneNode(true);
    var row = fragment.firstElementChild;
    if (row) row.dataset.optimistic = "true";

    fragment.querySelector(".buyer-name").textContent = buyerName;
    fragment.querySelector(".buyer-meta").textContent = [paymentMethod, "PENDIENTE DE PAGO", "Ahora"].join(" | ");
    fragment.querySelector(".customer-order-status").textContent = "SOLICITADO";
    fragment.querySelector(".customer-created-at").textContent = "Ahora";

    var payNode = fragment.querySelector(".customer-payment-status");
    payNode.textContent = "PENDIENTE DE PAGO";
    payNode.className = "delivery-payment-status customer-payment-status";

    fragment.querySelector(".customer-payment-confirmed-at").textContent = "";
    fragment.querySelector(".customer-delivery-badge").textContent = "Solicitado";
    fragment.querySelector(".customer-delivered-at").textContent = "";

    els.buyersList.insertBefore(fragment, els.buyersList.firstChild);
  }

  function removeOptimisticOrders() {
    els.buyersList.querySelectorAll("[data-optimistic]").forEach(function (el) { el.remove(); });
  }

  // ── Network ───────────────────────────────────────────────────────

  async function refreshSnapshot(showErrors) {
    try {
      var snapshot = await api.fetchJson("/dashboard?slug=" + encodeURIComponent(slug) + "&week=true");
      saveCache(snapshot);
      renderSnapshot(snapshot);
      banner.setSynced();
    } catch (err) {
      var cached = loadCached();
      if (cached) renderSnapshot(cached);
      if (!navigator.onLine) return;
      if (showErrors) {
        setFeedback(err.message, true);
        banner.setError(function () { refreshSnapshot(true); });
      }
    }
  }

  async function submitOrder(event) {
    event.preventDefault();
    if (state.isSubmitting) return;

    var fd      = new FormData(els.orderForm);
    var payload = {
      buyerName:     String(fd.get("buyerName")    || "").trim(),
      buyerEmail:    String(fd.get("buyerEmail")   || "").trim().toLowerCase(),
      paymentMethod: String(fd.get("paymentMethod") || "").trim(),
      targetDate:    state.selectedDate || todayKey()
    };

    if (!payload.buyerName || !payload.paymentMethod) {
      setFeedback("Complete todos los campos obligatorios.", true);
      return;
    }
    if (payload.paymentMethod === "CREDITO" && !payload.buyerEmail) {
      setFeedback("Ingrese su correo electrónico para canjear un crédito.", true);
      return;
    }

    state.isSubmitting        = true;
    els.submitButton.disabled = true;
    banner.setSyncing();

    var prevAvailable = Number(els.availableCount.textContent) || 0;
    els.orderForm.reset();
    selectPaymentMethod("");
    setFeedback("Compra registrada correctamente.", false);
    addOptimisticOrder(payload.buyerName, payload.paymentMethod);
    if (prevAvailable > 0) els.availableCount.textContent = String(prevAvailable - 1);

    try {
      var result = await api.fetchJson("/orders?slug=" + encodeURIComponent(slug), {
        method: "POST",
        body:   { order: payload }
      });

      if (!result.ok) throw new Error(result.message || "No se pudo registrar la compra.");

      if (result.trackingToken) {
        var trackingUrl = window.location.origin +
          window.location.pathname.replace(/[^/]*$/, "") +
          "track.html?token=" + encodeURIComponent(result.trackingToken);
        showTrackingLink(trackingUrl);
      }

      // Refresh to get the updated week view including the new order
      await refreshSnapshot(false);
      setFeedback(result.message || "Compra registrada correctamente.", false);
      banner.setSynced();
    } catch (err) {
      removeOptimisticOrders();
      els.availableCount.textContent = String(prevAvailable);
      setFeedback(err.message, true);
      banner.setError(null);
    } finally {
      state.isSubmitting = false;
      // Re-evaluate button state from the current selected day
      var day = state.weekMenus.find(function (d) { return d.date === state.selectedDate; });
      els.submitButton.disabled = !(day && day.isOrderingOpen);
    }
  }

  function selectPaymentMethod(method) {
    els.paymentMethodInput.value = method || "";
    els.paymentOptions.forEach(function (btn) {
      var sel = btn.dataset.paymentMethod === method;
      btn.classList.toggle("is-selected", sel);
      btn.setAttribute("aria-pressed", sel ? "true" : "false");
    });
  }

  // ── Credit balance ────────────────────────────────────────────────

  var creditCheckTimer = null;

  function updateCreditUI(balance) {
    state.creditBalance = Number(balance || 0);
    var badge  = els.creditBalanceBadge;
    var option = els.creditPaymentOption;
    if (!badge || !option) return;

    if (state.creditBalance > 0) {
      var count = state.creditBalance;
      badge.textContent = count + " crédito" + (count !== 1 ? "s" : "") + " disponible" + (count !== 1 ? "s" : "");
      badge.hidden = false;
      option.hidden = false;
      option.textContent = "Usar Crédito (" + count + ")";
    } else {
      badge.hidden = true;
      option.hidden = true;
      if (els.paymentMethodInput.value === "CREDITO") selectPaymentMethod("");
    }
  }

  function scheduleCreditCheck(email) {
    clearTimeout(creditCheckTimer);
    if (!email || !email.includes("@")) { updateCreditUI(0); return; }
    creditCheckTimer = setTimeout(function () {
      api.fetchJson("/credits?slug=" + encodeURIComponent(slug) + "&email=" + encodeURIComponent(email))
        .then(function (d) { updateCreditUI(d.remainingMeals || 0); })
        .catch(function ()  { updateCreditUI(0); });
    }, 600);
  }

  // ── Packages ──────────────────────────────────────────────────────

  async function fetchAndRenderPackages() {
    if (!els.packagesList) return;
    try {
      var data = await api.fetchJson("/packages?slug=" + encodeURIComponent(slug));
      renderPackages(data.packages || []);
    } catch (_) {
      if (els.packagesList) els.packagesList.innerHTML = '<span class="muted">No hay paquetes disponibles por el momento.</span>';
    }
  }

  function renderPackages(packages) {
    if (!els.packagesList) return;
    if (!packages.length) {
      els.packagesList.innerHTML = '<span class="muted">No hay paquetes disponibles por el momento.</span>';
      return;
    }
    var html = "";
    packages.forEach(function (pkg) {
      html +=
        '<button type="button" class="package-card" data-pkg-id="' + encodeAttr(pkg.id) + '" ' +
          'data-pkg-title="' + encodeAttr(pkg.title) + '" ' +
          'data-pkg-count="' + pkg.meal_count + '" ' +
          'data-pkg-price="' + pkg.price + '">' +
          '<span class="package-card__title">' + escapeHtml(pkg.title) + '</span>' +
          '<span class="package-card__count">' + pkg.meal_count + ' almuerzos</span>' +
          '<span class="package-card__price">' + fmt.currency(pkg.price) + '</span>' +
        '</button>';
    });
    els.packagesList.innerHTML = html;
    els.packagesList.querySelectorAll(".package-card").forEach(function (btn) {
      btn.addEventListener("click", function () { selectPackage(btn); });
    });
  }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function encodeAttr(s) {
    return String(s || "").replace(/"/g, "&quot;");
  }

  function selectPackage(btn) {
    var already = btn.classList.contains("is-selected");
    els.packagesList.querySelectorAll(".package-card").forEach(function (b) { b.classList.remove("is-selected"); });
    if (already) {
      state.selectedPkg = null;
      if (els.packageForm) els.packageForm.hidden = true;
      return;
    }
    btn.classList.add("is-selected");
    state.selectedPkg = {
      id:        btn.dataset.pkgId,
      title:     btn.dataset.pkgTitle,
      mealCount: Number(btn.dataset.pkgCount),
      price:     Number(btn.dataset.pkgPrice)
    };
    if (els.selectedPackageLabel) {
      els.selectedPackageLabel.textContent =
        "Paquete seleccionado: " + state.selectedPkg.title +
        " — " + state.selectedPkg.mealCount + " almuerzos — " +
        fmt.currency(state.selectedPkg.price);
    }
    if (els.packageForm) {
      els.packageForm.hidden = false;
      els.packageForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    setPkgFeedback("", false);
  }

  function selectPkgPaymentMethod(method) {
    if (!els.pkgPaymentMethodInput) return;
    els.pkgPaymentMethodInput.value = method || "";
    els.pkgPaymentOptions.forEach(function (btn) {
      var sel = btn.dataset.paymentMethod === method;
      btn.classList.toggle("is-selected", sel);
      btn.setAttribute("aria-pressed", sel ? "true" : "false");
    });
  }

  function setPkgFeedback(msg, isError) {
    if (!els.pkgFormFeedback) return;
    els.pkgFormFeedback.textContent = msg || "";
    els.pkgFormFeedback.style.color = isError ? "#842f3d" : "#705d52";
  }

  async function submitPackage(event) {
    event.preventDefault();
    if (state.isPkgSubmitting || !state.selectedPkg) return;

    var fd            = new FormData(els.packageForm);
    var buyerName     = String(fd.get("pkgBuyerName")      || "").trim();
    var buyerEmail    = String(fd.get("pkgBuyerEmail")     || "").trim().toLowerCase();
    var paymentMethod = String(fd.get("pkgPaymentMethod")  || "").trim();

    if (!buyerName)     { setPkgFeedback("Ingrese su nombre completo.", true);       return; }
    if (!buyerEmail)    { setPkgFeedback("Ingrese su correo electrónico.", true);    return; }
    if (!paymentMethod) { setPkgFeedback("Seleccione un método de pago.", true);     return; }

    state.isPkgSubmitting        = true;
    els.pkgSubmitButton.disabled = true;
    setPkgFeedback("Registrando solicitud...", false);

    try {
      var result = await api.fetchJson("/packages?slug=" + encodeURIComponent(slug), {
        method: "POST",
        body: {
          action: "buy",
          buyerName,
          buyerEmail,
          packageId:    state.selectedPkg.id,
          paymentMethod
        }
      });
      if (!result.ok) throw new Error(result.message || "No se pudo registrar el paquete.");

      if (els.pkgTrackingSection && els.pkgTrackingLink) {
        var trackingUrl = window.location.origin +
          window.location.pathname.replace(/[^/]*$/, "") +
          "track.html?token=" + encodeURIComponent(result.trackingToken);
        els.pkgTrackingLink.href        = trackingUrl;
        els.pkgTrackingLink.textContent = trackingUrl;
        if (els.pkgTrackingMessage) els.pkgTrackingMessage.textContent = result.message || "";
        els.pkgTrackingSection.hidden = false;
      }

      // Reset package form
      els.packageForm.reset();
      selectPkgPaymentMethod("");
      state.selectedPkg = null;
      els.packageForm.hidden = true;
      els.packagesList.querySelectorAll(".package-card").forEach(function (b) { b.classList.remove("is-selected"); });
    } catch (err) {
      setPkgFeedback(err.message, true);
    } finally {
      state.isPkgSubmitting        = false;
      els.pkgSubmitButton.disabled = false;
    }
  }

  // ── Init ──────────────────────────────────────────────────────────

  function start() {
    var cached = loadCached();
    if (cached) renderSnapshot(cached);

    els.orderForm.addEventListener("submit", submitOrder);
    els.paymentOptions.forEach(function (btn) {
      btn.addEventListener("click", function () { selectPaymentMethod(btn.dataset.paymentMethod); });
    });

    // Credit balance: check whenever the email field changes.
    var buyerEmailInput = document.getElementById("buyerEmail");
    if (buyerEmailInput) {
      buyerEmailInput.addEventListener("input", function () {
        scheduleCreditCheck(buyerEmailInput.value.trim().toLowerCase());
      });
      buyerEmailInput.addEventListener("change", function () {
        scheduleCreditCheck(buyerEmailInput.value.trim().toLowerCase());
      });
    }

    if (els.logoutButton) {
      els.logoutButton.addEventListener("click", function () {
        sessionStorage.removeItem("ceep-role-session");
        window.location.replace("./index.html");
      });
    }

    // Package form
    if (els.packageForm) {
      els.packageForm.addEventListener("submit", submitPackage);
    }
    els.pkgPaymentOptions.forEach(function (btn) {
      btn.addEventListener("click", function () { selectPkgPaymentMethod(btn.dataset.paymentMethod); });
    });

    banner.init();
    refreshSnapshot(false);
    fetchAndRenderPackages();

    window.setInterval(function () { refreshSnapshot(false); }, Number(config.refreshIntervalMs || 30000));

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(function () {});
    }
  }

  start();
})();
