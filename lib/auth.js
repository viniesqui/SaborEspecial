import { supabase } from "./supabase.js";

/**
 * Verifies the Bearer JWT and resolves the caller's cafeteria + role.
 *
 * Uses .limit(1).maybeSingle() instead of .single() so the query
 * degrades gracefully if a user somehow has multiple memberships
 * (e.g. future cross-cafeteria roles) rather than throwing.
 *
 * Throws { status, message } on any failure.
 *
 * @param {object}   req          - Vercel/Node request
 * @param {string[]} allowedRoles - e.g. ['ADMIN'] or ['ADMIN','HELPER','ORDERS']
 * @returns {{ userId, cafeteriaId, role }}
 */
export async function requireAuth(req, allowedRoles = ["ADMIN", "HELPER", "ORDERS"]) {
  const header = String(req.headers["authorization"] || "");
  if (!header.startsWith("Bearer ")) {
    throw { status: 401, message: "Se requiere autenticación." };
  }

  const token = header.slice(7);
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    throw { status: 401, message: "Token inválido o expirado." };
  }

  const { data: membership, error: memberError } = await supabase
    .from("cafeteria_users")
    .select("cafeteria_id, role")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (memberError || !membership) {
    throw { status: 403, message: "Usuario sin acceso a ninguna cafetería." };
  }

  if (!allowedRoles.includes(membership.role)) {
    throw { status: 403, message: "Permisos insuficientes para esta acción." };
  }

  return {
    userId:      user.id,
    cafeteriaId: membership.cafeteria_id,
    role:        membership.role
  };
}
