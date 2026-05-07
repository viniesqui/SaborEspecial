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

const ALLOWED_INVITE_ROLES = ["ADMIN", "HELPER", "ORDERS"];

// Vercel Hobby plan caps deployments at 12 functions, so this endpoint
// dispatches several admin features through query/action params:
//
//   GET  /api/auth-role                 → resolve caller's role + route
//   GET  /api/auth-role?health=1        → public health check
//   GET  /api/auth-role?staff=1         → ADMIN: list cafeteria_users
//   GET  /api/auth-role?diagnostics=1   → ADMIN: orphan/no-admin scan
//   POST /api/auth-role { action: 'staff_invite' | 'staff_remove' | 'staff_update_role', ... }
//
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  // Health-check path — no auth required.
  // Reached via vercel.json rewrite: /api/health → /api/auth-role?health=1
  if (req.query?.health === "1") {
    return await handleHealth(res);
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    // ── ADMIN-only branches ───────────────────────────────────────
    if (req.query?.diagnostics === "1") {
      const auth = await requireAuth(req, ["ADMIN"]);
      return await handleDiagnostics(res, auth);
    }
    if (req.query?.staff === "1") {
      const auth = await requireAuth(req, ["ADMIN"]);
      return await listStaff(res, auth.cafeteriaId);
    }

    if (req.method === "POST") {
      const action = String(req.body?.action || "");
      const auth   = await requireAuth(req, ["ADMIN"]);
      if (action === "staff_invite")      return await inviteStaff(req, res, auth);
      if (action === "staff_remove")      return await removeStaff(req, res, auth);
      if (action === "staff_update_role") return await updateStaffRole(req, res, auth);
      return res.status(400).json({ ok: false, message: "Acción no soportada." });
    }

    // ── Default: return caller's role + route ─────────────────────
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

// ─────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────
async function handleHealth(res) {
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

// ─────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────
async function handleDiagnostics(res /*, auth */) {
  const checks = {};

  const t0 = Date.now();
  const { error: dbError } = await supabase.from("cafeterias").select("id").limit(1);
  checks.database = dbError
    ? { ok: false, detail: dbError.message }
    : { ok: true, detail: "Latencia " + (Date.now() - t0) + "ms" };

  const resendKey = process.env.RESEND_API_KEY;
  checks.email = {
    ok:     Boolean(resendKey),
    detail: resendKey ? "Configurado" : "RESEND_API_KEY no configurado"
  };

  checks.serviceRole = {
    ok:     Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    detail: process.env.SUPABASE_SERVICE_ROLE_KEY ? "OK" : "Falta SUPABASE_SERVICE_ROLE_KEY"
  };

  const orphanedAuthUsers = [];
  try {
    const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers({ perPage: 200 });
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
          orphanedAuthUsers.push({ userId: u.id, email: u.email, createdAt: u.created_at });
        }
      }
    }
    checks.orphanScan = { ok: true, detail: "Revisados " + userIds.length + " usuarios" };
  } catch (e) {
    checks.orphanScan = { ok: false, detail: e.message };
  }

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
      if (!count) cafeteriasWithoutAdmin.push({ id: c.id, name: c.name, slug: c.slug });
    }
    checks.adminScan = { ok: true, detail: "Revisadas " + (cafs?.length || 0) + " cafeterías" };
  } catch (e) {
    checks.adminScan = { ok: false, detail: e.message };
  }

  return res.status(200).json({
    ok:                     true,
    checks,
    orphanedAuthUsers,
    cafeteriasWithoutAdmin,
    timestamp:              new Date().toISOString()
  });
}

// ─────────────────────────────────────────────────────────────────
// Staff
// ─────────────────────────────────────────────────────────────────
async function listStaff(res, cafeteriaId) {
  const { data: memberships, error } = await supabase
    .from("cafeteria_users")
    .select("id, user_id, role, created_at")
    .eq("cafeteria_id", cafeteriaId)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const staff = [];
  for (const m of memberships || []) {
    const { data: userData } = await supabase.auth.admin.getUserById(m.user_id);
    staff.push({
      membershipId: m.id,
      userId:       m.user_id,
      role:         m.role,
      email:        userData?.user?.email || "(sin correo)",
      invitedAt:    userData?.user?.invited_at || null,
      lastSignInAt: userData?.user?.last_sign_in_at || null,
      createdAt:    m.created_at
    });
  }

  return res.status(200).json({ ok: true, staff });
}

