import { supabase } from "../lib/supabase.js";

export async function findActive(cafeteriaId) {
  const { data, error } = await supabase
    .from("packages")
    .select("id, title, meal_count, price")
    .eq("cafeteria_id", cafeteriaId)
    .eq("is_active", true)
    .order("meal_count", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function findById(packageId, cafeteriaId) {
  const { data, error } = await supabase
    .from("packages")
    .select("id, title, meal_count, price, is_active")
    .eq("id", packageId)
    .eq("cafeteria_id", cafeteriaId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function create(cafeteriaId, { title, mealCount, price }) {
  const { data, error } = await supabase
    .from("packages")
    .insert({ cafeteria_id: cafeteriaId, title, meal_count: mealCount, price })
    .select("id, title, meal_count, price, is_active")
    .single();

  if (error) throw error;
  return data;
}

export async function toggle(packageId, cafeteriaId, isActive) {
  const { error } = await supabase
    .from("packages")
    .update({ is_active: isActive })
    .eq("id", packageId)
    .eq("cafeteria_id", cafeteriaId);

  if (error) throw error;
}

export async function createOrder({
  cafeteriaId, dayKey,
  buyerName, buyerEmail,
  packageId, packageTitle, packagePrice,
  paymentMethod, trackingToken
}) {
  const { data, error } = await supabase.rpc("create_package_order", {
    p_cafeteria_id:   cafeteriaId,
    p_day_key:        dayKey,
    p_buyer_name:     buyerName,
    p_buyer_email:    buyerEmail,
    p_package_id:     packageId,
    p_package_title:  packageTitle,
    p_package_price:  packagePrice,
    p_payment_method: String(paymentMethod).toUpperCase(),
    p_tracking_token: trackingToken
  });

  if (error) throw error;
  return data; // { ok, order_id }
}
