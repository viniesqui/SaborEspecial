import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth }           from "../lib/auth.js";
import { supabase }              from "../lib/supabase.js";

const ALLOWED_INVITE_ROLES = ["ADMIN", "HELPER", "ORDERS"];

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed." });
  }

  try {
    const auth = await requireAuth(req, ["ADMIN"]);

    if (req.method === "GET") {
      return await listStaff(res, auth.cafeteriaId);
    }

    const action = String(req.body?.action || "");
    if (action === "invite") return await inviteStaff(req, res, auth);
    if (action === "remove") return await removeStaff(req, res, auth);
    if (action === "update_role") return await updateRole(req, res, auth);

    return res.status(400).json({
      ok: false,
      message: "Acción no soportada. Use 'invite', 'remove' o 'update_role'."
    });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      ok:      false,
      message: err.message ?? "Error inesperado."
    });
  }
}

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
    return res.status(400).json({
      ok: false,
      message: "Rol inválido. Use ADMIN, HELPER u ORDERS."
    });
  }

  // Check if a user with this email already exists.
  const { data: existingList, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) throw listError;

  const existing = (existingList?.users || []).find((u) => u.email === email);

  if (existing) {
    // User already has an auth account — just bind them to this cafeteria.
    const { error: insertError } = await supabase
      .from("cafeteria_users")
      .insert({
        cafeteria_id: auth.cafeteriaId,
        user_id:      existing.id,
        role
      });

    if (insertError) {
      if (insertError.code === "23505") {
        return res.status(409).json({
          ok: false,
          message: "Este usuario ya pertenece a esta cafetería."
        });
      }
      throw insertError;
    }

    return res.status(200).json({
      ok:      true,
      message: `${email} fue agregado a esta cafetería como ${role}.`,
      created: false
    });
  }

  // No auth account exists — invite by email. The trigger will pick up
  // invite_cafeteria_id + invite_role from raw_user_meta_data and create
  // ONLY the cafeteria_users row (no new cafeteria).
  const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
    email,
    {
      data: {
        invite_cafeteria_id: auth.cafeteriaId,
        invite_role:         role
      }
    }
  );

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
  if (!userId) {
    return res.status(400).json({ ok: false, message: "Falta userId." });
  }

  // Forbid removing yourself — prevents an ADMIN from locking themselves out.
  if (userId === auth.userId) {
    return res.status(400).json({
      ok: false,
      message: "No puede eliminar su propia membresía."
    });
  }

  // Forbid removing the last ADMIN.
  const { data: target, error: targetError } = await supabase
    .from("cafeteria_users")
    .select("role")
    .eq("cafeteria_id", auth.cafeteriaId)
    .eq("user_id", userId)
    .maybeSingle();

  if (targetError) throw targetError;
  if (!target) {
    return res.status(404).json({ ok: false, message: "Membresía no encontrada." });
  }

  if (target.role === "ADMIN") {
    const { count, error: countError } = await supabase
      .from("cafeteria_users")
      .select("id", { count: "exact", head: true })
      .eq("cafeteria_id", auth.cafeteriaId)
      .eq("role", "ADMIN");
    if (countError) throw countError;
    if ((count || 0) <= 1) {
      return res.status(400).json({
        ok:      false,
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

  return res.status(200).json({
    ok:      true,
    message: "Miembro eliminado de la cafetería."
  });
}

async function updateRole(req, res, auth) {
  const userId = String(req.body?.userId || "").trim();
  const role   = String(req.body?.role   || "").trim().toUpperCase();

  if (!userId) {
    return res.status(400).json({ ok: false, message: "Falta userId." });
  }
  if (!ALLOWED_INVITE_ROLES.includes(role)) {
    return res.status(400).json({ ok: false, message: "Rol inválido." });
  }

  // If demoting the last ADMIN, block it.
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
          ok:      false,
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
