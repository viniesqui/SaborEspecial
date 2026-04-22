import { supabase } from "../lib/supabase.js";
import { buildDashboardSnapshot, getDayKey, parseBoolean } from "../lib/dashboard.js";
import { handleOptions, setCors } from "../lib/http.js";

function validateOrder(order) {
  if (!order.buyerName || !order.paymentMethod) {
    throw new Error("Faltan datos obligatorios.");
  }
  if (!["SINPE", "EFECTIVO"].includes(String(order.paymentMethod).toUpperCase())) {
    throw new Error("Método de pago inválido.");
  }
}

function isSalesWindowAllowed(settings, snapshot) {
  if (parseBoolean(settings.disable_sales_window)) return true;
  return snapshot.isSalesOpen;
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

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const cafeteriaId = process.env.CAFETERIA_ID;
  if (!cafeteriaId) {
    return res.status(500).json({ ok: false, message: "Cafetería no configurada." });
  }

  try {
    const dayKey = getDayKey();
    const order = req.body?.order || {};

    validateOrder(order);

    const { settings, menu, orders: existingOrders } = await fetchTodayData(cafeteriaId, dayKey);
    const snapshot = buildDashboardSnapshot(settings, menu, existingOrders);

    if (!isSalesWindowAllowed(settings, snapshot)) {
      return res.status(400).json({ ok: false, message: "La venta de almuerzos está cerrada." });
    }

    if (snapshot.availableMeals <= 0) {
      return res.status(400).json({ ok: false, message: "Ya no hay almuerzos disponibles para hoy." });
    }

    const { error: insertError } = await supabase.from("orders").insert({
      cafeteria_id: cafeteriaId,
      day_key: dayKey,
      buyer_name: String(order.buyerName || "").trim(),
      buyer_email: String(order.buyerEmail || "").trim().toLowerCase(),
      buyer_id: "",
      buyer_phone: "",
      menu_id: menu.id || null,
      menu_title: menu.title || "Menu no configurado",
      menu_description: menu.description || "",
      menu_price: Number(menu.price || 1000),
      payment_method: String(order.paymentMethod).toUpperCase(),
      payment_status: "PENDIENTE_DE_PAGO",
      order_status: "SOLICITADO",
      delivery_status: "PENDIENTE_ENTREGA",
      record_status: "ACTIVO"
    });

    if (insertError) throw insertError;

    const { settings: freshSettings, menu: freshMenu, orders: freshOrders } = await fetchTodayData(cafeteriaId, dayKey);

    return res.status(200).json({
      ok: true,
      message: "Compra registrada correctamente.",
      snapshot: buildDashboardSnapshot(freshSettings, freshMenu, freshOrders)
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message: error.message || "No se pudo registrar la compra."
    });
  }
}
