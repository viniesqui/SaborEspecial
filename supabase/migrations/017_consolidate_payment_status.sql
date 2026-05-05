-- ============================================================
-- Migration 017: Consolidate payment_status_enum paid values
--
-- Background:
--   payment_status_enum (created in migration 001) ships three
--   values that all mean "the customer has paid":
--     · PAGADO            — original value
--     · CONFIRMADO        — used for credit-redemption auto-paid orders
--     · CONFIRMADO_SINPE  — never wired up consistently
--
--   Every read path therefore had to repeat the three-value OR list
--   in JS and SQL, and a single new paid state would silently break
--   half the dashboards.  This migration picks ONE canonical value
--   ('CONFIRMADO') and migrates the data + analytics functions to
--   use it.
--
-- Why we don't drop the deprecated values:
--   PostgreSQL does not support DROP VALUE on an enum, and ALTER
--   TYPE … RENAME VALUE cannot rename to an existing label.  PAGADO
--   and CONFIRMADO_SINPE therefore remain in the type for the
--   indefinite future as deprecated, never-written values.  Read
--   paths in JS keep accepting them so any straggler row still
--   counts as paid until manually purged.
--
-- Rollout:
--   1. Backfill all paid rows to 'CONFIRMADO'.
--   2. Re-emit get_day_stats with a single-value filter.
--   3. Re-emit v_daily_prep_list with a single-value filter.
-- ============================================================


-- ============================================================
-- PART 1: Data backfill
-- ============================================================

UPDATE orders
   SET payment_status = 'CONFIRMADO'
 WHERE payment_status IN ('PAGADO', 'CONFIRMADO_SINPE');


-- ============================================================
-- PART 2: get_day_stats — single-value filter
--
-- Mirrors the migration-014 definition exactly except for the
-- IN(...) lists, which now compare to 'CONFIRMADO' alone.
-- The function is SECURITY DEFINER and re-grants service_role
-- so the API layer keeps working.
-- ============================================================

DROP FUNCTION IF EXISTS get_day_stats(UUID, DATE);

CREATE OR REPLACE FUNCTION get_day_stats(
  p_cafeteria_id UUID,
  p_day_key      DATE
)
RETURNS TABLE (
  total_orders          BIGINT,
  paid_orders           BIGINT,
  pending_payment       BIGINT,
  delivered_orders      BIGINT,
  pending_deliveries    BIGINT,
  paid_pending_delivery BIGINT,
  sinpe_count           BIGINT,
  cash_count            BIGINT,
  total_amount          NUMERIC,
  digital_count         BIGINT,
  walk_in_count         BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  -- Tenant guard — preserved from migration 014.
  IF auth.uid() IS NOT NULL
     AND p_cafeteria_id IS DISTINCT FROM get_my_cafeteria_id()
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*)                                                           AS total_orders,
    COUNT(*) FILTER (WHERE payment_status = 'CONFIRMADO')              AS paid_orders,
    COUNT(*) FILTER (WHERE payment_status <> 'CONFIRMADO')             AS pending_payment,
    COUNT(*) FILTER (WHERE delivery_status = 'ENTREGADO')              AS delivered_orders,
    COUNT(*) FILTER (WHERE delivery_status <> 'ENTREGADO')             AS pending_deliveries,
    COUNT(*) FILTER (
      WHERE payment_status   =  'CONFIRMADO'
        AND delivery_status <> 'ENTREGADO'
    )                                                                  AS paid_pending_delivery,
    COUNT(*) FILTER (WHERE payment_method = 'SINPE')                   AS sinpe_count,
    COUNT(*) FILTER (WHERE payment_method = 'EFECTIVO')                AS cash_count,
    COALESCE(SUM(menu_price), 0)                                       AS total_amount,
    COUNT(*) FILTER (WHERE order_channel = 'DIGITAL')                  AS digital_count,
    COUNT(*) FILTER (WHERE order_channel = 'WALK_IN')                  AS walk_in_count
  FROM orders
  WHERE cafeteria_id = p_cafeteria_id
    AND target_date  = p_day_key
    AND record_status = 'ACTIVO'
    AND sale_type    <> 'PACKAGE_SALE';
END;
$$;

REVOKE EXECUTE ON FUNCTION get_day_stats FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_day_stats TO service_role;


-- ============================================================
-- PART 3: v_daily_prep_list — single-value filter
-- ============================================================

CREATE OR REPLACE VIEW v_daily_prep_list AS
SELECT
  cafeteria_id,
  day_key,
  menu_title,
  COUNT(*)                                                              AS total_portions,
  COUNT(*) FILTER (WHERE payment_status =  'CONFIRMADO')                AS confirmed_portions,
  COUNT(*) FILTER (WHERE payment_status <> 'CONFIRMADO')                AS pending_portions,
  COUNT(*) FILTER (WHERE payment_method =  'SINPE')                     AS sinpe_count,
  COUNT(*) FILTER (WHERE payment_method =  'EFECTIVO')                  AS cash_count
FROM orders
WHERE record_status = 'ACTIVO'
GROUP BY cafeteria_id, day_key, menu_title;
