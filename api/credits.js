import { handleOptions, setCors } from "../lib/http.js";
import { findBySlug }             from "../data/cafeterias.repo.js";
import { getBalance }             from "../data/credits.repo.js";

// GET /api/credits?slug=ceep&email=user@example.com
// Public: returns the remaining credit balance for an email address.
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const slug  = String(req.query?.slug  || "").toLowerCase().trim();
  const email = String(req.query?.email || "").toLowerCase().trim();

  if (!slug)  return res.status(400).json({ ok: false, message: "Parámetro 'slug' requerido." });
  if (!email) return res.status(400).json({ ok: false, message: "Parámetro 'email' requerido." });

  try {
    const cafeteria = await findBySlug(slug);
    if (!cafeteria) return res.status(404).json({ ok: false, message: "Cafetería no encontrada." });

    const remainingMeals = await getBalance(cafeteria.id, email);
    return res.status(200).json({ ok: true, email, remainingMeals });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
}
