import { supabase } from "../lib/supabase.js";

export async function getSettings(cafeteriaId) {
  const { data, error } = await supabase
    .from("settings")
    .select("*")
    .eq("cafeteria_id", cafeteriaId)
    .single();
  if (error) throw error;
  return data || {};
}

// Minimal projection for the deliveries snapshot builder
// (avoids fetching all columns when only these three are needed).
export async function getDeliveryWindowConfig(cafeteriaId) {
  const { data, error } = await supabase
    .from("settings")
    .select("sales_start, sales_end, delivery_window")
    .eq("cafeteria_id", cafeteriaId)
    .single();
  if (error) throw error;
  return data || {};
}
