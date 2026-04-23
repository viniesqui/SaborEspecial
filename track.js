(function () {
  "use strict";

  const config = window.APP_CONFIG || {};

  // -------------------------------------------------------------------------
  // Element refs
  // -------------------------------------------------------------------------
  const els = {
    loading:         document.getElementById("trackLoading"),
    error:           document.getElementById("trackError"),
    errorMessage:    document.getElementById("trackErrorMessage"),
    content:         document.getElementById("trackContent"),
    buyerName:       document.getElementById("trackBuyerName"),
    menuTitle:       document.getElementById("trackMenuTitle"),
    menuPrice:       document.getElementById("trackMenuPrice"),
    paymentMethod:   document.getElementById("trackPaymentMethod"),
    liveDot:         document.getElementById("trackLiveDot"),
    liveLabel:       document.getElementById("trackLiveLabel"),
    timeSolicitado:  document.getElementById("trackTimeSolicitado"),
    timePago:        document.getElementById("trackTimePago"),
    timePrep:        document.getElementById("trackTimePrep"),
    timeListo:       document.getElementById("trackTimeListo"),
    timeEntregado:   document.getElementById("trackTimeEntregado"),
    steps:           Array.from(document.querySelectorAll(".track-step"))
  };

  // Ordered step keys must match data-step attributes in track.html
  const STEPS = ["solicitado", "pago-verificado", "en-preparacion", "listo-entrega", "entregado"];

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function getToken() {
    return new URLSearchParams(window.location.search).get("token") || "";
  }

  function showSection(section) {
    [els.loading, els.error, els.content].forEach(function (el) {
      if (el) el.hidden = true;
    });
    if (section) section.hidden = false;
  }

  function showError(message) {
    if (els.errorMessage) {
      els.errorMessage.textContent = message || "No se pudo cargar el pedido.";
    }
    showSection(els.error);
  }

  function formatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("es-CR", {
      timeZone: "America/Costa_Rica",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    }).format(d);
  }

  function formatCurrency(amount) {
    return new Intl.NumberFormat("es-CR", {
      style: "currency",
      currency: "CRC",
      maximumFractionDigits: 0
    }).format(Number(amount || 0));
  }

  // Map raw DB fields to the active step key.
  function resolveActiveStep(order) {
    const delivery = String(order.delivery_status || "").toUpperCase();
    const payment  = String(order.payment_status  || "").toUpperCase();
    if (delivery === "ENTREGADO")          return "entregado";
    if (delivery === "LISTO_PARA_ENTREGA") return "listo-entrega";
    if (delivery === "EN_PREPARACION")     return "en-preparacion";
    if (payment  === "PAGADO")             return "pago-verificado";
    return "solicitado";
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function renderTimeline(order) {
    const activeStep  = resolveActiveStep(order);
    const activeIndex = STEPS.indexOf(activeStep);

    els.steps.forEach(function (stepEl, i) {
      stepEl.classList.remove("is-done", "is-active", "is-pending");
      if (i < activeIndex)      stepEl.classList.add("is-done");
      else if (i === activeIndex) stepEl.classList.add("is-active");
      else                        stepEl.classList.add("is-pending");
    });

    if (els.timeSolicitado) els.timeSolicitado.textContent = formatTime(order.created_at);
    if (els.timePago)       els.timePago.textContent       = formatTime(order.payment_confirmed_at);
    if (els.timeEntregado)  els.timeEntregado.textContent  = formatTime(order.delivered_at);
  }

  function renderOrder(order) {
    if (els.buyerName)     els.buyerName.textContent     = order.buyer_name    || "—";
    if (els.menuTitle)     els.menuTitle.textContent     = order.menu_title    || "—";
    if (els.menuPrice)     els.menuPrice.textContent     = formatCurrency(order.menu_price);
    if (els.paymentMethod) els.paymentMethod.textContent = order.payment_method || "—";
    renderTimeline(order);
    showSection(els.content);
  }

  function setLiveStatus(connected) {
    if (!els.liveDot || !els.liveLabel) return;
    if (connected) {
      els.liveDot.classList.add("is-connected");
      els.liveLabel.textContent = "En vivo";
    } else {
      els.liveDot.classList.remove("is-connected");
      els.liveLabel.textContent = "Actualizando cada 30 s";
    }
  }

  // -------------------------------------------------------------------------
  // Network
  // -------------------------------------------------------------------------

  async function fetchOrder(token) {
    if (!config.apiBaseUrl || config.apiBaseUrl.includes("PEGUE_AQUI")) {
      throw new Error("La URL del backend no está configurada en config.js");
    }
    const res = await fetch(config.apiBaseUrl + "/track?token=" + encodeURIComponent(token));
    const payload = await res.json().catch(function () { return null; });
    if (!res.ok || !payload || !payload.ok) {
      throw new Error((payload && payload.message) || "No se pudo obtener el estado del pedido.");
    }
    return payload.order;
  }

  // -------------------------------------------------------------------------
  // Supabase Realtime subscription
  // Returns the channel so the caller can unsubscribe if needed.
  // Falls back gracefully when credentials are not yet configured.
  // -------------------------------------------------------------------------

  function subscribeRealtime(token, onUpdate) {
    const url  = config.supabaseUrl     || "";
    const key  = config.supabaseAnonKey || "";
    if (!url || url.includes("REPLACE_WITH") || !key || key.includes("REPLACE_WITH")) {
      setLiveStatus(false);
      return null;
    }

    const client = window.supabase.createClient(url, key, {
      realtime: { timeout: 60000 }
    });

    const channel = client
      .channel("order-track-" + token)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "orders",
          filter: "tracking_token=eq." + token
        },
        function (payload) {
          if (payload.new) onUpdate(payload.new);
        }
      )
      .subscribe(function (status) {
        setLiveStatus(status === "SUBSCRIBED");
      });

    return channel;
  }

  // -------------------------------------------------------------------------
  // Service worker registration (keeps page snappy on poor Wi-Fi)
  // -------------------------------------------------------------------------

  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(function () { return null; });
    }
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  async function start() {
    registerServiceWorker();

    const token = getToken();
    if (!token || token.length < 10) {
      showError("El enlace de seguimiento no es válido. Verifica el correo de confirmación.");
      return;
    }

    try {
      const order = await fetchOrder(token);
      renderOrder(order);

      // Primary: Supabase Realtime — instant updates pushed from the server
      subscribeRealtime(token, renderOrder);

      // Fallback: polling every 30 s covers cases where Realtime is not enabled
      window.setInterval(function () {
        fetchOrder(token).then(renderOrder).catch(function () { return null; });
      }, Number(config.refreshIntervalMs || 30000));

    } catch (err) {
      showError(err.message);
    }
  }

  start();
})();
