import { getDb } from "../lib/mongodb.js";
import { buildDashboardSnapshot, getDayKey, getTodayOrdersQuery } from "../lib/dashboard.js";
import { handleOptions, setCors } from "../lib/http.js";

function validateMenu(menu) {
  if (!menu.title || !menu.description) {
    throw new Error("Faltan datos obligatorios del menu.");
  }

  if (Number(menu.price) < 0) {
    throw new Error("El precio no puede ser negativo.");
  }
}

function resolveMenuAccessPassword(req) {
  return String(
    req.body?.adminSecret ||
    req.body?.accessPassword ||
    ""
  ).trim();
}

function getMenuAccessRole(password) {
  const adminSecret = String(process.env.ADMIN_SECRET || "");
  const helperPassword = String(process.env.HELPER_PASSWORD || "");

  if (password && adminSecret && password === adminSecret) return "ADMIN";
  if (password && helperPassword && password === helperPassword) return "HELPER";
  return "";
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const accessPassword = resolveMenuAccessPassword(req);
    const validateOnly = Boolean(req.body?.validateOnly);
    const accessRole = getMenuAccessRole(accessPassword);

    if (!process.env.ADMIN_SECRET && !process.env.HELPER_PASSWORD) {
      return res.status(500).json({ ok: false, message: "Missing menu access password in Vercel." });
    }

    if (!accessRole) {
      return res.status(401).json({ ok: false, message: "Clave incorrecta para menu." });
    }

    if (validateOnly) {
      return res.status(200).json({ ok: true, message: "Acceso autorizado.", role: accessRole });
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
          title: String(menu.title).trim(),
          description: String(menu.description).trim(),
          price: Number(menu.price || 0),
          active: true,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    const settingsDoc = await db.collection("settings").findOne({ key: "app_config" });
    const menuDoc = await db.collection("menus").findOne({ dayKey, active: true });
    const orders = await db.collection("orders")
      .find(getTodayOrdersQuery(dayKey))
      .sort({ createdAt: 1 })
      .toArray();

    return res.status(200).json({
      ok: true,
      message: "Menu del dia guardado correctamente.",
      snapshot: buildDashboardSnapshot(settingsDoc || {}, menuDoc || {}, orders)
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message: error.message || "No se pudo guardar el menu."
    });
  }
}
