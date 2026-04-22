import { getDb } from "../lib/mongodb.js";
import { getDayKey, getTodayOrdersQuery } from "../lib/dashboard.js";
import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";
import { ObjectId } from "mongodb";

function formatTimestamp(value) {
  if (!value) return "";

  const parts = new Intl.DateTimeFormat("es-CR", {
    timeZone: "America/Costa_Rica",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).formatToParts(new Date(value));

  function get(type) {
    const part = parts.find((item) => item.type === type);
    return part ? part.value : "";
  }

  const dayPeriod = get("dayPeriod").replace(/\./g, "").toUpperCase();
  return `${get("hour")}:${get("minute")} ${dayPeriod}`;
}

function formatDateTime(value) {
  if (!value) return "";

  return formatTimestamp(value);
}

function getPaymentStatusLabel(paymentStatus) {
  const normalized = String(paymentStatus || "").toUpperCase();
  if (["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"].includes(normalized)) {
    return "PAGADO";
  }
  return "PENDIENTE DE PAGO";
}

function buildDeliveriesSnapshot(settingsDoc, menuDoc, orders) {
  const totalOrders = orders.length;
  const paidOrders = orders.filter((item) => getPaymentStatusLabel(item.paymentStatus) === "PAGADO").length;
  const pendingPaymentCount = Math.max(totalOrders - paidOrders, 0);
  const deliveredOrders = orders.filter((item) => item.deliveryStatus === "ENTREGADO").length;
  const pendingDeliveries = Math.max(totalOrders - deliveredOrders, 0);
  const paidPendingDeliveryCount = orders.filter((item) =>
    getPaymentStatusLabel(item.paymentStatus) === "PAGADO" && item.deliveryStatus !== "ENTREGADO"
  ).length;

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    totalOrders,
    pendingPaymentCount,
    paidOrders,
    paidPendingDeliveryCount,
    pendingDeliveries,
    deliveredOrders,
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
      paymentStatus: getPaymentStatusLabel(item.paymentStatus),
      orderStatus: item.orderStatus || "SOLICITADO",
      deliveryStatus: item.deliveryStatus || "PENDIENTE_ENTREGA",
      timestampLabel: formatTimestamp(item.createdAt),
      createdAtLabel: formatDateTime(item.createdAt),
      paymentConfirmedAtLabel: item.paymentConfirmedAt ? formatDateTime(item.paymentConfirmedAt) : "",
      deliveredAtLabel: item.deliveredAt ? formatDateTime(item.deliveredAt) : ""
    }))
  };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method === "GET") {
    try {
      await requireAuth(req, ["ADMIN", "HELPER", "ORDERS"]);
      const db = await getDb();
      const dayKey = getDayKey();

      const settingsDoc = await db.collection("settings").findOne({ key: "app_config" });
      const menuDoc = await db.collection("menus").findOne({ dayKey, active: true });
      const orders = await db.collection("orders")
        .find(getTodayOrdersQuery(dayKey))
        .sort({ createdAt: 1 })
        .toArray();

      return res.status(200).json(buildDeliveriesSnapshot(settingsDoc || {}, menuDoc || {}, orders));
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({ ok: false, message: error.message });
      }
      return res.status(500).json({
        ok: false,
        message: error.message || "Unexpected server error."
      });
    }
  }

  if (req.method === "POST") {
    try {
      await requireAuth(req, ["ADMIN", "HELPER", "ORDERS"]);
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
        { _id: orderObjectId, ...getTodayOrdersQuery(dayKey) },
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
        .find(getTodayOrdersQuery(dayKey))
        .sort({ createdAt: 1 })
        .toArray();

      return res.status(200).json(buildDeliveriesSnapshot(settingsDoc || {}, menuDoc || {}, orders));
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({ ok: false, message: error.message });
      }
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
