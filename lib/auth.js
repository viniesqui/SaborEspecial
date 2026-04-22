import { createClient } from "@supabase/supabase-js";

// Service-role client: bypasses RLS and is used ONLY on the server.
// Never expose SUPABASE_SERVICE_ROLE_KEY to the browser.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Verifies the Bearer JWT in the Authorization header and checks that the
 * caller has one of the allowed roles in cafeteria_users.
 *
 * Throws { status, message } on any auth failure so callers can do:
 *   catch (err) { return res.status(err.status).json({ ok: false, message: err.message }); }
 *
 * @param {object} req - Vercel/Node request object
 * @param {string[]} allowedRoles - e.g. ['ADMIN'] or ['ADMIN','HELPER','ORDERS']
 * @returns {{ userId: string, cafeteriaId: string, role: string }}
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
    .single();

  if (memberError || !membership) {
    throw { status: 403, message: "Usuario sin acceso a ninguna cafetería." };
  }

  if (!allowedRoles.includes(membership.role)) {
    throw { status: 403, message: "Permisos insuficientes para esta acción." };
  }

  return {
    userId: user.id,
    cafeteriaId: membership.cafeteria_id,
    role: membership.role
  };
}
