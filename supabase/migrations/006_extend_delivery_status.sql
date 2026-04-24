-- ============================================================
-- Migration 006: Extend delivery_status_enum
--
-- The client-side kitchen workflow uses four stages:
--   PENDIENTE_ENTREGA → EN_PREPARACION → LISTO_PARA_ENTREGA → ENTREGADO
--
-- The original enum only had the two terminal states, making
-- the two intermediate transitions silently fail with a 400.
-- This migration aligns the database with the client workflow.
-- ============================================================

ALTER TYPE delivery_status_enum ADD VALUE IF NOT EXISTS 'EN_PREPARACION';
ALTER TYPE delivery_status_enum ADD VALUE IF NOT EXISTS 'LISTO_PARA_ENTREGA';
