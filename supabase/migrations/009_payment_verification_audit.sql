-- Seamless Loop: payment verification audit trail and kitchen status timestamps.
--
-- payment_verified_by  → which staff member confirmed the SINPE payment
-- prepared_at          → when the kitchen clicked "En Preparación"
-- ready_at             → when the kitchen clicked "Listo para Entrega"
--
-- delivered_at already existed; these three fill in the remaining steps so the
-- buyer tracking page can show precise timestamps for every workflow stage.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_verified_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS prepared_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ready_at            TIMESTAMPTZ;

-- Allow the analytics engineer to join auth.users for reporting.
CREATE INDEX IF NOT EXISTS idx_orders_payment_verified_by
  ON orders (payment_verified_by)
  WHERE payment_verified_by IS NOT NULL;
