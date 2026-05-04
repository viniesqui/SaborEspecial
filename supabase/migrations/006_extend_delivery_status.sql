-- ============================================================
-- Migration 006: Extend delivery_status_enum
--
-- The client-side kitchen workflow uses four stages:
--   PENDIENTE_ENTREGA → EN_PREPARACION → LISTO_PARA_ENTREGA → ENTREGADO
--
-- The original enum only had the two terminal states, making
-- the two intermediate transitions silently fail with a 400.
-- This migration aligns the database with the client workflow.
--
-- POLICY — enum-extension migrations (see scripts/migrate.js header):
--   PostgreSQL forbids using a value created by ALTER TYPE …
--   ADD VALUE inside the same transaction that added it. This file
--   therefore contains ONLY enum extensions — no INSERTs, no other
--   DDL, no usages of the new values. Anything that needs to
--   reference EN_PREPARACION or LISTO_PARA_ENTREGA must live in a
--   later migration so the ADD VALUE has committed by then.
--
--   The migration runner in scripts/migrate.js detects ALTER TYPE …
--   ADD VALUE statements and executes them WITHOUT a surrounding
--   BEGIN/COMMIT so each value auto-commits. Mixed files are
--   rejected with a clear error.
-- ============================================================

ALTER TYPE delivery_status_enum ADD VALUE IF NOT EXISTS 'EN_PREPARACION';
ALTER TYPE delivery_status_enum ADD VALUE IF NOT EXISTS 'LISTO_PARA_ENTREGA';
