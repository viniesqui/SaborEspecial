-- ============================================================
-- Migration 014: Production Security Hardening
--
-- Findings addressed:
--   [CRITICAL] SECURITY DEFINER functions accept caller-supplied
--     p_cafeteria_id without verifying the caller's tenant — an
--     authenticated user with a JWT could call Supabase RPCs
--     directly and read/write another cafeteria's data.
--
--   [HIGH] No audit trail for security events or capacity overflows.
--
--   [HIGH] EXECUTE on order-mutation functions is PUBLIC; any anon
--     or authenticated client can call them directly, bypassing the
--     Node.js validation middleware.
--
--   [MEDIUM] packages_update_admin lacks explicit WITH CHECK —
--     relies on implicit PostgreSQL USING-as-WITH CHECK fallback.
--
--   [MEDIUM] Input validation enforced only in the JS layer;
--     no defense-in-depth at the SQL boundary.
--
-- Changes:
--   1. system_logs table — write-only for SECURITY DEFINER
--      functions; readable only via service_role.
--   2. REVOKE EXECUTE from PUBLIC on all mutation RPCs;
--      grant explicitly to service_role only.
--   3. Tenant guard in create_order_atomic,
--      create_credit_order_atomic, create_package_order,
--      get_day_stats, get_credit_balance — blocks authenticated
--      callers from supplying a foreign cafeteria_id.
--   4. Input validation inside create_order_atomic —
--      rejects negative prices, oversized names, malformed
--      emails, and missing emails on digital orders.
--   5. CAPACITY_EXCEEDED now logs to system_logs for silent
--      ops visibility without exposing data externally.
--   6. Explicit WITH CHECK on packages_update_admin.
--   7. Deterministic ORDER BY on get_my_cafeteria_id() to
--      prevent non-deterministic results if a user ever has
--      multiple memberships.
--
-- Performance budget: tenant guard = 1 read of auth.uid()
--   (~0 ms); system_logs INSERT only fires on failure paths.
--   Happy-path latency impact: < 1 ms.
-- ============================================================


-- ============================================================
-- PART 1: system_logs table
-- ============================================================

