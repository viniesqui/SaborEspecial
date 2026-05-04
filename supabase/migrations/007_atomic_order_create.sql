-- ============================================================
-- Migration 007: Atomic order creation + daily stats function
--
-- FUNCTION 1: create_order_atomic
--   Replaces the unsafe check-then-insert pattern in api/orders.js.
--   Acquires a row-level lock on settings (FOR UPDATE) so that
--   concurrent requests are serialized. The capacity check and
--   the INSERT happen inside a single transaction — no race window.
--
-- FUNCTION 2: get_day_stats
--   Returns aggregated order counts and revenue for a given
--   cafeteria + day in a single SQL round-trip, replacing the
--   JavaScript filter()/reduce() aggregations scattered across
--   the API layer.
-- ============================================================


-- ============================================================
-- FUNCTION 1: create_order_atomic
-- ============================================================

DROP FUNCTION IF EXISTS create_order_atomic(UUID,DATE,TEXT,TEXT,UUID,TEXT,TEXT,NUMERIC,TEXT,UUID);

CREATE OR REPLACE FUNCTION create_order_atomic(
  p_cafeteria_id      UUID,
  p_day_key           DATE,
  p_buyer_name        TEXT,
  p_buyer_email       TEXT,
  p_menu_id           UUID,
  p_menu_title        TEXT,
  p_menu_description  TEXT,
  p_menu_price        NUMERIC,
  p_payment_method    TEXT,
  p_tracking_token    UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_meals  INTEGER;
  v_sold       BIGINT;
  v_order_id   UUID;
BEGIN
  -- Lock the settings row for this cafeteria so concurrent calls
  -- are serialized. This is the chokepoint that prevents overselling.
  SELECT max_meals INTO v_max_meals
  FROM settings
  WHERE cafeteria_id = p_cafeteria_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CAFETERIA_NOT_CONFIGURED');
  END IF;

  SELECT COUNT(*) INTO v_sold
  FROM orders
  WHERE cafeteria_id = p_cafeteria_id
    AND day_key       = p_day_key
    AND record_status = 'ACTIVO';

  IF v_sold >= v_max_meals THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CAPACITY_EXCEEDED');
  END IF;

  INSERT INTO orders (
    cafeteria_id, day_key,
    buyer_name, buyer_email, buyer_id, buyer_phone,
    menu_id, menu_title, menu_description, menu_price,
    payment_method, payment_status, order_status,
    delivery_status, record_status, tracking_token
  ) VALUES (
    p_cafeteria_id, p_day_key,
    p_buyer_name, p_buyer_email, '', '',
    p_menu_id, p_menu_title, p_menu_description, p_menu_price,
    p_payment_method::payment_method_enum,
    'PENDIENTE_DE_PAGO', 'SOLICITADO',
    'PENDIENTE_ENTREGA', 'ACTIVO',
    p_tracking_token
  )
  RETURNING id INTO v_order_id;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id);
END;
$$;


-- ============================================================
-- FUNCTION 2: get_day_stats
-- ============================================================

DROP FUNCTION IF EXISTS get_day_stats(UUID,DATE);

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
  total_amount          NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    COUNT(*)                                                                                                      AS total_orders,
    COUNT(*) FILTER (WHERE payment_status IN ('PAGADO', 'CONFIRMADO', 'CONFIRMADO_SINPE'))                       AS paid_orders,
    COUNT(*) FILTER (WHERE payment_status NOT IN ('PAGADO', 'CONFIRMADO', 'CONFIRMADO_SINPE'))                   AS pending_payment,
    COUNT(*) FILTER (WHERE delivery_status = 'ENTREGADO')                                                        AS delivered_orders,
    COUNT(*) FILTER (WHERE delivery_status != 'ENTREGADO')                                                       AS pending_deliveries,
    COUNT(*) FILTER (
      WHERE payment_status IN ('PAGADO', 'CONFIRMADO', 'CONFIRMADO_SINPE')
        AND delivery_status != 'ENTREGADO'
    )                                                                                                             AS paid_pending_delivery,
    COUNT(*) FILTER (WHERE payment_method = 'SINPE')                                                             AS sinpe_count,
    COUNT(*) FILTER (WHERE payment_method = 'EFECTIVO')                                                          AS cash_count,
    COALESCE(SUM(menu_price), 0)                                                                                  AS total_amount
  FROM orders
  WHERE cafeteria_id = p_cafeteria_id
    AND day_key       = p_day_key
    AND record_status = 'ACTIVO';
$$;
