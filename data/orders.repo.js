import { supabase } from "../lib/supabase.js";

const PAID_STATUSES = ["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"];
const ACTIVE_FILTER = "record_status";
const ACTIVE_VALUE  = "CANCELADO";

// Returns aggregated stats for a given target date via the get_day_stats SQL function.
export async function getStats(cafeteriaId, targetDate) {
  const { data, error } = await supabase.rpc("get_day_stats", {
    p_cafeteria_id: cafeteriaId,
    p_day_key:      targetDate
  });

  if (error) throw error;
  const row = (data && data[0]) || {};
  return {
    totalOrders:         Number(row.total_orders          || 0),
    paidOrders:          Number(row.paid_orders           || 0),
    pendingPayment:      Number(row.pending_payment       || 0),
    deliveredOrders:     Number(row.delivered_orders      || 0),
    pendingDeliveries:   Number(row.pending_deliveries    || 0),
    paidPendingDelivery: Number(row.paid_pending_delivery || 0),
    sinpeCount:          Number(row.sinpe_count           || 0),
    cashCount:           Number(row.cash_count            || 0),
    totalAmount:         Number(row.total_amount          || 0),
    digitalCount:        Number(row.digital_count         || 0),
    walkInCount:         Number(row.walk_in_count         || 0)
  };
}

// Returns individual order rows for a given target_date.
// Filters by target_date so pre-orders placed on earlier days appear
// in the correct day's list.
export async function findToday(cafeteriaId, targetDate) {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, buyer_name, buyer_email, payment_method, payment_status, " +
      "delivery_status, order_status, created_at, target_date, " +
      "payment_confirmed_at, delivered_at, menu_price, menu_title, tracking_token, " +
      "order_channel, created_by_staff"
    )
    .eq("cafeteria_id", cafeteriaId)
    .eq("target_date", targetDate)
    .neq(ACTIVE_FILTER, ACTIVE_VALUE)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

// Returns full order rows for the admin payment-management panel.
// Includes sale_type and package_id so the panel can handle package
// payment confirmations (which trigger credit grants) differently.
export async function findTodayForAdmin(cafeteriaId, targetDate) {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, buyer_name, buyer_email, buyer_phone, payment_method, payment_status, " +
      "payment_reference, created_at, payment_confirmed_at, order_channel, " +
      "sale_type, package_id"
    )
    .eq("cafeteria_id", cafeteriaId)
    .eq("target_date", targetDate)
    .neq(ACTIVE_FILTER, ACTIVE_VALUE)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

// Returns all orders for a cafeteria (used by CSV export).
export async function findAll(cafeteriaId) {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, buyer_name, buyer_phone, buyer_email, payment_method, payment_status, " +
      "payment_reference, menu_title, menu_description, menu_price, " +
      "order_status, delivery_status, record_status, created_at, target_date, " +
      "payment_confirmed_at, delivered_at, day_key, order_channel, created_by_staff"
    )
    .eq("cafeteria_id", cafeteriaId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

// Fetches a single order for mutation validation.
// Scoped to cafeteria_id only — no day restriction since staff may update
// orders placed on a different day than the one being served.
export async function findById(orderId, cafeteriaId) {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, cafeteria_id, day_key, target_date, buyer_name, buyer_email, " +
      "payment_status, delivery_status, tracking_token"
    )
    .eq("id", orderId)
    .eq("cafeteria_id", cafeteriaId)
    .neq(ACTIVE_FILTER, ACTIVE_VALUE)
    .single();

  if (error) throw error;
  return data;
}

// Advances the delivery workflow for one order.
export async function updateDelivery(orderId, cafeteriaId, deliveryStatus) {
  const now    = new Date().toISOString();
  const update = { delivery_status: deliveryStatus };
  if (deliveryStatus === "EN_PREPARACION")     update.prepared_at  = now;
  if (deliveryStatus === "LISTO_PARA_ENTREGA") update.ready_at     = now;
  if (deliveryStatus === "ENTREGADO")          update.delivered_at = now;

  const { error } = await supabase
    .from("orders")
    .update(update)
    .eq("id", orderId)
    .eq("cafeteria_id", cafeteriaId);

  if (error) throw error;
}

// Updates payment status. Only ADMIN may call this (enforced at the API layer).
export async function updatePayment(orderId, cafeteriaId, paymentStatus, verifiedByUserId = null) {
  const isConfirming = PAID_STATUSES.includes(paymentStatus);
  const update = {
    payment_status:       paymentStatus,
    payment_confirmed_at: isConfirming ? new Date().toISOString() : null
  };
  if (isConfirming && verifiedByUserId) update.payment_verified_by = verifiedByUserId;

  const { error } = await supabase
    .from("orders")
    .update(update)
    .eq("id", orderId)
    .eq("cafeteria_id", cafeteriaId);

  if (error) throw error;
}

// Appends an entry to the delivery audit log.
export async function logDeliveryEvent(cafeteriaId, orderId, targetDate, deliveryStatus) {
  const { error } = await supabase
    .from("delivery_events")
    .insert({
      cafeteria_id:    cafeteriaId,
      order_id:        orderId,
      day_key:         targetDate,
      delivery_status: deliveryStatus
    });

  if (error) throw error;
}

// Atomic order creation — delegates to the PostgreSQL RPC to prevent overselling.
// targetDate is the date the lunch is ordered FOR (may differ from dayKey/today).
// orderChannel distinguishes 'DIGITAL' (web) from 'WALK_IN' (staff POS).
export async function createAtomic({
  cafeteriaId, dayKey, targetDate,
  buyerName, buyerEmail,
  menuId, menuTitle, menuDescription, menuPrice,
  paymentMethod, trackingToken,
  orderChannel = "DIGITAL", createdByStaff = false
}) {
  const { data, error } = await supabase.rpc("create_order_atomic", {
    p_cafeteria_id:     cafeteriaId,
    p_day_key:          dayKey,
    p_target_date:      targetDate || dayKey,
    p_buyer_name:       buyerName,
    p_buyer_email:      buyerEmail,
    p_menu_id:          menuId || null,
    p_menu_title:       menuTitle,
    p_menu_description: menuDescription,
    p_menu_price:       menuPrice,
    p_payment_method:   String(paymentMethod).toUpperCase(),
    p_tracking_token:   trackingToken,
    p_order_channel:    orderChannel,
    p_created_by_staff: createdByStaff
  });

  if (error) throw error;
  return data; // { ok, order_id } or { ok: false, error: 'CAPACITY_EXCEEDED' }
}