CREATE TABLE IF NOT EXISTS system_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT        NOT NULL,
  cafeteria_id UUID        REFERENCES cafeterias(id) ON DELETE SET NULL,
  -- Stored as TEXT, not FK to auth.users, so logs survive account deletion.
  user_id      TEXT,
  payload      JSONB       NOT NULL DEFAULT '{}',
  severity     TEXT        NOT NULL DEFAULT 'INFO'
                           CHECK (severity IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

-- No client-role policies: service_role bypasses RLS and can read the table
-- for dashboard/alerting; no authenticated/anon SELECT or INSERT policy
-- intentionally — only SECURITY DEFINER functions write here.

CREATE INDEX IF NOT EXISTS idx_system_logs_cafeteria_time
  ON system_logs (cafeteria_id, occurred_at DESC)
  WHERE cafeteria_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_system_logs_severity_time
  ON system_logs (severity, occurred_at DESC)
  WHERE severity IN ('ERROR', 'CRITICAL');


-- ============================================================
-- PART 2: Fix get_my_cafeteria_id() — deterministic ORDER BY
-- ============================================================

-- The original LIMIT 1 without ORDER BY is non-deterministic when a user
-- belongs to more than one cafeteria.  Adding ORDER BY created_at ensures
-- consistent results while preserving backward compatibility.
CREATE OR REPLACE FUNCTION get_my_cafeteria_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT cafeteria_id
  FROM   cafeteria_users
  WHERE  user_id = auth.uid()
  ORDER  BY created_at
  LIMIT  1;
$$;


-- ============================================================
-- PART 3: Fix packages_update_admin — explicit WITH CHECK
-- ============================================================

DO $$ BEGIN
  DROP POLICY IF EXISTS packages_update_admin ON packages;
  CREATE POLICY packages_update_admin ON packages
    FOR UPDATE
    TO authenticated
    USING     (cafeteria_id = get_my_cafeteria_id() AND get_my_role() = 'ADMIN')
    WITH CHECK (cafeteria_id = get_my_cafeteria_id());
EXCEPTION WHEN undefined_table THEN NULL;
END $$;


-- ============================================================
-- PRE-DROP: Remove all overloads of functions being replaced here.
-- Prevents "function name not unique" on unqualified REVOKE/GRANT
-- and "cannot change return type" on CREATE OR REPLACE.
-- ============================================================
DROP FUNCTION IF EXISTS create_order_atomic(UUID,DATE,TEXT,TEXT,UUID,TEXT,TEXT,NUMERIC,TEXT,UUID);
DROP FUNCTION IF EXISTS create_order_atomic(UUID,DATE,TEXT,TEXT,UUID,TEXT,TEXT,NUMERIC,TEXT,UUID,DATE,TEXT,BOOLEAN,TEXT);
DROP FUNCTION IF EXISTS create_credit_order_atomic(UUID,DATE,TEXT,TEXT,UUID,TEXT,TEXT,NUMERIC,UUID,DATE);
DROP FUNCTION IF EXISTS create_package_order(UUID,DATE,TEXT,TEXT,UUID,TEXT,NUMERIC,TEXT,UUID);
DROP FUNCTION IF EXISTS get_day_stats(UUID,DATE);
DROP FUNCTION IF EXISTS get_credit_balance(UUID,TEXT);
DROP FUNCTION IF EXISTS add_credits(UUID,TEXT,INTEGER);


-- ============================================================
-- PART 4: Revoke EXECUTE from PUBLIC on mutation functions
-- ============================================================
-- All legitimate callers go through the Node.js backend, which uses
-- the service_role key.  Revoking from PUBLIC prevents authenticated
-- browser clients from calling these RPCs directly.

DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION create_order_atomic        FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION create_credit_order_atomic FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION create_package_order       FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION add_credits                FROM PUBLIC;
  GRANT  EXECUTE ON FUNCTION create_order_atomic        TO service_role;
  GRANT  EXECUTE ON FUNCTION create_credit_order_atomic TO service_role;
  GRANT  EXECUTE ON FUNCTION create_package_order       TO service_role;
  GRANT  EXECUTE ON FUNCTION add_credits                TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;


-- ============================================================
-- PART 5: Hardened create_order_atomic
-- ============================================================
-- Adds (in order):
--   1. Tenant guard — authenticated callers must own p_cafeteria_id.
--   2. Input validation — name length, price >= 0, email format,
--      email required for DIGITAL orders, target_date range.
--   3. system_logs INSERT on CAPACITY_EXCEEDED and security events.

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
  p_sale_type          TEXT    DEFAULT 'SINGLE_SALE'
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

  -- ── Tenant guard ─────────────────────────────────────────────────
  -- auth.uid() is NULL when the caller is service_role — skip check.
  -- For any JWT-authenticated caller, verify they own the target cafeteria.
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

  -- ── Input validation ─────────────────────────────────────────────
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
  -- Email: required for digital orders; validated when provided.
  IF v_channel = 'DIGITAL' AND v_email = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_email is required for digital orders');
  END IF;
  IF v_email != '' AND v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_email format is invalid');
  END IF;
  -- target_date range guard (server-side defence-in-depth).
  IF v_target_date < CURRENT_DATE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'target_date cannot be in the past');
  END IF;
  IF v_target_date > CURRENT_DATE + INTERVAL '7 days' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'target_date cannot be more than 7 days ahead');
  END IF;

  -- ── Capacity check (serialized via FOR UPDATE) ───────────────────
  -- Locks this cafeteria's settings row so concurrent transactions
  -- queue here.  The count + INSERT below happen within the same
  -- snapshot — no gap for overselling.
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
    order_channel, created_by_staff, sale_type
  ) VALUES (
    p_cafeteria_id, p_day_key, v_target_date,
    v_name, v_email, '', '',
    p_menu_id, p_menu_title, p_menu_description, p_menu_price,
    p_payment_method::payment_method_enum,
    'PENDIENTE_DE_PAGO', 'SOLICITADO',
    'PENDIENTE_ENTREGA', 'ACTIVO', p_tracking_token,
    v_channel,
    COALESCE(p_created_by_staff, FALSE),
    COALESCE(p_sale_type,        'SINGLE_SALE')
  )
  RETURNING id INTO v_order_id;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id);
