import { handleOptions, setCors }                                       from "../lib/http.js";
import {
  getDayKey, buildDashboardSnapshot,
  getUpcomingDayKeys, isCutoffPassedForDate
} from "../lib/dashboard.js";
import { requireAuth }                                                   from "../lib/auth.js";
import { findBySlug }                                                    from "../data/cafeterias.repo.js";
import { findActive as findActiveMenu, findWeek }                        from "../data/menus.repo.js";
import { findToday, getStats, getWeekStats }                            from "../data/orders.repo.js";
import { getSettings }                                                   from "../data/settings.repo.js";

const DAY_NAMES_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

// Resolves the cafeteria identity from either an auth token (staff views)
// or a public ?slug= parameter (customer-facing page).
async function resolveCafeteriaId(req) {
  const authHeader = String(req.headers["authorization"] || "");
  if (authHeader.startsWith("Bearer ")) {
    const { cafeteriaId } = await requireAuth(req, ["ADMIN", "HELPER", "ORDERS"]);
    return cafeteriaId;
  }

  const slug = String(req.query?.slug || "").toLowerCase().trim();
  if (!slug) throw { status: 400, message: "Parámetro 'slug' requerido." };

  const cafeteria = await findBySlug(slug);
  if (!cafeteria) throw { status: 404, message: "Cafetería no encontrada." };
  return cafeteria.id;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const cafeteriaId = await resolveCafeteriaId(req);
    const dayKey      = getDayKey();

    const [settings, menu, orders, stats] = await Promise.all([
      getSettings(cafeteriaId),
      findActiveMenu(cafeteriaId, dayKey),
      findToday(cafeteriaId, dayKey),
      getStats(cafeteriaId, dayKey)
    ]);

    // Pass menu through unchanged (may be null). buildDashboardSnapshot now
    // returns menu: null when absent, so the customer UI can show an empty
    // state instead of falling back to a placeholder.
    const snapshot = buildDashboardSnapshot(settings || {}, menu, orders, stats);

    // ?week=true — adds weekly menu data for the customer's day-selector UI.
    if (req.query?.week === "true") {
      const dayKeys = getUpcomingDayKeys(7);
      const fromKey = dayKeys[0];
      const toKey   = dayKeys[dayKeys.length - 1];

      // Fetch the weekly menu rows and the per-day sold counts in parallel.
      // getWeekStats issues ONE aggregate query for the whole range,
      // replacing the previous N-RPC waterfall (one get_day_stats per day).
      const [weekMenuRows, soldByDate] = await Promise.all([
        findWeek(cafeteriaId, fromKey, toKey),
        getWeekStats(cafeteriaId, fromKey, toKey)
      ]);

      const menuByDay = {};
      weekMenuRows.forEach((m) => { menuByDay[m.day_key] = m; });

      const maxMeals = Number(settings.max_meals || 15);

      snapshot.weekMenus = dayKeys.map((date) => {
        const dayMenu = menuByDay[date] || null;
        const sold    = soldByDate[date] || 0;
        const avail   = Math.max(maxMeals - sold, 0);
        // Parse date at noon UTC so getUTCDay() is day-stable in all TZs.
        const d       = new Date(date + "T12:00:00Z");

        return {
          date,
          dayLabel:       DAY_NAMES_ES[d.getUTCDay()],
          isToday:        date === dayKey,
          isOrderingOpen: !isCutoffPassedForDate(settings, date) && avail > 0 && !!dayMenu,
          availableMeals: avail,
          menu:           dayMenu
            ? { title: dayMenu.title, description: dayMenu.description, price: Number(dayMenu.price) }
            : null
        };
      });

      snapshot.cutoffTime = String(settings.cutoff_time || "09:00").slice(0, 5);
    }

    return res.status(200).json(snapshot);
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ ok: false, message: error.message || "Unexpected server error." });
  }
}
