import { handleOptions, setCors } from "../lib/http.js";

const ROLE_MAP = [
  {
    role: "CUSTOMER",
    envKey: "CUSTOMER_PASSWORD",
    route: "./customer.html"
  },
  {
    role: "HELPER",
    envKey: "HELPER_PASSWORD",
    route: "./helper.html"
  },
  {
    role: "ADMIN",
    envKey: "ADMIN_SECRET",
    route: "./admin.html"
  },
  {
    role: "ORDERS",
    envKey: "ORDERS_PASSWORD",
    route: "./deliveries.html"
  }
];

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const password = String(req.body?.password || "").trim();
  if (!password) {
    return res.status(400).json({ ok: false, message: "Ingrese una clave." });
  }

  const match = ROLE_MAP.find((item) => String(process.env[item.envKey] || "") === password);
  if (!match) {
    return res.status(401).json({ ok: false, message: "Clave incorrecta." });
  }

  return res.status(200).json({
    ok: true,
    role: match.role,
    route: match.route
  });
}
