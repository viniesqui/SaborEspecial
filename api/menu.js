import { handleOptions, setCors }                                    from "../lib/http.js";
import { getDayKey, getUpcomingDayKeys, buildDashboardSnapshot }     from "../lib/dashboard.js";
import { requireAuth }                                               from "../lib/auth.js";
import { upsert as upsertMenu, findActive, findWeek }                from "../data/menus.repo.js";
import { findToday, getStats }                                       from "../data/orders.repo.js";
import { getSettings }                                               from "../data/settings.repo.js";

function validateMenu(menu) {
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

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  // ── GET: weekly menu grid for the management planning view ────────
  if (req.method === "GET") {
    try {
      const { cafeteriaId } = await requireAuth(req, ["ADMIN", "HELPER"]);
      const dayKeys = getUpcomingDayKeys(7);
      const menus   = await findWeek(cafeteriaId, dayKeys[0], dayKeys[dayKeys.length - 1]);

      const menuByDay = {};
      menus.forEach((m) => { menuByDay[m.day_key] = m; });

      const weekMenus = dayKeys.map((date) => ({
        date,
        menu: menuByDay[date] || null
      }));

      return res.status(200).json({ ok: true, weekMenus });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ ok: false, message: error.message });
      return res.status(400).json({ ok: false, message: error.message || "Error al cargar menús semanales." });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const { role, cafeteriaId } = await requireAuth(req, ["ADMIN", "HELPER"]);

    if (Boolean(req.body?.validateOnly)) {
      return res.status(200).json({ ok: true, message: "Acceso autorizado.", role });
    }

    const menuInput = req.body?.menu || {};
    validateMenu(menuInput);

    // Accept an explicit dayKey from the body for weekly scheduling.
    // Falls back to today for backward compatibility.
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
      findActive(cafeteriaId, dayKey),
      findToday(cafeteriaId, dayKey),
      getStats(cafeteriaId, dayKey)
    ]);

    return res.status(200).json({
      ok:       true,
      message:  "Menú guardado correctamente.",
      dayKey,
      snapshot: buildDashboardSnapshot(settings, freshMenu || menu, orders, stats)
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, message: error.message });
    }
    return res.status(400).json({ ok: false, message: error.message || "No se pudo guardar el menu." });
  }
}
