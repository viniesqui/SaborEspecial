import { randomUUID }                                        from "crypto";
import { handleOptions, setCors }                            from "../lib/http.js";
import { getDayKey, buildDashboardSnapshot, parseBoolean, isSalesOpenNow } from "../lib/dashboard.js";
import { findBySlug }                                        from "../data/cafeterias.repo.js";
import { findActive as findActiveMenu }                      from "../data/menus.repo.js";
import { createAtomic, findToday, getStats }                 from "../data/orders.repo.js";
import { getSettings }                                       from "../data/settings.repo.js";
import { sendOrderStatusEmail }                              from "../lib/email.js";

function validateOrder(order) {
  if (!order.buyerName || !order.paymentMethod) {
    throw new Error("Faltan datos obligatorios.");
  }
  if (!["SINPE", "EFECTIVO"].includes(String(order.paymentMethod).toUpperCase())) {
    throw new Error("Método de pago inválido.");
  }
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  // Multi-tenant: slug comes from query string or request body.
  const slug = String(req.query?.slug || req.body?.slug || "").toLowerCase().trim();
  if (!slug) {
    return res.status(400).json({ ok: false, message: "Parámetro 'slug' requerido." });
  }

  try {
    const cafeteria = await findBySlug(slug);
    if (!cafeteria) {
      return res.status(404).json({ ok: false, message: "Cafetería no encontrada." });
    }

    const { id: cafeteriaId } = cafeteria;
    const dayKey = getDayKey();
    const order  = req.body?.order || {};

    validateOrder(order);

    const [settings, menu] = await Promise.all([
      getSettings(cafeteriaId),
      findActiveMenu(cafeteriaId, dayKey)
    ]);

    // Enforce sales time window (skipped when disable_sales_window is set).
    if (!parseBoolean(settings.disable_sales_window) && !isSalesOpenNow(settings)) {
      return res.status(400).json({ ok: false, message: "La venta de almuerzos está cerrada." });
    }

    const trackingToken = randomUUID();
    const buyerEmail    = String(order.buyerEmail || "").trim().toLowerCase();

    // Atomic insert — capacity check and INSERT happen in a single PostgreSQL
    // transaction, eliminating the race condition from the old check-then-insert.
    const result = await createAtomic({
      cafeteriaId,
      dayKey,
      buyerName:       String(order.buyerName || "").trim(),
      buyerEmail,
      menuId:          menu?.id          || null,
      menuTitle:       menu?.title       || "Menu no configurado",
      menuDescription: menu?.description || "",
      menuPrice:       Number(menu?.price || 1000),
      paymentMethod:   String(order.paymentMethod).toUpperCase(),
      trackingToken
    });

    if (!result?.ok) {
      const msg = result?.error === "CAPACITY_EXCEEDED"
        ? "Ya no hay almuerzos disponibles para hoy."
        : "No se pudo registrar la compra.";
      return res.status(400).json({ ok: false, message: msg });
    }

    const appBaseUrl  = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
    const trackingUrl = appBaseUrl ? `${appBaseUrl}/track.html?token=${trackingToken}` : "";

    if (buyerEmail) {
      sendOrderStatusEmail({
        to:          buyerEmail,
        buyerName:   String(order.buyerName || "").trim(),
        orderId:     result.order_id,
        status:      "SOLICITADO",
        trackingUrl
      }).catch(() => null);
    }

    const [freshOrders, freshStats] = await Promise.all([
      findToday(cafeteriaId, dayKey),
      getStats(cafeteriaId, dayKey)
    ]);

    return res.status(200).json({
      ok:            true,
      message:       "Compra registrada correctamente.",
      trackingToken,
      snapshot:      buildDashboardSnapshot(settings, menu || {}, freshOrders, freshStats)
    });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message || "No se pudo registrar la compra." });
  }
}
