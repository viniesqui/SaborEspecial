// Single source of truth for payment status comparisons across the API.
//
// payment_status_enum (defined in supabase/migrations/001) has historically
// shipped three values that all mean "the customer has paid":
//   · CONFIRMADO        — canonical (use this for ALL new writes)
//   · PAGADO            — legacy, deprecated; never written by new code
//   · CONFIRMADO_SINPE  — legacy, deprecated; never written by new code
//
// PostgreSQL cannot DROP enum values, so the deprecated labels remain in
// the type indefinitely. Read paths must keep accepting all three so any
// straggler row still counts as paid. See migration 017 for the data
// backfill and analytics-function updates.

export const CANONICAL_PAID   = "CONFIRMADO";
export const CANONICAL_UNPAID = "PENDIENTE_DE_PAGO";

// Read-side: every value that means "paid" — canonical first, then legacy.
export const PAID_STATUSES = ["CONFIRMADO", "PAGADO", "CONFIRMADO_SINPE"];

export function isPaid(status) {
  return PAID_STATUSES.includes(String(status || "").toUpperCase());
}

// Maps any incoming paid value (legacy or canonical) to the canonical one,
// and any unpaid value to PENDIENTE_DE_PAGO. Use for write paths.
export function toCanonicalPayment(status) {
  return isPaid(status) ? CANONICAL_PAID : CANONICAL_UNPAID;
}