async function inviteStaff(req, res, auth) {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const role  = String(req.body?.role  || "").trim().toUpperCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ ok: false, message: "Correo electrónico inválido." });
  }
  if (!ALLOWED_INVITE_ROLES.includes(role)) {
    return res.status(400).json({ ok: false, message: "Rol inválido. Use ADMIN, HELPER u ORDERS." });
  }

  const { data: existingList, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) throw listError;

  const existing = (existingList?.users || []).find((u) => u.email === email);

  if (existing) {
    const { error: insertError } = await supabase
      .from("cafeteria_users")
      .insert({ cafeteria_id: auth.cafeteriaId, user_id: existing.id, role });

    if (insertError) {
      if (insertError.code === "23505") {
        return res.status(409).json({ ok: false, message: "Este usuario ya pertenece a esta cafetería." });
      }
      throw insertError;
    }

    return res.status(200).json({
      ok:      true,
      message: `${email} fue agregado a esta cafetería como ${role}.`,
      created: false
    });
  }

  const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
    data: { invite_cafeteria_id: auth.cafeteriaId, invite_role: role }
  });

  if (inviteError) {
    return res.status(400).json({
      ok:      false,
      message: inviteError.message || "No se pudo enviar la invitación."
    });
  }

  return res.status(200).json({
    ok:      true,
    message: `Invitación enviada a ${email} como ${role}.`,
    created: true
  });
}

async function removeStaff(req, res, auth) {
  const userId = String(req.body?.userId || "").trim();
  if (!userId) return res.status(400).json({ ok: false, message: "Falta userId." });
  if (userId === auth.userId) {
    return res.status(400).json({ ok: false, message: "No puede eliminar su propia membresía." });
  }

  const { data: target, error: targetError } = await supabase
    .from("cafeteria_users")
    .select("role")
    .eq("cafeteria_id", auth.cafeteriaId)
    .eq("user_id", userId)
    .maybeSingle();

  if (targetError) throw targetError;
  if (!target) return res.status(404).json({ ok: false, message: "Membresía no encontrada." });

  if (target.role === "ADMIN") {
    const { count, error: countError } = await supabase
      .from("cafeteria_users")
      .select("id", { count: "exact", head: true })
      .eq("cafeteria_id", auth.cafeteriaId)
      .eq("role", "ADMIN");
    if (countError) throw countError;
    if ((count || 0) <= 1) {
      return res.status(400).json({
        ok: false,
        message: "No se puede eliminar al último administrador de la cafetería."
      });
    }
  }

  const { error: deleteError } = await supabase
    .from("cafeteria_users")
    .delete()
    .eq("cafeteria_id", auth.cafeteriaId)
    .eq("user_id", userId);

  if (deleteError) throw deleteError;

  return res.status(200).json({ ok: true, message: "Miembro eliminado de la cafetería." });
}

async function updateStaffRole(req, res, auth) {
  const userId = String(req.body?.userId || "").trim();
  const role   = String(req.body?.role   || "").trim().toUpperCase();

  if (!userId) return res.status(400).json({ ok: false, message: "Falta userId." });
  if (!ALLOWED_INVITE_ROLES.includes(role)) {
    return res.status(400).json({ ok: false, message: "Rol inválido." });
  }

  if (role !== "ADMIN") {
    const { data: target } = await supabase
      .from("cafeteria_users")
      .select("role")
      .eq("cafeteria_id", auth.cafeteriaId)
      .eq("user_id", userId)
      .maybeSingle();

    if (target?.role === "ADMIN") {
      const { count } = await supabase
        .from("cafeteria_users")
        .select("id", { count: "exact", head: true })
        .eq("cafeteria_id", auth.cafeteriaId)
        .eq("role", "ADMIN");
      if ((count || 0) <= 1) {
        return res.status(400).json({
          ok: false,
          message: "No se puede degradar al último administrador."
        });
      }
    }
  }

  const { error } = await supabase
    .from("cafeteria_users")
    .update({ role })
    .eq("cafeteria_id", auth.cafeteriaId)
    .eq("user_id", userId);

  if (error) throw error;

  return res.status(200).json({ ok: true, message: "Rol actualizado." });
}
