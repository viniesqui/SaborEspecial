-- ============================================================
-- Migration 016: Add missing tracking_token column to orders
--
-- Background:
--   The orders table was created in migration 001 without a
--   tracking_token column.  Subsequent migrations (007, 010,
--   011, 012, 014) and the application layer (data/orders.repo.js,
--   api/track.js, api/admin-orders.js, api/deliveries.js,
--   data/credits.repo.js, data/packages.repo.js) all reference
--   the column, but no DDL ever added it.  Because
--   create_order_atomic is plpgsql, the missing column is not
--   caught at function-creation time and surfaces only at runtime
--   as: column "tracking_token" of relation "orders" does not exist.
--
-- This migration:
--   1. Adds the column.
--   2. Backfills existing rows with random UUIDs so /track.html
--      links resolve for historical orders.
--   3. Locks in NOT NULL + DEFAULT gen_random_uuid() so future
--      INSERTs that omit the parameter still work.
--   4. Adds a unique index for /track lookups.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tracking_token UUID;

UPDATE orders
   SET tracking_token = gen_random_uuid()
 WHERE tracking_token IS NULL;

ALTER TABLE orders
  ALTER COLUMN tracking_token SET DEFAULT gen_random_uuid(),
  ALTER COLUMN tracking_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tracking_token
  ON orders (tracking_token);
