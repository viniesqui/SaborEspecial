-- ============================================================
-- Migration 002: Add ORDERS role to user_role_enum
--
-- POLICY — enum-extension migrations (see scripts/migrate.js header):
--   PostgreSQL forbids using an enum value created by ALTER TYPE …
--   ADD VALUE inside the same transaction that added it. This file
--   therefore contains ONLY enum extensions — no INSERTs, no other
--   DDL, no usages of the new value. Anything that needs to reference
--   'ORDERS' must live in a later migration so the ADD VALUE has
--   committed by then.
--
--   The migration runner in scripts/migrate.js detects ALTER TYPE …
--   ADD VALUE statements and executes them WITHOUT a surrounding
--   BEGIN/COMMIT so each value auto-commits. Mixed files (enum +
--   anything else) are rejected with a clear error.
-- ============================================================

-- Adds the ORDERS role for delivery-only staff members.
-- Must run after migration 001 which created the enum.
ALTER TYPE user_role_enum ADD VALUE IF NOT EXISTS 'ORDERS';
