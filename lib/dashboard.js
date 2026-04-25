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

// Returns the current clock time in Costa Rica as "HH:MM" (zero-padded).
// Uses the Intl API so it is correct on UTC-only servers (Vercel, etc.).
function getCRHHMM() {
  const parts = new Intl.DateTimeFormat("es-CR", {
    timeZone: "America/Costa_Rica",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false
  }).formatToParts(new Date());
  const h = (parts.find((p) => p.type === "hour")   || {}).value || "00";
  const m = (parts.find((p) => p.type === "minute") || {}).value || "00";
  return h.padStart(2, "0") + ":" + m.padStart(2, "0");
}

/**
 * Determines whether the ordering window for a specific target date has closed.
 *
 * - Future date  → always open (only capacity check applies).
 * - Past date    → always closed.
 * - Today        → closed once the current CR time reaches cutoff_time.
 *
 * All time comparisons use "HH:MM" string ordering which is correct for
 * zero-padded 24-hour time values.
 */
export function isCutoffPassedForDate(settings, targetDate) {
  const todayKey = getDayKey();
  if (targetDate > todayKey) return false;
  if (targetDate < todayKey) return true;
  const cutoffTime = normalizeTime(settings.cutoff_time, "09:00");
  return getCRHHMM() >= cutoffTime;
}

// Legacy: used by the general sales-window feature in the customer dashboard display.
export function isSalesOpenNow(settings) {
  if (parseBoolean(settings.disable_sales_window)) return true;

  const salesStart = normalizeTime(settings.sales_start, "10:00");
  const salesEnd   = normalizeTime(settings.sales_end,   "12:00");
  const crNow      = getCRHHMM();
  return crNow >= salesStart && crNow <= salesEnd;
}

/**
 * Returns an array of date strings (YYYY-MM-DD) for the next `n` consecutive
 * days starting from today in Costa Rica time.  Used to build weekly grids.
 */
export function getUpcomingDayKeys(n = 7) {
  const days = [];
  for (let i = 0; i < n; i++) {
    // Shift by i full days relative to the CR-adjusted "now".
    const d = new Date(Date.now() - 6 * 60 * 60 * 1000 + i * 24 * 60 * 60 * 1000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
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
 * pre-computed SQL stats.  When stats are supplied the JS aggregations
 * are skipped entirely.
 */
export function buildDashboardSnapshot(settings, menu, orders, stats = null) {
  const maxMeals     = Number(settings.max_meals || 15);
  const soldMeals    = stats ? stats.totalOrders   : orders.length;
  const sinpeCount   = stats ? stats.sinpeCount    : orders.filter((o) => o.payment_method === "SINPE").length;
  const cashCount    = stats ? stats.cashCount     : orders.filter((o) => o.payment_method === "EFECTIVO").length;
  const totalAmount  = stats ? stats.totalAmount   : orders.reduce((s, o) => s + Number(o.menu_price || 0), 0);
  const digitalCount = stats ? stats.digitalCount  : orders.filter((o) => o.order_channel !== "WALK_IN").length;
  const walkInCount  = stats ? stats.walkInCount   : orders.filter((o) => o.order_channel === "WALK_IN").length;
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
    digitalCount,
    walkInCount,
    cutoffTime:     normalizeTime(settings.cutoff_time, "09:00"),
    message:        settings.message || "Venta maxima de 15 almuerzos por dia.",
    salesWindow:    `${normalizeTime(settings.sales_start, "10:00")} - ${normalizeTime(settings.sales_end, "12:00")}`,
    deliveryWindow: settings.delivery_window || "12:00 - 12:30",
    menu: {
      title:       menu?.title       || "Menu no configurado",
      description: menu?.description || "",
      price:       Number(menu?.price || 1000)
    },
    orders: orders.map((o) => ({
      id:                      o.id,
      buyerName:               o.buyer_name,
      paymentMethod:           o.payment_method,
      paymentStatus:           normalizePaymentStatus(o.payment_status),
      orderStatus:             o.order_status    || "SOLICITADO",
      deliveryStatus:          o.delivery_status || "PENDIENTE_ENTREGA",
      orderChannel:            o.order_channel   || "DIGITAL",
      timestampLabel:          formatTimestamp(o.created_at),
      createdAtLabel:          formatTimestamp(o.created_at),
      paymentConfirmedAtLabel: o.payment_confirmed_at ? formatTimestamp(o.payment_confirmed_at) : "",
      deliveredAtLabel:        o.delivered_at         ? formatTimestamp(o.delivered_at)          : ""
    }))
  };
}
