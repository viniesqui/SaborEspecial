import { handleOptions, setCors }                     from "../lib/http.js";
import { getDayKey }                                  from "../lib/dashboard.js";
import { requireAuth }                                from "../lib/auth.js";
import { sendOrderStatusEmail }                       from "../lib/email.js";
import { supabase }                                   from "../lib/supabase.js";
import { findTodayForAdmin, updatePayment, getStats } from "../data/orders.repo.js";
import { addCredits }                                 from "../data/credits.repo.js";
import { CANONICAL_PAID, toCanonicalPayment }         from "../lib/payment-status.js";

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-CR", {
    timeZone: "America/Costa_Rica",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(new Date(value));
}

function buildSnapshot(orders, stats) {
  return {
    ok:                  true,
    updatedAt:           new Date().toISOString(),
    totalOrders:         stats.totalOrders,
    paidCount:           stats.paidOrders,
    pendingPaymentCount: stats.pendingPayment,
    digitalCount:        stats.digitalCount || 0,
    walkInCount:         stats.walkInCount  || 0,
    orders: orders.map((o) => ({
      id:                      o.id,
      buyerName:               o.buyer_name        || "Sin nombre",
      buyerEmail:              o.buyer_email        || "",
      buyerPhone:              o.buyer_phone        || "",
      paymentMethod:           o.payment_method     || "",
      paymentStatus:           toCanonicalPayment(o.payment_status),
      paymentReference:        o.payment_reference  || "",
      orderChannel:            o.order_channel      || "DIGITAL",
      saleType:                o.sale_type          || "SINGLE_SALE",
      packageId:               o.package_id         || null,
      createdAtLabel:          formatDateTime(o.created_at),
      paymentConfirmedAtLabel: formatDateTime(o.payment_confirmed_at)
    }))
  };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const { cafeteriaId, userId } = await requireAuth(req, ["ADMIN"]);
    const action          = String(req.body?.action || "list");
    const dayKey          = getDayKey();

    if (action === "analytics") {
      const todayDow = new Date(Date.now() - 6 * 60 * 60 * 1000).getUTCDay();
      const [prepResult, forecastResult, heatmapResult, weeklyResult] = await Promise.all([
        supabase.from("v_daily_prep_list").select("*").eq("cafeteria_id", cafeteriaId).eq("day_key", dayKey),
        supabase.from("v_demand_forecast").select("*").eq("cafeteria_id", cafeteriaId),
        supabase.from("v_peak_hour_heatmap").select("*").eq("cafeteria_id", cafeteriaId).order("hour_of_day", { ascending: true }),
        supabase.from("v_weekly_summary").select("*").eq("cafeteria_id", cafeteriaId).order("week_start", { ascending: false }).limit(8)
      ]);
      const forecast      = forecastResult.data || [];
      const todayForecast = forecast.find((f) => Number(f.day_of_week) === todayDow) || null;
      return res.status(200).json({
        ok: true, updatedAt: new Date().toISOString(),
        prep: prepResult.data || [], forecast, todayForecast,
        heatmap: heatmapResult.data || [], weekly: weeklyResult.data || []
      });
    }

    if (action === "list") {
      const [orders, stats] = await Promise.all([
        findTodayForAdmin(cafeteriaId, dayKey),
        getStats(cafeteriaId, dayKey)
      ]);
      return res.status(200).json(buildSnapshot(orders, stats));
    }

    if (action === "updatePaymentStatus") {
      const orderId       = String(req.body?.orderId      || "");
      const paymentStatus = toCanonicalPayment(req.body?.paymentStatus);

      if (!orderId) {
        return res.status(400).json({ ok: false, message: "Pedido inválido." });
      }

      // userId is stored for accounting: which admin confirmed the SINPE transfer.
      await updatePayment(orderId, cafeteriaId, paymentStatus, userId);

      if (paymentStatus === CANONICAL_PAID) {
        const { data: row } = await supabase
          .from("orders")
          .select("buyer_name, buyer_email, tracking_token, sale_type, package_id")
          .eq("id", orderId)
          .maybeSingle();

        // If this is a PACKAGE_SALE, grant the purchased credits to the buyer.
        if (row?.sale_type === "PACKAGE_SALE" && row?.package_id && row?.buyer_email) {
          const { data: pkg } = await supabase
            .from("packages")
            .select("meal_count")
            .eq("id", row.package_id)
            .maybeSingle();

          if (pkg?.meal_count) {
            await addCredits(cafeteriaId, row.buyer_email, pkg.meal_count).catch(() => null);
          }
        }

        if (row?.buyer_email) {
          const appBaseUrl  = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
          const trackingUrl = appBaseUrl && row.tracking_token
            ? `${appBaseUrl}/track.html?token=${row.tracking_token}`
            : "";
          sendOrderStatusEmail({
            to:         row.buyer_email,
            buyerName:  row.buyer_name,
            orderId,
            status:     paymentStatus,
            trackingUrl
          }).catch(() => null);
        }
      }

      const [orders, stats] = await Promise.all([
        findTodayForAdmin(cafeteriaId, dayKey),
        getStats(cafeteriaId, dayKey)
      ]);
      return res.status(200).json(buildSnapshot(orders, stats));
    }

    return res.status(400).json({ ok: false, message: "Acción no soportada." });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, message: error.message });
    }
    return res.status(500).json({ ok: false, message: error.message || "No fue posible consultar los pedidos." });
  }
}
