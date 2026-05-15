(function () {
  "use strict";

  window.SE = window.SE || {};

  window.SE.fmt = (function () {

    function currency(amount) {
      return new Intl.NumberFormat("es-CR", {
        style:              "currency",
        currency:           "CRC",
        maximumFractionDigits: 0
      }).format(Number(amount || 0));
    }

    // Normalises the multi-value payment_status enum to the two labels
    // the UI actually cares about.
    function paymentLabel(status) {
      var s = String(status || "").toUpperCase();
      if (s === "PAGADO" || s === "CONFIRMADO" || s === "CONFIRMADO_SINPE") return "PAGADO";
      return "PENDIENTE DE PAGO";
    }

    function paymentClass(status) {
      return paymentLabel(status) === "PAGADO"
        ? "delivery-payment-status delivery-payment-status--paid"
        : "delivery-payment-status delivery-payment-status--pending";
    }

    // Full weekday + date + time label, e.g. "Actualizado Lunes 7 de abril del 2026 a las 11:45 AM"
    function dateTime(value) {
      if (!value) return "Sin datos recientes";
      var d = new Date(value);
      if (Number.isNaN(d.getTime())) return "Sin datos recientes";

      var parts = new Intl.DateTimeFormat("es-CR", {
        timeZone: "America/Costa_Rica",
        weekday:  "long",
        day:      "numeric",
        month:    "long",
        year:     "numeric",
        hour:     "numeric",
        minute:   "2-digit",
        hour12:   true
      }).formatToParts(d);

      function get(type) {
        var p = parts.find(function (x) { return x.type === type; });
        return p ? p.value : "";
      }

      var weekday = get("weekday");
      var cap     = weekday ? weekday.charAt(0).toUpperCase() + weekday.slice(1) : "";
      var period  = get("dayPeriod").replace(/\./g, "").toUpperCase();

      return "Actualizado " + [
        cap, get("day"), "de", get("month"), "del", get("year"),
        "a las", get("hour") + ":" + get("minute"), period
      ].join(" ");
    }

    // Short timestamp: "10:45 AM"
    function timeShort(value) {
      if (!value) return "";
      var d = new Date(value);
      if (Number.isNaN(d.getTime())) return "";

      // jscpd:ignore-start  (TODO WS-06: extract Intl.DateTimeFormat part-picker helper)
      var parts = new Intl.DateTimeFormat("es-CR", {
        timeZone: "America/Costa_Rica",
        hour:     "numeric",
        minute:   "2-digit",
        hour12:   true
      }).formatToParts(d);

      function get(type) {
        var p = parts.find(function (x) { return x.type === type; });
        return p ? p.value : "";
      }
      // jscpd:ignore-end

      return get("hour") + ":" + get("minute") + " " +
        get("dayPeriod").replace(/\./g, "").toUpperCase();
    }

    return {
      currency:     currency,
      paymentLabel: paymentLabel,
      paymentClass: paymentClass,
      dateTime:     dateTime,
      timeShort:    timeShort
    };
  })();

  // ── Date keys & labels (canonical client copies of lib/dashboard.js) ──
  // WS-06 R-06-1 / R-06-3: one implementation per helper.

  var DIAS_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

  window.SE.dates = {
    // Today's YYYY-MM-DD in Costa Rica time (UTC-6, no DST).
    // Mirrors getDayKey() in lib/dashboard.js.
    today: function () {
      return new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
    },

    // "2026-04-28" → "Mar 28 abr". Anchored at noon UTC so weekday is stable.
    formatLabel: function (dateStr) {
      var d   = new Date(dateStr + "T12:00:00Z");
      var day = DIAS_ES[d.getUTCDay()];
      var dom = d.getUTCDate();
      var mon = d.toLocaleDateString("es-CR", { month: "short", timeZone: "UTC" });
      return day + " " + dom + " " + mon;
    }
  };
})();
