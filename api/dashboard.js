import { getDb } from "../lib/mongodb.js";
import { buildDashboardSnapshot, getDayKey, getTodayOrdersQuery } from "../lib/dashboard.js";
import { handleOptions, setCors } from "../lib/http.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const db = await getDb();
    const dayKey = getDayKey();

    const settingsDoc = await db.collection("settings").findOne({ key: "app_config" });
    const menuDoc = await db.collection("menus").findOne({ dayKey, active: true });
    const orders = await db.collection("orders")
      .find(getTodayOrdersQuery(dayKey))
      .sort({ createdAt: 1 })
      .toArray();

    return res.status(200).json(buildDashboardSnapshot(settingsDoc || {}, menuDoc || {}, orders));
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || "Unexpected server error."
    });
  }
}
