import { supabase } from "../lib/supabase.js";

// Returns the active menu for today, or null if none exists.
export async function findActive(cafeteriaId, dayKey) {
  const { data, error } = await supabase
    .from("menus")
    .select("id, title, description, price")
    .eq("cafeteria_id", cafeteriaId)
    .eq("day_key", dayKey)
    .eq("active", true)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// Creates or replaces today's menu. Uses the unique (cafeteria_id, day_key) constraint.
export async function upsert(cafeteriaId, dayKey, { title, description, price }) {
  const { data, error } = await supabase
    .from("menus")
    .upsert(
      {
        cafeteria_id: cafeteriaId,
        day_key:      dayKey,
        title:        String(title).trim(),
        description:  String(description).trim(),
        price:        Number(price),
        active:       true
      },
      { onConflict: "cafeteria_id,day_key" }
    )
    .select("id, title, description, price")
    .single();

  if (error) throw error;
  return data;
}
