import { handleOptions, setCors }                            from "../lib/http.js";
import { getDayKey }                                         from "../lib/dashboard.js";
import { requireAuth }                                       from "../lib/auth.js";
import { sendOrderStatusEmail }                              from "../lib/email.js";
import { findActive as findActiveMenu }                      from "../data/menus.repo.js";
import {
  findToday, getStats, findById,
  updateDelivery, updatePayment, logDeliveryEvent
} from "../data/orders.repo.js";
import { getDeliveryWindowConfig }                           from "../data/settings.repo.js";

// All four stages used by the kitchen workflow.
const VALID_DELIVERY_STATUSES = [
  "PENDIENTE_ENTREGA",
  "EN_PREPARACION",
  "LISTO_PARA_ENTREGA",
  "ENTREGADO"
];

const PAID_STATUSES = ["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE", "PENDIENTE_DE_PAGO"];

function formatTimestamp(value) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("es-CR", {
    timeZone: "America/Costa_Rica",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true
  }).formatToParts(new Date(value));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").replace(/\./g, "").toUpperCase()}`;
}

function normalizePayment(status) {
  const s = String(status || "").toUpperCase();
  if (s === "PAGADO" || s === "CONFIRMADO" || s === "CONFIRMADO_SINPE") return "PAGADO";
  return "PENDIENTE DE PAGO";
}

async function buildSnapshot(cafeteriaId, dayKey) {
  const [s, menu, orders, stats] = await Promise.all([
    getDeliveryWindowConfig(cafeteriaId),
    findActiveMenu(cafeteriaId, dayKey),
    findToday(cafeteriaId, dayKey),
    getStats(cafeteriaId, dayKey)
  ]);

  return {
    ok:                   true,
    updatedAt:            new Date().toISOString(),
    totalOrders:          stats.totalOrders,
    paidOrders:           stats.paidOrders,
    pendingPaymentCount:  stats.pendingPayment,
    deliveredOrders:      stats.deliveredOrders,
    pendingDeliveries:    stats.pendingDeliveries,
    paidPendingDeliveryCount: stats.paidPendingDelivery,
    salesWindow:          `${s.sales_start || "10:00"} - ${s.sales_end || "12:00"}`,
    deliveryWindow:       s.delivery_window || "12:00 - 12:30",
    menu: {
      title:       menu?.title       || "Menu no configurado",
      description: menu?.description || "",
      price:       Number(menu?.price || 1000)
    },
    orders: orders.map((o) => ({
      id:                      o.id,
      buyerName:               o.buyer_name,
      paymentMethod:           o.payment_method,
      paymentStatus:           normalizePayment(o.payment_status),
      orderStatus:             o.order_status    || "SOLICITADO",
      deliveryStatus:          o.delivery_status || "PENDIENTE_ENTREGA",
      timestampLabel:          formatTimestamp(o.created_at),
      createdAtLabel:          formatTimestamp(o.created_at),
      paymentConfirmedAtLabel: o.payment_confirmed_at ? formatTimestamp(o.payment_confirmed_at) : "",
      deliveredAtLabel:        o.delivered_at         ? formatTimestamp(o.delivered_at)          : "",
      // Signals the kitchen UI to surface the manual SINPE verification button.
      needsSinpeVerification:  o.payment_method === "SINPE" &&
        !["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"].includes(String(o.payment_status || "").toUpperCase())
    }))
  };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method === "GET") {
    try {
      const { cafeteriaId } = await requireAuth(req, ["ADMIN", "HELPER", "ORDERS"]);
      return res.status(200).json(await buildSnapshot(cafeteriaId, getDayKey()));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ ok: false, message: err.message });
      return res.status(500).json({ ok: false, message: err.message || "Unexpected server error." });
    }
  }

  if (req.method === "POST") {
    try {
      const { cafeteriaId, userId } = await requireAuth(req, ["ADMIN", "HELPER", "ORDERS"]);
      const dayKey         = getDayKey();
      const orderId        = String(req.body?.orderId        || "");
      const deliveryStatus = req.body?.deliveryStatus ? String(req.body.deliveryStatus) : null;
      const paymentStatus  = req.body?.paymentStatus  ? String(req.body.paymentStatus)  : null;

      if (!orderId) {
        return res.status(400).json({ ok: false, message: "Pedido inválido." });
      }
      if (!deliveryStatus && !paymentStatus) {
        return res.status(400).json({ ok: false, message: "Debe especificar deliveryStatus o paymentStatus." });
      }

      // Verify ownership and get buyer contact for email.
      const order = await findById(orderId, cafeteriaId, dayKey);
      if (!order) {
        return res.status(404).json({ ok: false, message: "Pedido no encontrado." });
      }

      let emailStatus = null;

      const appBaseUrl  = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
      const trackingUrl = appBaseUrl && order.tracking_token
        ? `${appBaseUrl}/track.html?token=${order.tracking_token}`
        : "";

      if (deliveryStatus) {
        if (!VALID_DELIVERY_STATUSES.includes(deliveryStatus)) {
          return res.status(400).json({ ok: false, message: "Estado de entrega inválido." });
        }
        await updateDelivery(orderId, cafeteriaId, deliveryStatus);
        await logDeliveryEvent(cafeteriaId, orderId, dayKey, deliveryStatus);

        // Notify buyer at each visible kitchen milestone, not just on final delivery.
        const NOTIFY_STATUSES = ["EN_PREPARACION", "LISTO_PARA_ENTREGA", "ENTREGADO"];
        if (NOTIFY_STATUSES.includes(deliveryStatus) && order.buyer_email) {
          emailStatus = await sendOrderStatusEmail({
            to:         order.buyer_email,
            buyerName:  order.buyer_name,
            orderId:    order.id,
            status:     deliveryStatus,
            trackingUrl
          });
        }
      }

      if (paymentStatus) {
        if (!PAID_STATUSES.includes(paymentStatus)) {
          return res.status(400).json({ ok: false, message: "Estado de pago inválido." });
        }
        // userId is stored for accounting: which staff member verified the SINPE transfer.
        await updatePayment(orderId, cafeteriaId, paymentStatus, userId);

        const isConfirming = ["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"].includes(paymentStatus);
        if (isConfirming && order.buyer_email) {
          emailStatus = await sendOrderStatusEmail({
            to:         order.buyer_email,
            buyerName:  order.buyer_name,
            orderId:    order.id,
            status:     paymentStatus,
            trackingUrl
          });
        }
      }

      const snapshot = await buildSnapshot(cafeteriaId, dayKey);
      if (emailStatus && !emailStatus.sent) {
        snapshot.emailWarning = "La actualización fue guardada, pero no se pudo enviar el correo al comprador.";
      }

      return res.status(200).json(snapshot);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ ok: false, message: err.message });
      return res.status(500).json({ ok: false, message: err.message || "Unexpected server error." });
    }
  }

  return res.status(405).json({ ok: false, message: "Method not allowed" });
}
