import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth }           from "../lib/auth.js";

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
