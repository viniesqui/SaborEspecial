const COSTA_RICA_OFFSET_HOURS = 6;

function pad(value) {
  return String(value).padStart(2, "0");
}

function getCostaRicaShiftedDate(date = new Date()) {
  return new Date(date.getTime() - COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000);
}

export function getDayKey(date = new Date()) {
  const shifted = getCostaRicaShiftedDate(date);
  return [
    shifted.getUTCFullYear(),
    pad(shifted.getUTCMonth() + 1),
    pad(shifted.getUTCDate())
  ].join("-");
}

export function parseBoolean(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "si" || normalized === "sí";
}

// Normalizes a PostgreSQL TIME string ("10:00:00") or short form ("10:00") to "HH:MM".
function normalizeTime(value, fallback) {
  const raw = String(value || fallback || "").trim().slice(0, 5);
  return raw.length === 4 ? "0" + raw : raw;
}

function isSalesOpenNow(settings, availableMeals) {
  if (availableMeals <= 0) return false;
  if (parseBoolean(settings.disable_sales_window)) return true;

  const salesStart = normalizeTime(settings.sales_start, "10:00");
  const salesEnd = normalizeTime(settings.sales_end, "12:00");
  const now = new Date();
  const today = getDayKey();
  const start = new Date(`${today}T${salesStart}:00`);
  const end = new Date(`${today}T${salesEnd}:00`);
  return now >= start && now <= end;
}

function formatTimestamp(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-CR", {
    timeZone: "America/Costa_Rica",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function getPaymentStatusLabel(value) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === "PAGADO" || normalized === "CONFIRMADO" || normalized === "CONFIRMADO_SINPE") {
    return "PAGADO";
  }
  if (normalized === "POR_VERIFICAR" || normalized === "PENDIENTE_DE_PAGO") {
    return "PENDIENTE DE PAGO";
  }
  return normalized.replaceAll("_", " ") || "PENDIENTE DE PAGO";
}

// Accepts Supabase rows (snake_case) for settings, menu, and orders.
export function buildDashboardSnapshot(settings, menu, orders) {
  const maxMeals = Number(settings.max_meals || 15);
  const soldMeals = orders.length;
  const availableMeals = Math.max(maxMeals - soldMeals, 0);
  const sinpeCount = orders.filter((o) => o.payment_method === "SINPE").length;
  const cashCount = orders.filter((o) => o.payment_method === "EFECTIVO").length;
  const totalAmount = orders.reduce((sum, o) => sum + Number(o.menu_price || 0), 0);

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    isSalesOpen: isSalesOpenNow(settings, availableMeals),
    availableMeals,
    soldMeals,
    sinpeCount,
    cashCount,
    totalAmount,
    message: settings.message || "Venta maxima de 15 almuerzos por dia.",
    salesWindow: `${normalizeTime(settings.sales_start, "10:00")} - ${normalizeTime(settings.sales_end, "12:00")}`,
    deliveryWindow: settings.delivery_window || "12:00 - 12:30",
    menu: {
      title: menu?.title || "Menu no configurado",
      description: menu?.description || "",
      price: Number(menu?.price || 1000)
    },
    orders: orders.map((o) => ({
      buyerName: o.buyer_name,
      paymentMethod: o.payment_method,
      paymentStatus: getPaymentStatusLabel(o.payment_status),
      orderStatus: o.order_status || "SOLICITADO",
      deliveryStatus: o.delivery_status || "PENDIENTE_ENTREGA",
      timestampLabel: formatTimestamp(o.created_at),
      createdAtLabel: formatTimestamp(o.created_at),
      paymentConfirmedAtLabel: o.payment_confirmed_at ? formatTimestamp(o.payment_confirmed_at) : "",
      deliveredAtLabel: o.delivered_at ? formatTimestamp(o.delivered_at) : ""
    }))
  };
}
