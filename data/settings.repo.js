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

// Whitelisted columns the admin UI can update. Anything else is rejected.
const UPDATABLE_FIELDS = [
  "max_meals",
  "sales_start",
  "sales_end",
  "delivery_window",
  "disable_sales_window",
  "message",
  "cutoff_time"
];

export async function updateSettings(cafeteriaId, patch) {
  const clean = {};
  for (const key of UPDATABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
  }
  if (Object.keys(clean).length === 0) {
    throw { status: 400, message: "No hay campos válidos para actualizar." };
  }
  const { data, error } = await supabase
    .from("settings")
    .update(clean)
    .eq("cafeteria_id", cafeteriaId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

// Minimal projection for the deliveries snapshot builder.
export async function getDeliveryWindowConfig(cafeteriaId) {
  const { data, error } = await supabase
    .from("settings")
    .select("sales_start, sales_end, delivery_window, cutoff_time")
    .eq("cafeteria_id", cafeteriaId)
    .single();
  if (error) throw error;
  return data || {};
}
