import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth }           from "../lib/auth.js";
import { supabase }              from "../lib/supabase.js";

// ADMIN and HELPER share the merged management interface.
// ORDERS role keeps its dedicated delivery board.
const ROLE_ROUTE_MAP = {
  ADMIN:  "./management.html",
  HELPER: "./management.html",
  ORDERS: "./deliveries.html"
};

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  // Health-check path — no auth required.
  // Reached via vercel.json rewrite: /api/health → /api/auth-role?health=1
  if (req.query?.health === "1") {
    const checks = {};
    try {
      const t0 = Date.now();
      const { error } = await supabase.from("cafeterias").select("id").limit(1);
      checks.database = error ? { ok: false, error: error.message } : { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) {
      checks.database = { ok: false, error: e.message };
    }
    const resendKey = process.env.RESEND_API_KEY;
    checks.email = { ok: Boolean(resendKey), configured: Boolean(resendKey), from: process.env.RESEND_FROM_EMAIL || null };
    const allOk = Object.values(checks).every((c) => c.ok);
    return res.status(allOk ? 200 : 503).json({ ok: allOk, checks, timestamp: new Date().toISOString() });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const { role, cafeteriaId } = await requireAuth(req, ["ADMIN", "HELPER", "ORDERS"]);
    return res.status(200).json({
      ok:          true,
      role,
      cafeteriaId,
      route:       ROLE_ROUTE_MAP[role]
    });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      ok:      false,
      message: err.message ?? "Error de autenticación."
    });
  }
}
