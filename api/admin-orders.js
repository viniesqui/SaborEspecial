import { ObjectId } from "mongodb";
import { getDb } from "../lib/mongodb.js";
import { getDayKey, getTodayOrdersQuery } from "../lib/dashboard.js";
import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";

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

function getPaymentStatusLabel(paymentStatus) {
  const normalized = String(paymentStatus || "").toUpperCase();
  if (["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"].includes(normalized)) {
    return "PAGADO";
  }
  return "PENDIENTE_DE_PAGO";
}

function buildAdminOrdersSnapshot(orders) {
  const normalizedOrders = orders.map((item) => {
    const paymentStatus = getPaymentStatusLabel(item.paymentStatus);

    return {
      id: String(item._id),
      buyerName: item.buyerName || "Sin nombre",
      buyerPhone: item.buyerPhone || "",
      paymentMethod: item.paymentMethod || "",
      paymentStatus,
      paymentReference: item.paymentReference || "",
      createdAtLabel: formatDateTime(item.createdAt),
      paymentConfirmedAtLabel: formatDateTime(item.paymentConfirmedAt)
    };
  });

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    totalOrders: normalizedOrders.length,
    paidCount: normalizedOrders.filter((item) => item.paymentStatus === "PAGADO").length,
    pendingPaymentCount: normalizedOrders.filter((item) => item.paymentStatus !== "PAGADO").length,
    orders: normalizedOrders
  };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    await requireAuth(req, ["ADMIN"]);
    const db = await getDb();
    const action = String(req.body?.action || "list");
    const dayKey = getDayKey();

    if (action === "list") {
      const orders = await db.collection("orders")
        .find(getTodayOrdersQuery(dayKey))
        .sort({ createdAt: 1 })
        .toArray();

      return res.status(200).json(buildAdminOrdersSnapshot(orders));
    }

    if (action === "updatePaymentStatus") {
      const orderId = String(req.body?.orderId || "");
      const paymentStatus = getPaymentStatusLabel(req.body?.paymentStatus);

      if (!ObjectId.isValid(orderId)) {
        return res.status(400).json({ ok: false, message: "Pedido invalido." });
      }

      await db.collection("orders").updateOne(
        { _id: new ObjectId(orderId), ...getTodayOrdersQuery(dayKey) },
        {
          $set: {
            paymentStatus,
            paymentConfirmedAt: paymentStatus === "PAGADO" ? new Date() : null
          }
        }
      );

      const orders = await db.collection("orders")
        .find(getTodayOrdersQuery(dayKey))
        .sort({ createdAt: 1 })
        .toArray();

      return res.status(200).json(buildAdminOrdersSnapshot(orders));
    }

    return res.status(400).json({ ok: false, message: "Accion no soportada." });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, message: error.message });
    }
    return res.status(500).json({
      ok: false,
      message: error.message || "No fue posible consultar los pedidos."
    });
  }
}