END;
$$;

-- Re-grant after CREATE OR REPLACE resets permissions.
REVOKE EXECUTE ON FUNCTION create_order_atomic FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_order_atomic TO service_role;


-- ============================================================
-- PART 6: Hardened create_credit_order_atomic
-- ============================================================

CREATE OR REPLACE FUNCTION create_credit_order_atomic(
  p_cafeteria_id     UUID,
  p_day_key          DATE,
  p_buyer_name       TEXT,
  p_buyer_email      TEXT,
  p_menu_id          UUID,
  p_menu_title       TEXT,
  p_menu_description TEXT,
  p_menu_price       NUMERIC,
  p_tracking_token   UUID,
  p_target_date      DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_meals   INTEGER;
  v_sold        BIGINT;
  v_remaining   INTEGER;
  v_order_id    UUID;
  v_target_date DATE;
  v_caller_uid  TEXT;
  v_name        TEXT;
  v_email       TEXT;
BEGIN
  v_target_date := COALESCE(p_target_date, p_day_key);
  v_caller_uid  := auth.uid()::TEXT;
  v_name        := TRIM(COALESCE(p_buyer_name, ''));
  v_email       := LOWER(TRIM(COALESCE(p_buyer_email, '')));

  -- ── Tenant guard ─────────────────────────────────────────────────
  IF v_caller_uid IS NOT NULL
     AND p_cafeteria_id IS DISTINCT FROM get_my_cafeteria_id()
  THEN
    INSERT INTO system_logs (event_type, cafeteria_id, user_id, payload, severity)
    VALUES (
      'CROSS_TENANT_WRITE_ATTEMPT',
      p_cafeteria_id,
      v_caller_uid,
      jsonb_build_object(
        'fn',            'create_credit_order_atomic',
        'supplied_cafe', p_cafeteria_id,
        'actual_cafe',   get_my_cafeteria_id()
      ),
      'CRITICAL'
    );
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  -- ── Input validation ─────────────────────────────────────────────
  IF v_name = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_name is required');
  END IF;
  IF LENGTH(v_name) > 100 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_name exceeds 100 characters');
  END IF;
  IF v_email = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_email is required for credit orders');
  END IF;
  IF v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_email format is invalid');
  END IF;
  IF p_menu_price < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'menu_price cannot be negative');
  END IF;
  IF v_target_date < CURRENT_DATE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'target_date cannot be in the past');
  END IF;
  IF v_target_date > CURRENT_DATE + INTERVAL '7 days' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'target_date cannot be more than 7 days ahead');
  END IF;

  -- ── Capacity check ───────────────────────────────────────────────
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
        'fn',          'create_credit_order_atomic',
        'target_date', v_target_date,
        'sold',        v_sold,
        'max_meals',   v_max_meals,
        'buyer_email', v_email
      ),
      'WARN'
    );
    RETURN jsonb_build_object(
      'ok',      false,
      'error',   'CAPACITY_EXCEEDED',
      'message', 'No hay almuerzos disponibles para esa fecha.'
    );
  END IF;

  -- ── Credit balance check + decrement (serialized) ────────────────
  SELECT remaining_meals INTO v_remaining
  FROM   user_credits
  WHERE  cafeteria_id = p_cafeteria_id
    AND  user_email   = v_email
  FOR UPDATE;

  IF NOT FOUND OR v_remaining IS NULL OR v_remaining <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NO_CREDITS');
  END IF;

  UPDATE user_credits
  SET    remaining_meals = remaining_meals - 1,
         updated_at      = NOW()
  WHERE  cafeteria_id = p_cafeteria_id
    AND  user_email   = v_email;

  INSERT INTO orders (
    cafeteria_id,  day_key,   target_date,
    buyer_name,    buyer_email, buyer_id, buyer_phone,
    menu_id,       menu_title, menu_description, menu_price,
    payment_method, payment_status, order_status,
    delivery_status, record_status,  tracking_token,
    order_channel, created_by_staff, sale_type
  ) VALUES (
    p_cafeteria_id, p_day_key, v_target_date,
    v_name, v_email, '', '',
    p_menu_id, p_menu_title, p_menu_description, p_menu_price,
    'CREDITO', 'CONFIRMADO', 'SOLICITADO',
    'PENDIENTE_ENTREGA', 'ACTIVO', p_tracking_token,
    'DIGITAL', FALSE, 'CREDIT_REDEMPTION'
  )
  RETURNING id INTO v_order_id;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION create_credit_order_atomic FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_credit_order_atomic TO service_role;


