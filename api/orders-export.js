import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth }           from "../lib/auth.js";
import { findAll }               from "../data/orders.repo.js";

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(rows) {
  if (!rows.length) return "﻿";

  const headers = Object.keys(rows[0]);
  const lines   = [headers.map(escapeCsv).join(",")];

  rows.forEach((row) => {
    lines.push(
      headers.map((h) => {
        const v = row[h];
        return escapeCsv(v instanceof Date ? v.toISOString() : v);
      }).join(",")
    );
  });

  return "﻿" + lines.join("\n");
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const { cafeteriaId } = await requireAuth(req, ["ADMIN"]);
    const orders          = await findAll(cafeteriaId);
    const csv             = buildCsv(orders);

    res.setHeader("Content-Type",        "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="orders-export.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, message: error.message });
    }
    return res.status(500).json({ ok: false, message: error.message || "No fue posible exportar los pedidos." });
  }
}
