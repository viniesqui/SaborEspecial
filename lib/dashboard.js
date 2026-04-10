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

export function getCostaRicaDayRange(dayKey = getDayKey()) {
  const parts = String(dayKey).split("-").map(Number);
  const start = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], COSTA_RICA_OFFSET_HOURS, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function getTodayOrdersQuery(dayKey = getDayKey()) {
  const range = getCostaRicaDayRange(dayKey);
  return {
    recordStatus: { $ne: "CANCELADO" },
    $or: [
      { dayKey },
      {
        createdAt: {
          $gte: range.start,
          $lt: range.end
        }
      }
    ]
  };
}

export function parseBoolean(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "si" || normalized === "sí";
}

function normalizeTime(value, fallback) {
  const clean = String(value || fallback || "").trim();
  return clean.length === 4 ? "0" + clean : clean;
}

function isSalesOpenNow(settings, availableMeals) {
  if (availableMeals <= 0) return false;
  if (parseBoolean(settings.disableSalesWindow)) return true;

  const salesStart = normalizeTime(settings.salesStart, "10:00");
  const salesEnd = normalizeTime(settings.salesEnd, "12:00");
  const now = new Date();
  const today = getDayKey();
  const start = new Date(`${today}T${salesStart}:00`);
  const end = new Date(`${today}T${salesEnd}:00`);
  return now >= start && now <= end;
}

function formatTimestamp(value) {
  if (!value) return "";

  return new Intl.DateTimeFormat("es-CR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function buildDashboardSnapshot(settings, menu, orders) {
  const maxMeals = Number(settings.maxMeals || 15);
  const soldMeals = orders.length;
  const availableMeals = Math.max(maxMeals - soldMeals, 0);
  const sinpeCount = orders.filter((item) => item.paymentMethod === "SINPE").length;
  const cashCount = orders.filter((item) => item.paymentMethod === "EFECTIVO").length;
  const totalAmount = orders.reduce((sum, item) => sum + Number(item.menuPrice || 0), 0);

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
    salesWindow: `${settings.salesStart || "10:00"} - ${settings.salesEnd || "12:00"}`,
    deliveryWindow: settings.deliveryWindow || "12:00 - 12:30",
    menu: {
      title: menu?.title || "Menu no configurado",
      description: menu?.description || "",
      price: Number(menu?.price || 1000)
    },
    orders: orders.map((item) => ({
      buyerName: item.buyerName,
      paymentMethod: item.paymentMethod,
      paymentStatus: item.paymentStatus,
      timestampLabel: formatTimestamp(item.createdAt)
    }))
  };
}
