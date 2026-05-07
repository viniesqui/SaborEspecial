-- ============================================================
-- Migration 018: get_week_stats — single-call weekly aggregate
--
-- Problem
--   The customer dashboard loads with ?week=true, which previously
--   issued one get_day_stats RPC per day (7 round trips on every
--   landing-page load) just to compute availableMeals per day.
--   Each call also runs the auth.uid() / get_my_cafeteria_id()
--   tenant guard, multiplying overhead.
--
-- Fix
--   One PL/pgSQL function returns (target_date, total_orders) for
--   the whole [from_date, to_date] range in a single GROUP BY scan
--   over the existing (cafeteria_id, target_date) index.
--
-- Notes
--   - Filters mirror get_day_stats: record_status = 'ACTIVO' and
--     sale_type <> 'PACKAGE_SALE' (lunches only — package sales
--     don't consume capacity).
--   - SECURITY DEFINER + service_role grant matches get_day_stats.
-- ============================================================

DROP FUNCTION IF EXISTS get_week_stats(UUID, DATE, DATE);

CREATE OR REPLACE FUNCTION get_week_stats(
  p_cafeteria_id UUID,
  p_from_date    DATE,
  p_to_date      DATE
)
RETURNS TABLE (
  target_date  DATE,
  total_orders BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  -- Tenant guard: silently return empty set for cross-tenant probes.
  IF auth.uid() IS NOT NULL
     AND p_cafeteria_id IS DISTINCT FROM get_my_cafeteria_id()
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    o.target_date,
    COUNT(*)::BIGINT AS total_orders
  FROM orders o
  WHERE o.cafeteria_id  = p_cafeteria_id
    AND o.target_date  >= p_from_date
    AND o.target_date  <= p_to_date
    AND o.record_status = 'ACTIVO'
    AND o.sale_type    <> 'PACKAGE_SALE'
  GROUP BY o.target_date;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_week_stats FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_week_stats TO service_role;