-- ============================================================
-- PART 7: Hardened create_package_order
-- ============================================================

CREATE OR REPLACE FUNCTION create_package_order(
  p_cafeteria_id   UUID,
  p_day_key        DATE,
  p_buyer_name     TEXT,
  p_buyer_email    TEXT,
  p_package_id     UUID,
  p_package_title  TEXT,
  p_package_price  NUMERIC,
  p_payment_method TEXT,
  p_tracking_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id    UUID;
  v_caller_uid  TEXT;
  v_name        TEXT;
  v_email       TEXT;
BEGIN
  v_caller_uid := auth.uid()::TEXT;
  v_name       := TRIM(COALESCE(p_buyer_name, ''));
  v_email      := LOWER(TRIM(COALESCE(p_buyer_email, '')));

  -- ── Tenant guard ─────────────────────────────────────────────────
  IF v_caller_uid IS NOT NULL
     AND p_cafeteria_id IS DISTINCT FROM get_my_cafeteria_id()
  THEN
    INSERT INTO system_logs (event_type, cafeteria_id, user_id, payload, severity)
    VALUES (
      'CROSS_TENANT_WRITE_ATTEMPT',
      p_cafeteria_id,
      v_caller_uid,
      jsonb_build_object(
        'fn',            'create_package_order',
        'supplied_cafe', p_cafeteria_id,
        'actual_cafe',   get_my_cafeteria_id()
      ),
      'CRITICAL'
    );
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  -- ── Input validation ─────────────────────────────────────────────
  IF v_name = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_name is required');
  END IF;
  IF LENGTH(v_name) > 100 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_name exceeds 100 characters');
  END IF;
  IF v_email = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_email is required for package orders');
  END IF;
  IF v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'buyer_email format is invalid');
  END IF;
  IF p_package_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_INPUT',
                               'detail', 'package_price must be greater than zero');
  END IF;

  INSERT INTO orders (
    cafeteria_id,  day_key,   target_date,
    buyer_name,    buyer_email, buyer_id, buyer_phone,
    menu_id,       menu_title, menu_description, menu_price,
    payment_method, payment_status, order_status,
    delivery_status, record_status,  tracking_token,
    order_channel, created_by_staff, sale_type, package_id
  ) VALUES (
    p_cafeteria_id, p_day_key, p_day_key,
    v_name, v_email, '', '',
    NULL, p_package_title, NULL, p_package_price,
    p_payment_method::payment_method_enum,
    'PENDIENTE_DE_PAGO', 'SOLICITADO',
    'PENDIENTE_ENTREGA', 'ACTIVO', p_tracking_token,
    'DIGITAL', FALSE, 'PACKAGE_SALE', p_package_id
  )
  RETURNING id INTO v_order_id;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION create_package_order FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_package_order TO service_role;


