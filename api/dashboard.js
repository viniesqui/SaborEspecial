import { handleOptions, setCors }                                       from "../lib/http.js";
import {
  getDayKey, buildDashboardSnapshot,
  getUpcomingDayKeys, isCutoffPassedForDate
} from "../lib/dashboard.js";
import { requireAuth }                                                   from "../lib/auth.js";
import { findBySlug }                                                    from "../data/cafeterias.repo.js";
import {
  findActive as findActiveMenu,
  findWeek,
  upsert as upsertMenu
} from "../data/menus.repo.js";
import { findToday, getStats, getWeekStats }                            from "../data/orders.repo.js";
import { getSettings }                                                   from "../data/settings.repo.js";

// WS-07 R-07-1: unified read surface for the customer dashboard, the
// management weekly menu grid, and the menu mutation endpoint. /api/menu
// (R-07-2) remains as a thin proxy for one deploy cycle.

const DAY_NAMES_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

// Resolves the cafeteria identity from either an auth token (staff views)
// or a public ?slug= parameter (customer-facing page).
async function resolveCafeteriaId(req, requireStaff = false) {
  const authHeader = String(req.headers["authorization"] || "");
  if (authHeader.startsWith("Bearer ")) {
    const { cafeteriaId, role } = await requireAuth(req, ["ADMIN", "HELPER", "ORDERS"]);
    return { cafeteriaId, role };
  }
  if (requireStaff) {
    throw { status: 401, message: "Autenticación requerida." };
  }

  const slug = String(req.query?.slug || "").toLowerCase().trim();
  if (!slug) throw { status: 400, message: "Parámetro 'slug' requerido." };

  const cafeteria = await findBySlug(slug);
  if (!cafeteria) throw { status: 404, message: "Cafetería no encontrada." };
  return { cafeteriaId: cafeteria.id, role: null };
}

function parseIncludes(query) {
  const raw = String(query?.include || "").trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

// Customer-facing weekly menu block (with sold/available counts and ordering window).
async function buildCustomerWeek(cafeteriaId, settings, todayKey) {
  const dayKeys = getUpcomingDayKeys(7);
  const fromKey = dayKeys[0];
  const toKey   = dayKeys[dayKeys.length - 1];

  const [weekMenuRows, soldByDate] = await Promise.all([
    findWeek(cafeteriaId, fromKey, toKey),
    getWeekStats(cafeteriaId, fromKey, toKey)
  ]);

  const menuByDay = {};
  weekMenuRows.forEach((m) => { menuByDay[m.day_key] = m; });

  const maxMeals = Number(settings.max_meals || 15);

  return dayKeys.map((date) => {
    const dayMenu = menuByDay[date] || null;
    const sold    = soldByDate[date] || 0;
    const avail   = Math.max(maxMeals - sold, 0);
    const d       = new Date(date + "T12:00:00Z");

    return {
      date,
      dayLabel:       DAY_NAMES_ES[d.getUTCDay()],
      isToday:        date === todayKey,
      isOrderingOpen: !isCutoffPassedForDate(settings, date) && avail > 0 && !!dayMenu,
      availableMeals: avail,
      menu:           dayMenu
        ? { title: dayMenu.title, description: dayMenu.description, price: Number(dayMenu.price) }
        : null
    };
  });
}

// Management-facing weekly menu block (raw rows — used by the menu planner UI).
async function buildManagementWeek(cafeteriaId) {
  const dayKeys = getUpcomingDayKeys(7);
  const menus   = await findWeek(cafeteriaId, dayKeys[0], dayKeys[dayKeys.length - 1]);

  const menuByDay = {};
  menus.forEach((m) => { menuByDay[m.day_key] = m; });

  return dayKeys.map((date) => ({
    date,
    menu: menuByDay[date] || null
  }));
}

function validateMenuPayload(menu) {
  if (!menu.title || !menu.description) {
    throw new Error("Faltan datos obligatorios del menu.");
  }
  if (!Number.isFinite(Number(menu.price)) || Number(menu.price) < 0) {
    throw new Error("El precio debe ser un número válido mayor o igual a 0.");
  }
}

function validateDayKey(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new Error("Fecha inválida.");
  if (dayKey < getDayKey()) throw new Error("No se pueden configurar menús para fechas pasadas.");
}

async function handleGet(req, res) {
  const { cafeteriaId } = await resolveCafeteriaId(req);
  const dayKey   = getDayKey();
  const includes = parseIncludes(req.query);

  // Management-only week grid (raw rows). Requested via ?include=menu.
  // Staff is already authenticated at this point if the request was Bearer-auth.
  if (includes.has("menu")) {
    const weekMenus = await buildManagementWeek(cafeteriaId);
    return res.status(200).json({ ok: true, weekMenus });
  }

  const [settings, menu, orders, stats] = await Promise.all([
    getSettings(cafeteriaId),
    findActiveMenu(cafeteriaId, dayKey),
    findToday(cafeteriaId, dayKey),
    getStats(cafeteriaId, dayKey)
  ]);

  const snapshot = buildDashboardSnapshot(settings || {}, menu, orders, stats);

  // ?week=true — legacy alias kept for the customer-facing day-selector.
  if (req.query?.week === "true") {
    snapshot.weekMenus  = await buildCustomerWeek(cafeteriaId, settings || {}, dayKey);
    snapshot.cutoffTime = String((settings || {}).cutoff_time || "09:00").slice(0, 5);
  }

  return res.status(200).json(snapshot);
}

async function handlePost(req, res) {
  // Menu mutation requires staff auth — no slug fallback.
  const { cafeteriaId, role } = await resolveCafeteriaId(req, true);

  if (Boolean(req.body?.validateOnly)) {
    return res.status(200).json({ ok: true, message: "Acceso autorizado.", role });
  }

  const menuInput = req.body?.menu || {};
  validateMenuPayload(menuInput);

  const dayKey = String(req.body?.dayKey || getDayKey()).trim();
  validateDayKey(dayKey);

  const menu = await upsertMenu(cafeteriaId, dayKey, {
    title:       String(menuInput.title).trim(),
    description: String(menuInput.description).trim(),
    price:       Number(menuInput.price),
    costPerDish: menuInput.cost !== undefined ? menuInput.cost : menuInput.costPerDish
  });

  const [settings, freshMenu, orders, stats] = await Promise.all([
    getSettings(cafeteriaId),
    findActiveMenu(cafeteriaId, dayKey),
    findToday(cafeteriaId, dayKey),
    getStats(cafeteriaId, dayKey)
  ]);

  return res.status(200).json({
    ok:       true,
    message:  "Menú guardado correctamente.",
    dayKey,
    snapshot: buildDashboardSnapshot(settings, freshMenu || menu, orders, stats)
  });
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  try {
    if (req.method === "GET")  return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res);
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  } catch (error) {
    const status = error.status || (req.method === "POST" ? 400 : 500);
    return res.status(status).json({ ok: false, message: error.message || "Unexpected server error." });
  }
}
