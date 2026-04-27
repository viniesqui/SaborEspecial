-- ============================================================
-- Migration 013: Cost Accounting & Business Intelligence
--
-- Adds cost tracking to menus so the owner can enter the
-- estimated cost (ingredients + labor) per dish each day.
-- This data feeds the profitability reports in the admin panel.
-- ============================================================

ALTER TABLE menus
  ADD COLUMN IF NOT EXISTS cost_per_dish NUMERIC(10,2);
