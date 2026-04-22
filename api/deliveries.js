import { supabase } from "../lib/supabase.js";
import { getDayKey } from "../lib/dashboard.js";
import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";
import { sendOrderStatusEmail } from "../lib/email.js";

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

function getPaymentStatusLabel(paymentStatus) {
  const normalized = String(paymentStatus || "").toUpperCase();
  if (["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"].includes(normalized)) return "PAGADO";
  return "PENDIENTE DE PAGO";
}

function buildDeliveriesSnapshot(settings, menu, orders) {
  const totalOrders = orders.length;
  const paidOrders = orders.filter((o) => getPaymentStatusLabel(o.payment_status) === "PAGADO").length;
  const pendingPaymentCount = Math.max(totalOrders - paidOrders, 0);
  const deliveredOrders = orders.filter((o) => o.delivery_status === "ENTREGADO").length;
  const pendingDeliveries = Math.max(totalOrders - deliveredOrders, 0);
  const paidPendingDeliveryCount = orders.filter(
    (o) => getPaymentStatusLabel(o.payment_status) === "PAGADO" && o.delivery_status !== "ENTREGADO"
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
    salesWindow: `${settings?.sales_start || "10:00"} - ${settings?.sales_end || "12:00"}`,
    deliveryWindow: settings?.delivery_window || "12:00 - 12:30",
    menu: {
      title: menu?.title || "Menu no configurado",
      description: menu?.description || "",
      price: Number(menu?.price || 1000)
    },
    orders: orders.map((o) => ({
      id: o.id,
      buyerName: o.buyer_name,
      paymentMethod: o.payment_method,
      paymentStatus: getPaymentStatusLabel(o.payment_status),
      orderStatus: o.order_status || "SOLICITADO",
      deliveryStatus: o.delivery_status || "PENDIENTE_ENTREGA",
      timestampLabel: formatTimestamp(o.created_at),
      createdAtLabel: formatTimestamp(o.created_at),
      paymentConfirmedAtLabel: o.payment_confirmed_at ? formatTimestamp(o.payment_confirmed_at) : "",
      deliveredAtLabel: o.delivered_at ? formatTimestamp(o.delivered_at) : ""
    }))
  };
}

async function fetchTodayData(cafeteriaId, dayKey) {
  const [{ data: settings }, { data: menu }, { data: orders }] = await Promise.all([
    supabase.from("settings").select("*").eq("cafeteria_id", cafeteriaId).single(),
    supabase.from("menus").select("*").eq("cafeteria_id", cafeteriaId).eq("day_key", dayKey).eq("active", true).maybeSingle(),
    supabase.from("orders").select("*").eq("cafeteria_id", cafeteriaId).eq("day_key", dayKey).neq("record_status", "CANCELADO").order("created_at", { ascending: true })
  ]);

  return { settings: settings || {}, menu: menu || {}, orders: orders || [] };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method === "GET") {
    try {
      const { cafeteriaId } = await requireAuth(req, ["ADMIN", "HELPER", "ORDERS"]);
      const dayKey = getDayKey();
      const { settings, menu, orders } = await fetchTodayData(cafeteriaId, dayKey);
      return res.status(200).json(buildDeliveriesSnapshot(settings, menu, orders));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ ok: false, message: error.message });
      return res.status(500).json({ ok: false, message: error.message || "Unexpected server error." });
    }
  }

  if (req.method === "POST") {
    try {
      const { cafeteriaId } = await requireAuth(req, ["ADMIN", "HELPER", "ORDERS"]);
      const dayKey = getDayKey();
      const orderId = String(req.body?.orderId || "");
      const deliveryStatus = req.body?.deliveryStatus ? String(req.body.deliveryStatus) : null;
      const paymentStatus = req.body?.paymentStatus ? String(req.body.paymentStatus) : null;

      if (!orderId) {
        return res.status(400).json({ ok: false, message: "Pedido inválido." });
      }

      if (!deliveryStatus && !paymentStatus) {
        return res.status(400).json({ ok: false, message: "Debe especificar deliveryStatus o paymentStatus." });
      }

      // Fetch the order to validate it belongs to this cafeteria and get buyer email.
      const { data: order, error: fetchError } = await supabase
        .from("orders")
        .select("id, cafeteria_id, day_key, buyer_name, buyer_email, payment_status, delivery_status")
        .eq("id", orderId)
        .eq("cafeteria_id", cafeteriaId)
        .eq("day_key", dayKey)
        .neq("record_status", "CANCELADO")
        .single();

      if (fetchError || !order) {
        return res.status(404).json({ ok: false, message: "Pedido no encontrado." });
      }

      let emailStatus = null;

      // --- Handle delivery status update ---
      if (deliveryStatus) {
        if (!["PENDIENTE_ENTREGA", "ENTREGADO"].includes(deliveryStatus)) {
          return res.status(400).json({ ok: false, message: "Estado de entrega inválido." });
        }

        const { error: updateError } = await supabase
          .from("orders")
          .update({
            delivery_status: deliveryStatus,
            delivered_at: deliveryStatus === "ENTREGADO" ? new Date().toISOString() : null
          })
          .eq("id", orderId);

        if (updateError) throw updateError;

        await supabase.from("delivery_events").insert({
          cafeteria_id: cafeteriaId,
          order_id: orderId,
          day_key: dayKey,
          delivery_status: deliveryStatus
        });

        if (deliveryStatus === "ENTREGADO" && order.buyer_email) {
          emailStatus = await sendOrderStatusEmail({
            to: order.buyer_email,
            buyerName: order.buyer_name,
            orderId: order.id,
            status: "ENTREGADO"
          });
        }
      }

      // --- Handle payment status update ---
      if (paymentStatus) {
        if (!["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE", "PENDIENTE_DE_PAGO"].includes(paymentStatus)) {
          return res.status(400).json({ ok: false, message: "Estado de pago inválido." });
        }

        const isConfirming = ["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"].includes(paymentStatus);

        const { error: updateError } = await supabase
          .from("orders")
          .update({
            payment_status: paymentStatus,
            payment_confirmed_at: isConfirming ? new Date().toISOString() : null
          })
          .eq("id", orderId);

        if (updateError) throw updateError;

        if (isConfirming && order.buyer_email) {
          emailStatus = await sendOrderStatusEmail({
            to: order.buyer_email,
            buyerName: order.buyer_name,
            orderId: order.id,
            status: paymentStatus
          });
        }
      }

      const { settings, menu, orders } = await fetchTodayData(cafeteriaId, dayKey);
      const snapshot = buildDeliveriesSnapshot(settings, menu, orders);

      if (emailStatus && !emailStatus.sent) {
        snapshot.emailWarning = "La actualización fue guardada, pero no se pudo enviar el correo al comprador.";
      }

      return res.status(200).json(snapshot);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ ok: false, message: error.message });
      return res.status(500).json({ ok: false, message: error.message || "Unexpected server error." });
    }
  }

  return res.status(405).json({ ok: false, message: "Method not allowed" });
}
