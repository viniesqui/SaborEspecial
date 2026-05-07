import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth }           from "../lib/auth.js";
import { supabase }              from "../lib/supabase.js";

// ADMIN-only diagnostics endpoint. Surfaces the manual SQL queries from the
// IAM audit (orphaned auth users, cafeterias with zero ADMINs, basic health).
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed." });
  }

  try {
    await requireAuth(req, ["ADMIN"]);

    const checks = {};

    // 1. Database connectivity
    const t0 = Date.now();
    const { error: dbError } = await supabase.from("cafeterias").select("id").limit(1);
    checks.database = dbError
      ? { ok: false, detail: dbError.message }
      : { ok: true, detail: "Latencia " + (Date.now() - t0) + "ms" };

    // 2. Email configuration
    const resendKey = process.env.RESEND_API_KEY;
    checks.email = {
      ok:     Boolean(resendKey),
      detail: resendKey ? "Configurado" : "RESEND_API_KEY no configurado"
    };

    // 3. Service role configured
    checks.serviceRole = {
      ok:     Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      detail: process.env.SUPABASE_SERVICE_ROLE_KEY ? "OK" : "Falta SUPABASE_SERVICE_ROLE_KEY"
    };

    // 4. Orphaned auth users — accounts without any cafeteria_users row.
    //    auth.users is not directly queryable via supabase-js, so we use the
    //    admin API and cross-reference against cafeteria_users.
    const orphanedAuthUsers = [];
    try {
      const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers({
        perPage: 200
      });
      if (usersError) throw usersError;

      const userIds = (usersData?.users || []).map((u) => u.id);
      if (userIds.length) {
        const { data: memberships, error: memError } = await supabase
          .from("cafeteria_users")
          .select("user_id")
          .in("user_id", userIds);
        if (memError) throw memError;

        const memberSet = new Set((memberships || []).map((m) => m.user_id));
        for (const u of usersData.users) {
          if (!memberSet.has(u.id)) {
            orphanedAuthUsers.push({
              userId:    u.id,
              email:     u.email,
              createdAt: u.created_at
            });
          }
        }
      }
      checks.orphanScan = { ok: true, detail: "Revisados " + userIds.length + " usuarios" };
    } catch (e) {
      checks.orphanScan = { ok: false, detail: e.message };
    }

    // 5. Cafeterias without any ADMIN
    const cafeteriasWithoutAdmin = [];
    try {
      const { data: cafs, error: cafError } = await supabase
        .from("cafeterias")
        .select("id, name, slug, is_active");
      if (cafError) throw cafError;

      for (const c of cafs || []) {
        const { count, error: countError } = await supabase
          .from("cafeteria_users")
          .select("id", { count: "exact", head: true })
          .eq("cafeteria_id", c.id)
          .eq("role", "ADMIN");
        if (countError) throw countError;
        if (!count) {
          cafeteriasWithoutAdmin.push({ id: c.id, name: c.name, slug: c.slug });
        }
      }
      checks.adminScan = { ok: true, detail: "Revisadas " + (cafs?.length || 0) + " cafeterías" };
    } catch (e) {
      checks.adminScan = { ok: false, detail: e.message };
    }

    return res.status(200).json({
      ok:                      true,
      checks,
      orphanedAuthUsers,
      cafeteriasWithoutAdmin,
      timestamp:               new Date().toISOString()
    });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      ok:      false,
      message: err.message ?? "Error inesperado."
    });
  }
}
