// Pure validation functions extracted here so both api/orders.js and the
// test suite can import them without pulling in any Supabase dependencies.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validates the customer/staff order payload.
 * Throws a plain Error with a Spanish user-facing message on any failure.
 */
export function validateOrder(order) {
  const name   = String(order.buyerName   || "").trim();
  const method = String(order.paymentMethod || "").toUpperCase();
  const email  = String(order.buyerEmail  || "").trim().toLowerCase();

  if (!name) {
    throw new Error("El nombre del comprador es obligatorio.");
  }
  if (name.length < 2) {
    throw new Error("El nombre debe tener al menos 2 caracteres.");
  }
  if (name.length > 100) {
    throw new Error("El nombre no puede exceder 100 caracteres.");
  }
  if (!method) {
    throw new Error("El método de pago es obligatorio.");
  }
  if (!["SINPE", "EFECTIVO", "CREDITO"].includes(method)) {
    throw new Error("Método de pago inválido.");
  }
  // Email: required for all payment methods; format-validated when present.
  if (!email) {
    throw new Error("El correo electrónico es obligatorio.");
  }
  if (!EMAIL_RE.test(email)) {
    throw new Error("El formato del correo electrónico es inválido.");
  }
}

/**
 * Validates that targetDate is in range and properly formatted.
 * todayKey is the current day in Costa Rica time (YYYY-MM-DD), supplied
 * by the caller so this function remains pure for testing.
 *
 * Throws a plain Error with a Spanish user-facing message on any failure.
 */
export function validateTargetDate(targetDate, todayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error("Fecha de pedido inválida.");
  }
  if (targetDate !== todayKey) {
    throw new Error("Solo se aceptan pedidos para hoy.");
  }
}
