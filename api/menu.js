import { handleOptions, setCors }            from "../lib/http.js";
import { getDayKey, buildDashboardSnapshot } from "../lib/dashboard.js";
import { requireAuth }                       from "../lib/auth.js";
import { upsert as upsertMenu, findActive }  from "../data/menus.repo.js";
import { findToday, getStats }              from "../data/orders.repo.js";
import { getSettings }                      from "../data/settings.repo.js";

function validateMenu(menu) {
  if (!menu.title || !menu.description) {
    throw new Error("Faltan datos obligatorios del menu.");
  }
  if (!Number.isFinite(Number(menu.price)) || Number(menu.price) < 0) {
    throw new Error("El precio debe ser un número válido mayor o igual a 0.");
  }
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const { role, cafeteriaId } = await requireAuth(req, ["ADMIN", "HELPER"]);

    // Used by the client to verify auth before rendering the form.
    if (Boolean(req.body?.validateOnly)) {
      return res.status(200).json({ ok: true, message: "Acceso autorizado.", role });
    }

    const menuInput = req.body?.menu || {};
    validateMenu(menuInput);

    const dayKey = getDayKey();

    const menu = await upsertMenu(cafeteriaId, dayKey, {
      title:       String(menuInput.title).trim(),
      description: String(menuInput.description).trim(),
      price:       Number(menuInput.price)
    });

    const [settings, freshMenu, orders, stats] = await Promise.all([
      getSettings(cafeteriaId),
      findActive(cafeteriaId, dayKey),
      findToday(cafeteriaId, dayKey),
      getStats(cafeteriaId, dayKey)
    ]);

    return res.status(200).json({
      ok:       true,
      message:  "Menu del dia guardado correctamente.",
      snapshot: buildDashboardSnapshot(settings, freshMenu || menu, orders, stats)
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, message: error.message });
    }
    return res.status(400).json({ ok: false, message: error.message || "No se pudo guardar el menu." });
  }
}
