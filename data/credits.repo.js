import { supabase } from "../lib/supabase.js";

export async function getBalance(cafeteriaId, userEmail) {
  const { data, error } = await supabase.rpc("get_credit_balance", {
    p_cafeteria_id: cafeteriaId,
    p_user_email:   userEmail.toLowerCase().trim()
  });

  if (error) throw error;
  return Number(data ?? 0);
}

export async function addCredits(cafeteriaId, userEmail, credits) {
  const { error } = await supabase.rpc("add_credits", {
    p_cafeteria_id: cafeteriaId,
    p_user_email:   userEmail.toLowerCase().trim(),
    p_credits:      Number(credits)
  });

  if (error) throw error;
}

export async function createCreditOrder({
  cafeteriaId, dayKey, targetDate,
  buyerName, buyerEmail,
  menuId, menuTitle, menuDescription, menuPrice,
  trackingToken
}) {
  const { data, error } = await supabase.rpc("create_credit_order_atomic", {
    p_cafeteria_id:     cafeteriaId,
    p_day_key:          dayKey,
    p_target_date:      targetDate || dayKey,
    p_buyer_name:       buyerName,
    p_buyer_email:      buyerEmail,
    p_menu_id:          menuId   || null,
    p_menu_title:       menuTitle,
    p_menu_description: menuDescription,
    p_menu_price:       menuPrice,
    p_tracking_token:   trackingToken
  });

  if (error) throw error;
  return data; // { ok, order_id } or { ok: false, error: 'NO_CREDITS'|'CAPACITY_EXCEEDED' }
}
