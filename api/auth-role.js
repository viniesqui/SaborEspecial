import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth } from "../lib/auth.js";

const ROLE_ROUTE_MAP = {
  ADMIN:  "./admin.html",
  HELPER: "./helper.html",
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
    const route = ROLE_ROUTE_MAP[role];

    return res.status(200).json({
      ok: true,
      role,
      cafeteriaId,
      route
    });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      ok: false,
      message: err.message ?? "Error de autenticación."
    });
  }
}
