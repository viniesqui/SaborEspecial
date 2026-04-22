import { getDb } from "../lib/mongodb.js";
import { buildDashboardSnapshot, getDayKey, getTodayOrdersQuery } from "../lib/dashboard.js";
import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";

function validateMenu(menu) {
  if (!menu.title || !menu.description) {
    throw new Error("Faltan datos obligatorios del menu.");
  }

  if (Number(menu.price) < 0) {
    throw new Error("El precio no puede ser negativo.");
  }
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const { role } = await requireAuth(req, ["ADMIN", "HELPER"]);

    const validateOnly = Boolean(req.body?.validateOnly);
    if (validateOnly) {
      return res.status(200).json({ ok: true, message: "Acceso autorizado.", role });
    }

    const menu = req.body?.menu || {};
    validateMenu(menu);

    const db = await getDb();
    const dayKey = getDayKey();

    await db.collection("menus").updateMany(
      { active: true, dayKey: { $ne: dayKey } },
      { $set: { active: false } }
    );

    await db.collection("menus").updateOne(
      { dayKey },
      {
        $set: {
          dayKey,
          title:       String(menu.title).trim(),
          description: String(menu.description).trim(),
          price:       Number(menu.price || 0),
          active:      true,
          updatedAt:   new Date()
        }
      },
      { upsert: true }
    );

    const settingsDoc = await db.collection("settings").findOne({ key: "app_config" });
    const menuDoc     = await db.collection("menus").findOne({ dayKey, active: true });
    const orders      = await db.collection("orders")
      .find(getTodayOrdersQuery(dayKey))
      .sort({ createdAt: 1 })
      .toArray();

    return res.status(200).json({
      ok: true,
      message: "Menu del dia guardado correctamente.",
      snapshot: buildDashboardSnapshot(settingsDoc || {}, menuDoc || {}, orders)
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, message: error.message });
    }
    return res.status(400).json({
      ok: false,
      message: error.message || "No se pudo guardar el menu."
    });
  }
}
