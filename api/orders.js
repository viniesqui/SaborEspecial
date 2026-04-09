import { getDb } from "../lib/mongodb.js";
import { buildDashboardSnapshot, getDayKey, parseBoolean } from "../lib/dashboard.js";
import { handleOptions, setCors } from "../lib/http.js";

function validateOrder(order) {
  if (!order.buyerName || !order.buyerId || !order.buyerPhone || !order.paymentMethod) {
    throw new Error("Faltan datos obligatorios.");
  }
}

function normalizeOrder(order, menu, dayKey) {
  return {
    createdAt: new Date(),
    dayKey,
    buyerName: String(order.buyerName || "").trim(),
    buyerId: String(order.buyerId || "").trim(),
    buyerPhone: String(order.buyerPhone || "").trim(),
    paymentMethod: String(order.paymentMethod || "").trim(),
    paymentStatus: order.paymentMethod === "SINPE" ? "POR_VERIFICAR" : "PENDIENTE_ENTREGA",
    paymentReference: String(order.paymentReference || "").trim(),
    notes: String(order.notes || "").trim(),
    menuTitle: menu?.title || "Menu no configurado",
    menuDescription: menu?.description || "",
    menuPrice: Number(menu?.price || 1000),
    recordStatus: "ACTIVO"
  };
}

function isSalesWindowAllowed(settings, snapshot) {
  if (parseBoolean(settings.disableSalesWindow)) return true;
  return snapshot.isSalesOpen;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const db = await getDb();
    const dayKey = getDayKey();
    const order = req.body?.order || {};

    validateOrder(order);

    const settingsDoc = await db.collection("settings").findOne({ key: "app_config" });
    const menuDoc = await db.collection("menus").findOne({ dayKey, active: true });
    const existingOrders = await db.collection("orders")
      .find({ dayKey, recordStatus: { $ne: "CANCELADO" } })
      .sort({ createdAt: 1 })
      .toArray();

    const snapshot = buildDashboardSnapshot(settingsDoc || {}, menuDoc || {}, existingOrders);

    if (!isSalesWindowAllowed(settingsDoc || {}, snapshot)) {
      return res.status(400).json({ ok: false, message: "La venta de almuerzos esta cerrada." });
    }

    if (snapshot.availableMeals <= 0) {
      return res.status(400).json({ ok: false, message: "Ya no hay almuerzos disponibles para hoy." });
    }

    await db.collection("orders").insertOne(normalizeOrder(order, menuDoc, dayKey));

    const freshOrders = await db.collection("orders")
      .find({ dayKey, recordStatus: { $ne: "CANCELADO" } })
      .sort({ createdAt: 1 })
      .toArray();

    return res.status(200).json({
      ok: true,
      message: "Compra registrada correctamente.",
      snapshot: buildDashboardSnapshot(settingsDoc || {}, menuDoc || {}, freshOrders)
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message: error.message || "No se pudo registrar la compra."
    });
  }
}
