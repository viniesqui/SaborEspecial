import { supabase } from "../lib/supabase.js";

const PAID_STATUSES    = ["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"];
const ACTIVE_FILTER    = "record_status";
const ACTIVE_VALUE     = "CANCELADO";

// Returns aggregated stats for the day via the get_day_stats SQL function.
// Replaces all JavaScript filter()/reduce() aggregations.
export async function getStats(cafeteriaId, dayKey) {
  const { data, error } = await supabase.rpc("get_day_stats", {
    p_cafeteria_id: cafeteriaId,
    p_day_key:      dayKey
  });

  if (error) throw error;
  const row = (data && data[0]) || {};
  return {
    totalOrders:        Number(row.total_orders          || 0),
    paidOrders:         Number(row.paid_orders           || 0),
    pendingPayment:     Number(row.pending_payment       || 0),
    deliveredOrders:    Number(row.delivered_orders      || 0),
    pendingDeliveries:  Number(row.pending_deliveries    || 0),
    paidPendingDelivery:Number(row.paid_pending_delivery || 0),
    sinpeCount:         Number(row.sinpe_count           || 0),
    cashCount:          Number(row.cash_count            || 0),
    totalAmount:        Number(row.total_amount          || 0)
  };
}

// Returns individual order rows for list rendering.
// Only columns actually consumed by the snapshot builders are selected.
export async function findToday(cafeteriaId, dayKey) {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, buyer_name, buyer_email, payment_method, payment_status, " +
      "delivery_status, order_status, created_at, " +
      "payment_confirmed_at, delivered_at, menu_price, menu_title, tracking_token"
    )
    .eq("cafeteria_id", cafeteriaId)
    .eq("day_key", dayKey)
    .neq(ACTIVE_FILTER, ACTIVE_VALUE)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

// Returns full order rows for the admin payment-management panel.
export async function findTodayForAdmin(cafeteriaId, dayKey) {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, buyer_name, buyer_phone, payment_method, payment_status, " +
      "payment_reference, created_at, payment_confirmed_at"
    )
    .eq("cafeteria_id", cafeteriaId)
    .eq("day_key", dayKey)
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
      "order_status, delivery_status, record_status, created_at, " +
      "payment_confirmed_at, delivered_at, day_key"
    )
    .eq("cafeteria_id", cafeteriaId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

// Fetches a single order row for mutation validation.
export async function findById(orderId, cafeteriaId, dayKey) {
  const { data, error } = await supabase
    .from("orders")
    .select("id, cafeteria_id, day_key, buyer_name, buyer_email, payment_status, delivery_status, tracking_token")
    .eq("id", orderId)
    .eq("cafeteria_id", cafeteriaId)
    .eq("day_key", dayKey)
    .neq(ACTIVE_FILTER, ACTIVE_VALUE)
    .single();

  if (error) throw error;
  return data;
}

// Advances the delivery workflow for one order.
// Sets the matching timestamp column so the buyer tracking page can show precise times.
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
// verifiedByUserId is stored for accounting: who confirmed the SINPE transfer and when.
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
export async function logDeliveryEvent(cafeteriaId, orderId, dayKey, deliveryStatus) {
  const { error } = await supabase
    .from("delivery_events")
    .insert({ cafeteria_id: cafeteriaId, order_id: orderId, day_key: dayKey, delivery_status: deliveryStatus });

  if (error) throw error;
}

// Atomic order creation — delegates to the PostgreSQL RPC to prevent overselling.
export async function createAtomic({
  cafeteriaId, dayKey, buyerName, buyerEmail,
  menuId, menuTitle, menuDescription, menuPrice,
  paymentMethod, trackingToken
}) {
  const { data, error } = await supabase.rpc("create_order_atomic", {
    p_cafeteria_id:     cafeteriaId,
    p_day_key:          dayKey,
    p_buyer_name:       buyerName,
    p_buyer_email:      buyerEmail,
    p_menu_id:          menuId || null,
    p_menu_title:       menuTitle,
    p_menu_description: menuDescription,
    p_menu_price:       menuPrice,
    p_payment_method:   String(paymentMethod).toUpperCase(),
    p_tracking_token:   trackingToken
  });

  if (error) throw error;
  return data; // { ok, order_id } or { ok: false, error: 'CAPACITY_EXCEEDED' }
}
