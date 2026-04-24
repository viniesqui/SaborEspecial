import { handleOptions, setCors }            from "../lib/http.js";
import { getDayKey, buildDashboardSnapshot } from "../lib/dashboard.js";
import { requireAuth }                       from "../lib/auth.js";
import { findBySlug }                        from "../data/cafeterias.repo.js";
import { findActive as findActiveMenu }      from "../data/menus.repo.js";
import { findToday, getStats }              from "../data/orders.repo.js";
import { getSettings }                      from "../data/settings.repo.js";

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

    return res.status(200).json(buildDashboardSnapshot(settings || {}, menu || {}, orders, stats));
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ ok: false, message: error.message || "Unexpected server error." });
  }
}
