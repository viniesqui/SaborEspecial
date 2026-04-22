import { supabase } from "../lib/supabase.js";
import { buildDashboardSnapshot, getDayKey } from "../lib/dashboard.js";
import { handleOptions, setCors } from "../lib/http.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const cafeteriaId = process.env.CAFETERIA_ID;
  if (!cafeteriaId) {
    return res.status(500).json({ ok: false, message: "Cafetería no configurada." });
  }

  try {
    const dayKey = getDayKey();

    const [{ data: settings }, { data: menu }, { data: orders }] = await Promise.all([
      supabase.from("settings").select("*").eq("cafeteria_id", cafeteriaId).single(),
      supabase.from("menus").select("*").eq("cafeteria_id", cafeteriaId).eq("day_key", dayKey).eq("active", true).maybeSingle(),
      supabase.from("orders").select("*").eq("cafeteria_id", cafeteriaId).eq("day_key", dayKey).neq("record_status", "CANCELADO").order("created_at", { ascending: true })
    ]);

    return res.status(200).json(buildDashboardSnapshot(settings || {}, menu || {}, orders || []));
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || "Unexpected server error."
    });
  }
}
