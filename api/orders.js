import { randomUUID }                                           from "crypto";
import { handleOptions, setCors }                               from "../lib/http.js";
import { getDayKey, isCutoffPassedForDate, buildDashboardSnapshot } from "../lib/dashboard.js";
import { findBySlug }                                           from "../data/cafeterias.repo.js";
import { findActive as findActiveMenu }                         from "../data/menus.repo.js";
import { createAtomic, findToday, getStats }                    from "../data/orders.repo.js";
import { createCreditOrder }                                    from "../data/credits.repo.js";
import { getSettings }                                         from "../data/settings.repo.js";
import { sendOrderStatusEmail }                                 from "../lib/email.js";
import { requireAuth }                                          from "../lib/auth.js";

function validateOrder(order) {
  if (!order.buyerName || !order.paymentMethod) {
    throw new Error("Faltan datos obligatorios.");
  }
  const method = String(order.paymentMethod).toUpperCase();
  if (!["SINPE", "EFECTIVO", "CREDITO"].includes(method)) {
    throw new Error("Método de pago inválido.");
  }
  if (method === "CREDITO" && !String(order.buyerEmail || "").trim()) {
    throw new Error("El correo electrónico es obligatorio para pagar con crédito.");
  }
}

function validateTargetDate(targetDate, todayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error("Fecha de pedido inválida.");
  }
  if (targetDate < todayKey) {
    throw new Error("No se pueden registrar pedidos para fechas pasadas.");
  }
  // Cap at 7 days ahead to prevent arbitrarily far future bookings.
  const maxDate = new Date(Date.now() - 6 * 60 * 60 * 1000 + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (targetDate > maxDate) {
    throw new Error("Solo se pueden registrar pedidos con hasta 7 días de anticipación.");
  }
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  // Detect staff requests by the presence of a Bearer token.
  // Staff orders are walk-in POS sales; customer orders are public (slug-based).
  const authHeader     = String(req.headers?.authorization || "");
  const isStaffRequest = authHeader.startsWith("Bearer ");

  if (isStaffRequest) {
    return handleStaffOrder(req, res);
  }
  return handleCustomerOrder(req, res);
}

// ── Staff (walk-in POS) path ──────────────────────────────────────────────────
// Auth is required; cafeteriaId comes from the JWT session.
// Cutoff is bypassed: staff can record a walk-in sale at any time.
// Email notification is skipped: walk-in customers have no email.

async function handleStaffOrder(req, res) {
  try {
    const { cafeteriaId } = await requireAuth(req, ["ADMIN", "HELPER"]);

    const dayKey = getDayKey();
    const order  = req.body?.order || {};

    if (!order.paymentMethod) {
      return res.status(400).json({ ok: false, message: "Método de pago requerido." });
    }
    if (!["SINPE", "EFECTIVO"].includes(String(order.paymentMethod).toUpperCase())) {
      return res.status(400).json({ ok: false, message: "Método de pago inválido." });
    }

    // Walk-in orders are always for today; no future pre-ordering via POS.
    const targetDate = dayKey;

    const [settings, menu] = await Promise.all([
      getSettings(cafeteriaId),
      findActiveMenu(cafeteriaId, targetDate)
    ]);

    if (!menu) {
      return res.status(400).json({
        ok: false,
        message: "No hay menú configurado para hoy."
      });
    }

    const trackingToken = randomUUID();
    const buyerName     = String(order.buyerName || "").trim() || "Cliente";

    const result = await createAtomic({
      cafeteriaId,
      dayKey,
      targetDate,
      buyerName,
      buyerEmail:      "",
      menuId:          menu.id,
      menuTitle:       menu.title,
      menuDescription: menu.description,
      menuPrice:       Number(menu.price),
      paymentMethod:   String(order.paymentMethod).toUpperCase(),
      trackingToken,
      orderChannel:    "WALK_IN",
      createdByStaff:  true
    });

    if (!result?.ok) {
      const msg = result?.error === "CAPACITY_EXCEEDED"
        ? "Ya no hay almuerzos disponibles para hoy."
        : "No se pudo registrar la venta.";
      return res.status(400).json({ ok: false, message: msg });
    }

    const [freshOrders, freshStats] = await Promise.all([
      findToday(cafeteriaId, targetDate),
      getStats(cafeteriaId, targetDate)
    ]);

    return res.status(200).json({
      ok:           true,
      message:      "Venta manual registrada correctamente.",
      trackingToken,
      targetDate,
      snapshot:     buildDashboardSnapshot(settings, menu, freshOrders, freshStats)
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, message: error.message });
    }
    return res.status(400).json({ ok: false, message: error.message || "No se pudo registrar la venta." });
  }
}

