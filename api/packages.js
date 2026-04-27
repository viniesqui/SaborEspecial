import { randomUUID }                    from "crypto";
import { handleOptions, setCors }         from "../lib/http.js";
import { getDayKey }                      from "../lib/dashboard.js";
import { findBySlug }                     from "../data/cafeterias.repo.js";
import { requireAuth }                    from "../lib/auth.js";
import { sendOrderStatusEmail }           from "../lib/email.js";
import {
  findActive,
  findById,
  create,
  toggle,
  createOrder
} from "../data/packages.repo.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method === "GET")  return handleList(req, res);
  if (req.method === "POST") return handlePost(req, res);
  return res.status(405).json({ ok: false, message: "Method not allowed" });
}

// GET /api/packages?slug=ceep
// Public: returns active packages for the given cafeteria.
async function handleList(req, res) {
  const slug = String(req.query?.slug || "").toLowerCase().trim();
  if (!slug) return res.status(400).json({ ok: false, message: "Parámetro 'slug' requerido." });

  try {
    const cafeteria = await findBySlug(slug);
    if (!cafeteria) return res.status(404).json({ ok: false, message: "Cafetería no encontrada." });

    const packages = await findActive(cafeteria.id);
    return res.status(200).json({ ok: true, packages });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
}

// POST /api/packages?slug=ceep
// Dispatches to sub-handlers by the "action" field in the body.
async function handlePost(req, res) {
  const action = String(req.body?.action || "buy");
  if (action === "buy")    return handleBuy(req, res);
  if (action === "create") return handleCreate(req, res);
  if (action === "toggle") return handleToggle(req, res);
  return res.status(400).json({ ok: false, message: "Acción no soportada." });
}

// action="buy" — public: customer purchases a package.
// Creates a PACKAGE_SALE order for the owner to verify payment manually.
// On confirmation, the admin panel calls add_credits to grant the balance.
async function handleBuy(req, res) {
  const slug = String(req.query?.slug || req.body?.slug || "").toLowerCase().trim();
  if (!slug) return res.status(400).json({ ok: false, message: "Parámetro 'slug' requerido." });

  try {
    const cafeteria = await findBySlug(slug);
    if (!cafeteria) return res.status(404).json({ ok: false, message: "Cafetería no encontrada." });

    const { id: cafeteriaId } = cafeteria;
    const body          = req.body || {};
    const buyerName     = String(body.buyerName     || "").trim();
    const buyerEmail    = String(body.buyerEmail    || "").trim().toLowerCase();
    const packageId     = String(body.packageId     || "").trim();
    const paymentMethod = String(body.paymentMethod || "").toUpperCase();

    if (!buyerName)                                    return res.status(400).json({ ok: false, message: "Nombre completo requerido." });
    if (!buyerEmail)                                   return res.status(400).json({ ok: false, message: "Correo requerido — los créditos se asignan a este correo." });
    if (!packageId)                                    return res.status(400).json({ ok: false, message: "Seleccione un paquete." });
    if (!["SINPE", "EFECTIVO"].includes(paymentMethod)) return res.status(400).json({ ok: false, message: "Método de pago inválido." });

    const pkg = await findById(packageId, cafeteriaId);
    if (!pkg) return res.status(404).json({ ok: false, message: "Paquete no disponible." });

    const trackingToken = randomUUID();
    const result = await createOrder({
      cafeteriaId,
      dayKey:        getDayKey(),
      buyerName,
      buyerEmail,
      packageId:     pkg.id,
      packageTitle:  pkg.title,
      packagePrice:  Number(pkg.price),
      paymentMethod,
      trackingToken
    });

    if (!result?.ok) {
      return res.status(400).json({ ok: false, message: "No se pudo registrar la solicitud del paquete." });
    }

    const appBaseUrl  = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
    const trackingUrl = appBaseUrl ? `${appBaseUrl}/track.html?token=${trackingToken}` : "";

    sendOrderStatusEmail({
      to:         buyerEmail,
      buyerName,
      orderId:    result.order_id,
      status:     "SOLICITADO",
      trackingUrl
    }).catch(() => null);

    return res.status(200).json({
      ok:           true,
      message:      `Solicitud de paquete "${pkg.title}" registrada. El encargado verificará tu pago y activará los créditos.`,
      trackingToken,
      package: { title: pkg.title, mealCount: pkg.meal_count, price: Number(pkg.price) }
    });
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
}

// action="create" — admin: defines a new package.
async function handleCreate(req, res) {
  try {
    const { cafeteriaId } = await requireAuth(req, ["ADMIN"]);
    const { title, mealCount, price } = req.body || {};

    if (!title || !mealCount || !price) {
      return res.status(400).json({ ok: false, message: "Campos requeridos: title, mealCount, price." });
    }
    if (Number(mealCount) < 1 || Number(price) <= 0) {
      return res.status(400).json({ ok: false, message: "La cantidad de almuerzos y el precio deben ser mayores a cero." });
    }

    const pkg      = await create(cafeteriaId, { title: String(title).trim(), mealCount: Number(mealCount), price: Number(price) });
    const packages = await findActive(cafeteriaId);
    return res.status(200).json({ ok: true, package: pkg, packages });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, message: err.message });
    return res.status(500).json({ ok: false, message: err.message });
  }
}

// action="toggle" — admin: activate or deactivate a package.
async function handleToggle(req, res) {
  try {
    const { cafeteriaId } = await requireAuth(req, ["ADMIN"]);
    const { packageId, isActive } = req.body || {};
    if (!packageId) return res.status(400).json({ ok: false, message: "Paquete no especificado." });

    await toggle(packageId, cafeteriaId, Boolean(isActive));
    const packages = await findActive(cafeteriaId);
    return res.status(200).json({ ok: true, packages });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, message: err.message });
    return res.status(500).json({ ok: false, message: err.message });
  }
}