-- ============================================================
-- PART 8: Hardened get_day_stats — tenant guard
-- ============================================================
-- Converted from LANGUAGE sql to plpgsql to add the IF tenant check.
-- Returns an empty row set for authenticated callers requesting a
-- foreign cafeteria_id instead of raising an error, to avoid leaking
-- the existence of other tenants.

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
  -- Tenant guard: silently return empty set for cross-tenant probes.
  IF auth.uid() IS NOT NULL
     AND p_cafeteria_id IS DISTINCT FROM get_my_cafeteria_id()
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*)                                                                           AS total_orders,
    COUNT(*) FILTER (WHERE payment_status IN ('PAGADO','CONFIRMADO','CONFIRMADO_SINPE')) AS paid_orders,
    COUNT(*) FILTER (WHERE payment_status NOT IN ('PAGADO','CONFIRMADO','CONFIRMADO_SINPE')) AS pending_payment,
    COUNT(*) FILTER (WHERE delivery_status = 'ENTREGADO')                              AS delivered_orders,
    COUNT(*) FILTER (WHERE delivery_status != 'ENTREGADO')                             AS pending_deliveries,
    COUNT(*) FILTER (
      WHERE payment_status IN ('PAGADO','CONFIRMADO','CONFIRMADO_SINPE')
        AND delivery_status != 'ENTREGADO'
    )                                                                                  AS paid_pending_delivery,
    COUNT(*) FILTER (WHERE payment_method = 'SINPE')                                   AS sinpe_count,
    COUNT(*) FILTER (WHERE payment_method = 'EFECTIVO')                                AS cash_count,
    COALESCE(SUM(menu_price), 0)                                                       AS total_amount,
    COUNT(*) FILTER (WHERE order_channel = 'DIGITAL')                                  AS digital_count,
    COUNT(*) FILTER (WHERE order_channel = 'WALK_IN')                                  AS walk_in_count
  FROM orders
  WHERE cafeteria_id = p_cafeteria_id
    AND target_date   = p_day_key
    AND record_status = 'ACTIVO'
    AND sale_type    != 'PACKAGE_SALE';
END;
$$;


-- ============================================================
-- PART 9: Hardened get_credit_balance — tenant guard
-- ============================================================

CREATE OR REPLACE FUNCTION get_credit_balance(
  p_cafeteria_id UUID,
  p_user_email   TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  -- Tenant guard.
  IF auth.uid() IS NOT NULL
     AND p_cafeteria_id IS DISTINCT FROM get_my_cafeteria_id()
  THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(remaining_meals, 0) INTO v_balance
  FROM   user_credits
  WHERE  cafeteria_id = p_cafeteria_id
    AND  user_email   = LOWER(TRIM(p_user_email));

  RETURN COALESCE(v_balance, 0);
END;
$$;


-- ============================================================
-- PART 10: Hardened add_credits — tenant guard
-- ============================================================

CREATE OR REPLACE FUNCTION add_credits(
  p_cafeteria_id UUID,
  p_user_email   TEXT,
  p_credits      INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid TEXT;
BEGIN
  v_caller_uid := auth.uid()::TEXT;

  -- Tenant guard.
  IF v_caller_uid IS NOT NULL
     AND p_cafeteria_id IS DISTINCT FROM get_my_cafeteria_id()
  THEN
    INSERT INTO system_logs (event_type, cafeteria_id, user_id, payload, severity)
    VALUES (
      'CROSS_TENANT_WRITE_ATTEMPT',
      p_cafeteria_id,
      v_caller_uid,
      jsonb_build_object('fn', 'add_credits', 'supplied_cafe', p_cafeteria_id),
      'CRITICAL'
    );
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  IF p_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_INPUT: credits must be greater than zero';
  END IF;

  IF LOWER(TRIM(COALESCE(p_user_email, ''))) = '' THEN
    RAISE EXCEPTION 'INVALID_INPUT: user_email is required';
  END IF;

  INSERT INTO user_credits (cafeteria_id, user_email, remaining_meals)
  VALUES (p_cafeteria_id, LOWER(TRIM(p_user_email)), p_credits)
  ON CONFLICT (cafeteria_id, user_email)
  DO UPDATE SET
    remaining_meals = user_credits.remaining_meals + p_credits,
    updated_at      = NOW();
END;
$$;

REVOKE EXECUTE ON FUNCTION add_credits FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION add_credits TO service_role;
