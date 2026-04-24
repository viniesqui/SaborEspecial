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
})();
