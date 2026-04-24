import { supabase } from "../lib/supabase.js";
import { handleOptions, setCors } from "../lib/http.js";

const PUBLIC_FIELDS = [
  "id",
  "tracking_token",
  "buyer_name",
  "payment_method",
  "payment_status",
  "order_status",
  "delivery_status",
  "created_at",
  "payment_confirmed_at",
  "prepared_at",
  "ready_at",
  "delivered_at",
  "menu_title",
  "menu_description",
  "menu_price"
].join(", ");

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const token = String(req.query.token || "").trim();
  if (token.length < 10) {
    return res.status(400).json({ ok: false, message: "Token de seguimiento inválido." });
  }

  try {
    const { data: order, error } = await supabase
      .from("orders")
      .select(PUBLIC_FIELDS)
      .eq("tracking_token", token)
      .neq("record_status", "CANCELADO")
      .single();

    if (error || !order) {
      return res.status(404).json({ ok: false, message: "Pedido no encontrado. Verifica el enlace de seguimiento." });
    }

    return res.status(200).json({ ok: true, order });
  } catch (err) {
    return res.status(500).json({ ok: false, message: "Error al consultar el pedido." });
  }
}
