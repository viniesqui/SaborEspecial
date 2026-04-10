import { getDb } from "../lib/mongodb.js";
import { getDayKey } from "../lib/dashboard.js";
import { handleOptions, setCors } from "../lib/http.js";
import { ObjectId } from "mongodb";

function getOrdersPassword(req) {
  return String(req.headers["x-orders-password"] || "");
}

function ensureAuthorized(req, res) {
  const expectedPassword = String(process.env.ORDERS_PASSWORD || "");
  if (!expectedPassword) {
    res.status(500).json({ ok: false, message: "Missing ORDERS_PASSWORD in Vercel." });
    return false;
  }

  if (getOrdersPassword(req) !== expectedPassword) {
    res.status(401).json({ ok: false, message: "Clave de entregas incorrecta." });
    return false;
  }

  return true;
}

function formatTimestamp(value) {
  if (!value) return "";

  return new Intl.DateTimeFormat("es-CR", {
    timeZone: "America/Costa_Rica",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "";

  return new Intl.DateTimeFormat("es-CR", {
    timeZone: "America/Costa_Rica",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function buildDeliveriesSnapshot(settingsDoc, menuDoc, orders) {
  const totalOrders = orders.length;
  const deliveredOrders = orders.filter((item) => item.deliveryStatus === "ENTREGADO").length;
  const pendingDeliveries = Math.max(totalOrders - deliveredOrders, 0);
  const totalAmount = orders.reduce((sum, item) => sum + Number(item.menuPrice || 0), 0);

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    totalOrders,
    pendingDeliveries,
    deliveredOrders,
    totalAmount,
    salesWindow: `${settingsDoc?.salesStart || "10:00"} - ${settingsDoc?.salesEnd || "12:00"}`,
    deliveryWindow: settingsDoc?.deliveryWindow || "12:00 - 12:30",
    menu: {
      title: menuDoc?.title || "Menu no configurado",
      description: menuDoc?.description || "",
      price: Number(menuDoc?.price || 1000)
    },
    orders: orders.map((item) => ({
      id: String(item._id),
      buyerName: item.buyerName,
      paymentMethod: item.paymentMethod,
      paymentStatus: item.paymentStatus,
      deliveryStatus: item.deliveryStatus || "PENDIENTE_ENTREGA",
      timestampLabel: formatTimestamp(item.createdAt),
      deliveredAtLabel: item.deliveredAt ? formatDateTime(item.deliveredAt) : ""
    }))
  };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method === "GET") {
    if (!ensureAuthorized(req, res)) return;

    try {
      const db = await getDb();
      const dayKey = getDayKey();

      const settingsDoc = await db.collection("settings").findOne({ key: "app_config" });
      const menuDoc = await db.collection("menus").findOne({ dayKey, active: true });
      const orders = await db.collection("orders")
        .find({ dayKey, recordStatus: { $ne: "CANCELADO" } })
        .sort({ createdAt: 1 })
        .toArray();

      return res.status(200).json(buildDeliveriesSnapshot(settingsDoc || {}, menuDoc || {}, orders));
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message: error.message || "Unexpected server error."
      });
    }
  }

  if (req.method === "POST") {
    if (!ensureAuthorized(req, res)) return;

    try {
      const db = await getDb();
      const dayKey = getDayKey();
      const orderId = String(req.body?.orderId || "");
      const deliveryStatus = String(req.body?.deliveryStatus || "");

      if (!ObjectId.isValid(orderId)) {
        return res.status(400).json({ ok: false, message: "Pedido invalido." });
      }

      if (!["PENDIENTE_ENTREGA", "ENTREGADO"].includes(deliveryStatus)) {
        return res.status(400).json({ ok: false, message: "Estado de entrega invalido." });
      }

      const orderObjectId = new ObjectId(orderId);

      await db.collection("orders").updateOne(
        { _id: orderObjectId, dayKey },
        {
          $set: {
            deliveryStatus,
            deliveredAt: deliveryStatus === "ENTREGADO" ? new Date() : null
          }
        }
      );

      await db.collection("delivery_events").insertOne({
        orderId: orderObjectId,
        dayKey,
        deliveryStatus,
        createdAt: new Date()
      });

      const settingsDoc = await db.collection("settings").findOne({ key: "app_config" });
      const menuDoc = await db.collection("menus").findOne({ dayKey, active: true });
      const orders = await db.collection("orders")
        .find({ dayKey, recordStatus: { $ne: "CANCELADO" } })
        .sort({ createdAt: 1 })
        .toArray();

      return res.status(200).json(buildDeliveriesSnapshot(settingsDoc || {}, menuDoc || {}, orders));
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message: error.message || "Unexpected server error."
      });
    }
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }
}
