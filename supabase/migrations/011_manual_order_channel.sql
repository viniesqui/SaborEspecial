-- ============================================================
-- Migration 011: Manual Walk-in Order Channel
--
-- Adds two metadata columns to orders so manual (POS) sales
-- placed by staff are tracked separately from digital orders:
--
--   order_channel      — 'DIGITAL' (web app) or 'WALK_IN' (staff POS)
--   created_by_staff   — TRUE when an authenticated staff member
--                        created the order on behalf of a customer
--
-- Also updates:
--   create_order_atomic — stores the new channel fields
--   get_day_stats       — returns digital_count / walk_in_count
--                         for the owner's channel analytics
-- ============================================================


-- ── 1. orders: add order_channel ─────────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_channel TEXT NOT NULL DEFAULT 'DIGITAL'
  CONSTRAINT orders_order_channel_check CHECK (order_channel IN ('DIGITAL', 'WALK_IN'));


-- ── 2. orders: add created_by_staff ──────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS created_by_staff BOOLEAN NOT NULL DEFAULT FALSE;


-- ── 3. create_order_atomic (updated) ─────────────────────────
-- Adds p_order_channel and p_created_by_staff with DEFAULT values
-- so all existing callers continue to work without changes.

CREATE OR REPLACE FUNCTION create_order_atomic(
  p_cafeteria_id       UUID,
  p_day_key            DATE,
  p_buyer_name         TEXT,
  p_buyer_email        TEXT,
  p_menu_id            UUID,
  p_menu_title         TEXT,
  p_menu_description   TEXT,
  p_menu_price         NUMERIC,
  p_payment_method     TEXT,
  p_tracking_token     UUID,
  p_target_date        DATE    DEFAULT NULL,
  p_order_channel      TEXT    DEFAULT 'DIGITAL',
  p_created_by_staff   BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_meals   INTEGER;
  v_sold        BIGINT;
  v_order_id    UUID;
  v_target_date DATE;
BEGIN
  v_target_date := COALESCE(p_target_date, p_day_key);

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
    AND target_date   = v_target_date
    AND record_status = 'ACTIVO';

  IF v_sold >= v_max_meals THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CAPACITY_EXCEEDED');
  END IF;

  INSERT INTO orders (
    cafeteria_id, day_key, target_date,
    buyer_name, buyer_email, buyer_id, buyer_phone,
    menu_id, menu_title, menu_description, menu_price,
    payment_method, payment_status, order_status,
    delivery_status, record_status, tracking_token,
    order_channel, created_by_staff
  ) VALUES (
    p_cafeteria_id, p_day_key, v_target_date,
    p_buyer_name, p_buyer_email, '', '',
    p_menu_id, p_menu_title, p_menu_description, p_menu_price,
    p_payment_method::payment_method_enum,
    'PENDIENTE_DE_PAGO', 'SOLICITADO',
    'PENDIENTE_ENTREGA', 'ACTIVO',
    p_tracking_token,
    COALESCE(p_order_channel, 'DIGITAL'),
    COALESCE(p_created_by_staff, FALSE)
  )
  RETURNING id INTO v_order_id;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id);
END;
$$;


-- ── 4. get_day_stats (updated) ────────────────────────────────
-- Adds digital_count and walk_in_count so the owner can compare
-- channel performance on the admin dashboard.

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
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    COUNT(*)
      AS total_orders,
    COUNT(*) FILTER (WHERE payment_status IN ('PAGADO', 'CONFIRMADO', 'CONFIRMADO_SINPE'))
      AS paid_orders,
    COUNT(*) FILTER (WHERE payment_status NOT IN ('PAGADO', 'CONFIRMADO', 'CONFIRMADO_SINPE'))
      AS pending_payment,
    COUNT(*) FILTER (WHERE delivery_status = 'ENTREGADO')
      AS delivered_orders,
    COUNT(*) FILTER (WHERE delivery_status != 'ENTREGADO')
      AS pending_deliveries,
    COUNT(*) FILTER (
      WHERE payment_status IN ('PAGADO', 'CONFIRMADO', 'CONFIRMADO_SINPE')
        AND delivery_status != 'ENTREGADO'
    )
      AS paid_pending_delivery,
    COUNT(*) FILTER (WHERE payment_method = 'SINPE')
      AS sinpe_count,
    COUNT(*) FILTER (WHERE payment_method = 'EFECTIVO')
      AS cash_count,
    COALESCE(SUM(menu_price), 0)
      AS total_amount,
    COUNT(*) FILTER (WHERE order_channel = 'DIGITAL')
      AS digital_count,
    COUNT(*) FILTER (WHERE order_channel = 'WALK_IN')
      AS walk_in_count
  FROM orders
  WHERE cafeteria_id = p_cafeteria_id
    AND target_date   = p_day_key
    AND record_status = 'ACTIVO';
$$;