// ── Customer (digital web) path ───────────────────────────────────────────────
// Public endpoint — no auth required. Identifies the cafeteria by slug.

async function handleCustomerOrder(req, res) {
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

    // targetDate: the day the lunch is ordered FOR.
    // Defaults to today when omitted (backward-compat with old clients).
    const targetDate = String(order.targetDate || dayKey).trim();
    validateTargetDate(targetDate, dayKey);

    const [settings, menu] = await Promise.all([
      getSettings(cafeteriaId),
      findActiveMenu(cafeteriaId, targetDate)
    ]);

    if (!menu) {
      return res.status(400).json({
        ok: false,
        message: "No hay menú disponible para la fecha seleccionada."
      });
    }

    // ── Dynamic cutoff enforcement (server-side) ──────────────────────
    // - Today: blocked once current CR time >= cutoff_time.
    // - Future date: always open; only capacity check applies.
    // This runs on the server so it cannot be bypassed by UI manipulation.
    if (isCutoffPassedForDate(settings, targetDate)) {
      const cutoff = String(settings.cutoff_time || "09:00").slice(0, 5);
      const msg = targetDate === dayKey
        ? `La ventana de pedidos para hoy ya cerró. El límite es a las ${cutoff}.`
        : "No se pueden aceptar pedidos para fechas pasadas.";
      return res.status(400).json({ ok: false, message: msg });
    }

    const trackingToken = randomUUID();
    const buyerEmail    = String(order.buyerEmail || "").trim().toLowerCase();
    const buyerName     = String(order.buyerName  || "").trim();
    const paymentMethod = String(order.paymentMethod).toUpperCase();

    let result;

    if (paymentMethod === "CREDITO") {
      // Credit redemption — atomic: capacity check + balance decrement + INSERT.
      // Payment is auto-confirmed (pre-paid).
      result = await createCreditOrder({
        cafeteriaId,
        dayKey,
        targetDate,
        buyerName,
        buyerEmail,
        menuId:          menu.id,
        menuTitle:       menu.title,
        menuDescription: menu.description,
        menuPrice:       Number(menu.price),
        trackingToken
      });

      if (!result?.ok) {
        const msg =
          result?.error === "CAPACITY_EXCEEDED" ? "Ya no hay almuerzos disponibles para esa fecha." :
          result?.error === "NO_CREDITS"         ? "No tienes créditos disponibles." :
                                                   "No se pudo registrar la compra.";
        return res.status(400).json({ ok: false, message: msg });
      }
    } else {
      // Standard SINPE / EFECTIVO — atomic capacity check + INSERT.
      result = await createAtomic({
        cafeteriaId,
        dayKey,
        targetDate,
        buyerName,
        buyerEmail,
        menuId:          menu.id,
        menuTitle:       menu.title,
        menuDescription: menu.description,
        menuPrice:       Number(menu.price),
        paymentMethod,
        trackingToken,
        orderChannel:    "DIGITAL",
        createdByStaff:  false
      });

      if (!result?.ok) {
        const msg = result?.error === "CAPACITY_EXCEEDED"
          ? "Ya no hay almuerzos disponibles para esa fecha."
          : "No se pudo registrar la compra.";
        return res.status(400).json({ ok: false, message: msg });
      }
    }

    const appBaseUrl  = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
    const trackingUrl = appBaseUrl ? `${appBaseUrl}/track.html?token=${trackingToken}` : "";

    if (buyerEmail) {
      sendOrderStatusEmail({
        to:          buyerEmail,
        buyerName,
        orderId:     result.order_id,
        status:      paymentMethod === "CREDITO" ? "CONFIRMADO" : "SOLICITADO",
        trackingUrl
      }).catch(() => null);
    }

    const [freshOrders, freshStats] = await Promise.all([
      findToday(cafeteriaId, targetDate),
      getStats(cafeteriaId, targetDate)
    ]);

    const message = paymentMethod === "CREDITO"
      ? "Crédito canjeado correctamente. ¡Tu almuerzo está confirmado!"
      : "Compra registrada correctamente.";

    return res.status(200).json({
      ok:           true,
      message,
      trackingToken,
      targetDate,
      snapshot:     buildDashboardSnapshot(settings, menu, freshOrders, freshStats)
    });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message || "No se pudo registrar la compra." });
  }
}
