-- 020_idempotent_order_creation.sql
-- Adds request_id to orders for idempotent order creation.
-- Prevents duplicate orders caused by ghost-failure retries (client receives
-- a network error while the server already committed the INSERT).

-- 1. Column to store the client-generated idempotency key.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_id UUID;

-- 2. Unique index: a second INSERT with the same request_id is rejected at the
--    DB level. NULL values are excluded so legacy rows without a key are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_request_id
  ON orders (request_id)
  WHERE request_id IS NOT NULL;

-- 3. Backstop: one active digital order per buyer per day.
--    Catches any duplicate that slips through without a request_id (e.g. old
--    clients or direct API calls).
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_per_buyer_per_day
  ON orders (cafeteria_id, buyer_email, target_date)
  WHERE record_status = 'ACTIVO'
    AND buyer_email   != ''
    AND order_channel  = 'DIGITAL';

-- 4. Replace create_order_atomic with idempotency-aware version.
--    New parameter p_request_id (DEFAULT NULL keeps all existing callers working).
--    If a row with that request_id already exists the function returns the
--    original order_id with duplicate:true instead of inserting again.
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
  p_created_by_staff   BOOLEAN DEFAULT FALSE,
  p_sale_type          TEXT    DEFAULT 'SINGLE_SALE',
  p_request_id         UUID    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_meals    INTEGER;
  v_sold         BIGINT;
  v_order_id     UUID;
  v_target_date  DATE;
  v_caller_uid   TEXT;
  v_channel      TEXT;
  v_name         TEXT;
  v_email        TEXT;
BEGIN
  v_target_date := COALESCE(p_target_date, p_day_key);
  v_caller_uid  := auth.uid()::TEXT;
  v_channel     := UPPER(TRIM(COALESCE(p_order_channel, 'DIGITAL')));
  v_name        := TRIM(COALESCE(p_buyer_name, ''));
  v_email       := LOWER(TRIM(COALESCE(p_buyer_email, '')));

  -- Idempotency check: if this request_id was already processed, return the
  -- original order_id without inserting again.
  IF p_request_id IS NOT NULL THEN
    SELECT id INTO v_order_id
    FROM   orders
    WHERE  request_id = p_request_id;

    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'order_id', v_order_id, 'duplicate', true);
    END IF;
  END IF;

  -- Tenant guard
  IF v_caller_uid IS NOT NULL
     AND p_cafeteria_id IS DISTINCT FROM get_my_cafeteria_id()
  THEN
    INSERT INTO system_logs (event_type, cafeteria_id, user_id, payload, severity)
    VALUES (
      'CROSS_TENANT_WRITE_ATTEMPT',
      p_cafeteria_id,
      v_caller_uid,
      jsonb_build_object(
        'fn',            'create_order_atomic',
        'supplied_cafe', p_cafeteria_id,
        'actual_cafe',   get_my_cafeteria_id()
      ),
      'CRITICAL'
    );
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  -- Input validation
  IF v_name = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_name is required');
  END IF;
  IF LENGTH(v_name) > 100 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_name exceeds 100 characters');
  END IF;
  IF p_menu_price < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'menu_price cannot be negative');
  END IF;
  IF v_channel = 'DIGITAL' AND v_email = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_email is required for digital orders');
  END IF;
  IF v_email != '' AND v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_email format is invalid');
  END IF;
  IF v_target_date < CURRENT_DATE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'target_date cannot be in the past');
  END IF;
  IF v_target_date > CURRENT_DATE + INTERVAL '7 days' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'target_date cannot be more than 7 days ahead');
  END IF;

  -- Capacity check (serialized via FOR UPDATE)
  SELECT max_meals INTO v_max_meals
  FROM   settings
  WHERE  cafeteria_id = p_cafeteria_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CAFETERIA_NOT_CONFIGURED');
  END IF;

  SELECT COUNT(*) INTO v_sold
  FROM   orders
  WHERE  cafeteria_id = p_cafeteria_id
    AND  target_date   = v_target_date
    AND  record_status = 'ACTIVO'
    AND  sale_type    != 'PACKAGE_SALE';

  IF v_sold >= v_max_meals THEN
    INSERT INTO system_logs (event_type, cafeteria_id, user_id, payload, severity)
    VALUES (
      'CAPACITY_EXCEEDED',
      p_cafeteria_id,
      v_caller_uid,
      jsonb_build_object(
        'target_date', v_target_date,
        'sold',        v_sold,
        'max_meals',   v_max_meals,
        'buyer_name',  v_name,
        'channel',     v_channel
      ),
      'WARN'
    );
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   'CAPACITY_EXCEEDED',
      'message', 'No hay almuerzos disponibles para esa fecha.'
    );
  END IF;

  INSERT INTO orders (
    cafeteria_id,  day_key,   target_date,
    buyer_name,    buyer_email, buyer_id, buyer_phone,
    menu_id,       menu_title, menu_description, menu_price,
    payment_method, payment_status, order_status,
    delivery_status, record_status,  tracking_token,
    order_channel, created_by_staff, sale_type,
    request_id
  ) VALUES (
    p_cafeteria_id, p_day_key, v_target_date,
    v_name, v_email, '', '',
    p_menu_id, p_menu_title, p_menu_description, p_menu_price,
    p_payment_method::payment_method_enum,
    'PENDIENTE_DE_PAGO', 'SOLICITADO',
    'PENDIENTE_ENTREGA', 'ACTIVO', p_tracking_token,
    v_channel,
    COALESCE(p_created_by_staff, FALSE),
    COALESCE(p_sale_type,        'SINGLE_SALE'),
    p_request_id
  )
  RETURNING id INTO v_order_id;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION create_order_atomic FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_order_atomic TO service_role;
