import { supabase } from "../lib/supabase.js";

// Returns the cafeteria record for a given URL slug, or null if not found.
export async function findBySlug(slug) {
  const { data, error } = await supabase
    .from("cafeterias")
    .select("id, name, slug, timezone")
    .eq("slug", String(slug || "").toLowerCase().trim())
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data;
}
