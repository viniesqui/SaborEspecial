// Costa Rica is UTC-6 year-round (no DST observed).
// This matches PostgreSQL's (NOW() AT TIME ZONE 'America/Costa_Rica')::date.
export function getDayKey() {
  return new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function parseBoolean(value) {
  const s = String(value || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "si" || s === "sí";
}

// Normalises a PostgreSQL TIME string ("10:00:00") to "HH:MM".
function normalizeTime(value, fallback) {
  const raw = String(value || fallback || "").trim().slice(0, 5);
  return raw.length === 4 ? "0" + raw : raw;
}

export function isSalesOpenNow(settings) {
  if (parseBoolean(settings.disable_sales_window)) return true;

  const salesStart = normalizeTime(settings.sales_start, "10:00");
  const salesEnd   = normalizeTime(settings.sales_end,   "12:00");
  const todayKey   = getDayKey();
  const now        = new Date();
  const start      = new Date(`${todayKey}T${salesStart}:00`);
  const end        = new Date(`${todayKey}T${salesEnd}:00`);
  return now >= start && now <= end;
}

function formatTimestamp(value) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("es-CR", {
    timeZone: "America/Costa_Rica",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true
  }).formatToParts(new Date(value));

  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").replace(/\./g, "").toUpperCase()}`;
}

function normalizePaymentStatus(status) {
  const s = String(status || "").toUpperCase();
  if (s === "PAGADO" || s === "CONFIRMADO" || s === "CONFIRMADO_SINPE") return "PAGADO";
  return "PENDIENTE DE PAGO";
}

/**
 * Builds the public-facing snapshot from settings, menu, orders, and
 * pre-computed SQL stats. When stats are supplied (Priority 8 path),
 * the JS filter/reduce loops are skipped entirely.
 *
 * @param {object} settings  - Row from the settings table
 * @param {object} menu      - Active menu row (or {})
 * @param {Array}  orders    - Today's active order rows
 * @param {object} [stats]   - Result of get_day_stats() (optional)
 */
export function buildDashboardSnapshot(settings, menu, orders, stats = null) {
  const maxMeals     = Number(settings.max_meals || 15);
  const soldMeals    = stats ? stats.totalOrders   : orders.length;
  const sinpeCount   = stats ? stats.sinpeCount    : orders.filter((o) => o.payment_method === "SINPE").length;
  const cashCount    = stats ? stats.cashCount     : orders.filter((o) => o.payment_method === "EFECTIVO").length;
  const totalAmount  = stats ? stats.totalAmount   : orders.reduce((s, o) => s + Number(o.menu_price || 0), 0);
  const availableMeals = Math.max(maxMeals - soldMeals, 0);

  return {
    ok:             true,
    updatedAt:      new Date().toISOString(),
    isSalesOpen:    isSalesOpenNow(settings) && availableMeals > 0,
    availableMeals,
    soldMeals,
    sinpeCount,
    cashCount,
    totalAmount,
    message:        settings.message || "Venta maxima de 15 almuerzos por dia.",
    salesWindow:    `${normalizeTime(settings.sales_start, "10:00")} - ${normalizeTime(settings.sales_end, "12:00")}`,
    deliveryWindow: settings.delivery_window || "12:00 - 12:30",
    menu: {
      title:       menu?.title       || "Menu no configurado",
      description: menu?.description || "",
      price:       Number(menu?.price || 1000)
    },
    orders: orders.map((o) => ({
      buyerName:               o.buyer_name,
      paymentMethod:           o.payment_method,
      paymentStatus:           normalizePaymentStatus(o.payment_status),
      orderStatus:             o.order_status    || "SOLICITADO",
      deliveryStatus:          o.delivery_status || "PENDIENTE_ENTREGA",
      timestampLabel:          formatTimestamp(o.created_at),
      createdAtLabel:          formatTimestamp(o.created_at),
      paymentConfirmedAtLabel: o.payment_confirmed_at ? formatTimestamp(o.payment_confirmed_at) : "",
      deliveredAtLabel:        o.delivered_at         ? formatTimestamp(o.delivered_at)          : ""
    }))
  };
}
