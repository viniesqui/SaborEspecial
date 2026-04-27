-- ============================================================
-- Migration 012: Meal Packages & Credits System
--
-- Introduces two new features:
--   1. "packages" — owner-defined meal bundles (5-pack, 15-pack…)
--   2. "user_credits" — per-user credit balances tied to an email
--
-- Order flow additions:
--   PACKAGE_SALE    — customer buys a package; admin verifies payment
--                     and the system grants credits (deferred revenue)
--   CREDIT_REDEMPTION — customer redeems a credit instead of paying;
--                       balance is decremented atomically (immediate)
--
-- New atomic SQL functions:
--   create_package_order         — inserts a package-sale order (no cap check)
--   create_credit_order_atomic   — capacity check + credit decrement + INSERT
--   get_credit_balance           — returns remaining_meals for an email
--   add_credits                  — upserts / increments credit balance
--
-- Updated:
--   create_order_atomic  — stores sale_type; excludes PACKAGE_SALE from cap
--   get_day_stats        — excludes PACKAGE_SALE from lunch totals
-- ============================================================


-- ── 1. packages table ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS packages (
  id           UUID          NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cafeteria_id UUID          NOT NULL REFERENCES cafeterias(id) ON DELETE CASCADE,
  title        TEXT          NOT NULL,
  meal_count   INTEGER       NOT NULL CHECK (meal_count > 0),
  price        NUMERIC(10,2) NOT NULL CHECK (price > 0),
  is_active    BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_packages_cafeteria_active
  ON packages (cafeteria_id, is_active);


-- ── 2. user_credits table ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_credits (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cafeteria_id    UUID        NOT NULL REFERENCES cafeterias(id) ON DELETE CASCADE,
  user_email      TEXT        NOT NULL,
  remaining_meals INTEGER     NOT NULL DEFAULT 0 CHECK (remaining_meals >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cafeteria_id, user_email)
);

CREATE INDEX IF NOT EXISTS idx_user_credits_lookup
  ON user_credits (cafeteria_id, user_email);


-- ── 3. Extend payment_method_enum with CREDITO ───────────────
-- ADD VALUE commits immediately; safe to run outside a transaction.

ALTER TYPE payment_method_enum ADD VALUE IF NOT EXISTS 'CREDITO';


-- ── 4. orders: add sale_type ─────────────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'SINGLE_SALE'
  CONSTRAINT orders_sale_type_check
    CHECK (sale_type IN ('SINGLE_SALE', 'PACKAGE_SALE', 'CREDIT_REDEMPTION'));


-- ── 5. orders: add package_id (nullable FK) ──────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS package_id UUID REFERENCES packages(id);


-- ── 6. RLS for packages ───────────────────────────────────────

ALTER TABLE packages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY packages_select_own ON packages FOR SELECT
    USING (cafeteria_id = get_my_cafeteria_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY packages_insert_admin ON packages FOR INSERT
    WITH CHECK (cafeteria_id = get_my_cafeteria_id() AND get_my_role() = 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY packages_update_admin ON packages FOR UPDATE
    USING (cafeteria_id = get_my_cafeteria_id() AND get_my_role() = 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 7. RLS for user_credits ───────────────────────────────────

ALTER TABLE user_credits ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY user_credits_select_own ON user_credits FOR SELECT
    USING (cafeteria_id = get_my_cafeteria_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY user_credits_all_own ON user_credits FOR ALL
    USING (cafeteria_id = get_my_cafeteria_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 8. get_credit_balance ─────────────────────────────────────

CREATE OR REPLACE FUNCTION get_credit_balance(
  p_cafeteria_id UUID,
  p_user_email   TEXT
)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(remaining_meals, 0)
  FROM   user_credits
  WHERE  cafeteria_id = p_cafeteria_id
    AND  user_email   = LOWER(TRIM(p_user_email));
$$;


-- ── 9. add_credits ────────────────────────────────────────────

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
BEGIN
  INSERT INTO user_credits (cafeteria_id, user_email, remaining_meals)
  VALUES (p_cafeteria_id, LOWER(TRIM(p_user_email)), p_credits)
  ON CONFLICT (cafeteria_id, user_email)
  DO UPDATE SET
    remaining_meals = user_credits.remaining_meals + p_credits,
    updated_at      = NOW();
END;
$$;


-- ── 10. create_package_order ──────────────────────────────────
-- Inserts a PACKAGE_SALE order without any capacity check.
-- Capacity is irrelevant here — this is a credit purchase, not a lunch reservation.

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
  v_order_id UUID;
BEGIN
  INSERT INTO orders (
    cafeteria_id,  day_key,   target_date,
    buyer_name,    buyer_email, buyer_id, buyer_phone,
    menu_id,       menu_title, menu_description, menu_price,
    payment_method, payment_status, order_status,
    delivery_status, record_status,  tracking_token,
    order_channel, created_by_staff, sale_type, package_id
  ) VALUES (
    p_cafeteria_id, p_day_key, p_day_key,
    p_buyer_name, LOWER(TRIM(p_buyer_email)), '', '',
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


-- ── 11. create_credit_order_atomic ────────────────────────────
-- Capacity check + credit decrement + INSERT in a single transaction.
-- Payment is auto-confirmed (CONFIRMADO) because it was pre-paid.

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
BEGIN
  v_target_date := COALESCE(p_target_date, p_day_key);

  -- Lock settings row to serialise concurrent capacity checks.
  SELECT max_meals INTO v_max_meals
  FROM   settings
  WHERE  cafeteria_id = p_cafeteria_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CAFETERIA_NOT_CONFIGURED');
  END IF;

  -- Count only SINGLE_SALE and CREDIT_REDEMPTION orders (not package purchases).
  SELECT COUNT(*) INTO v_sold
  FROM   orders
  WHERE  cafeteria_id = p_cafeteria_id
    AND  target_date   = v_target_date
    AND  record_status = 'ACTIVO'
    AND  sale_type    != 'PACKAGE_SALE';

  IF v_sold >= v_max_meals THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CAPACITY_EXCEEDED');
  END IF;

  -- Lock the user's credit row and verify balance.
  SELECT remaining_meals INTO v_remaining
  FROM   user_credits
  WHERE  cafeteria_id = p_cafeteria_id
    AND  user_email   = LOWER(TRIM(p_buyer_email))
  FOR UPDATE;

  IF NOT FOUND OR v_remaining IS NULL OR v_remaining <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NO_CREDITS');
  END IF;

  UPDATE user_credits
  SET    remaining_meals = remaining_meals - 1,
         updated_at      = NOW()
  WHERE  cafeteria_id = p_cafeteria_id
    AND  user_email   = LOWER(TRIM(p_buyer_email));

  -- Insert order — payment already confirmed (pre-paid via package).
  INSERT INTO orders (
    cafeteria_id,  day_key,   target_date,
    buyer_name,    buyer_email, buyer_id, buyer_phone,
    menu_id,       menu_title, menu_description, menu_price,
    payment_method, payment_status, order_status,
    delivery_status, record_status,  tracking_token,
    order_channel, created_by_staff, sale_type
  ) VALUES (
    p_cafeteria_id, p_day_key, v_target_date,
    p_buyer_name, LOWER(TRIM(p_buyer_email)), '', '',
    p_menu_id, p_menu_title, p_menu_description, p_menu_price,
    'CREDITO', 'CONFIRMADO', 'SOLICITADO',
    'PENDIENTE_ENTREGA', 'ACTIVO', p_tracking_token,
    'DIGITAL', FALSE, 'CREDIT_REDEMPTION'
  )
  RETURNING id INTO v_order_id;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id);
END;
$$;


-- ── 12. create_order_atomic (updated) ────────────────────────
-- Adds p_sale_type parameter and excludes PACKAGE_SALE orders
-- from the capacity count.

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
  v_max_meals   INTEGER;
  v_sold        BIGINT;
  v_order_id    UUID;
  v_target_date DATE;
BEGIN
  v_target_date := COALESCE(p_target_date, p_day_key);

  SELECT max_meals INTO v_max_meals
  FROM   settings
  WHERE  cafeteria_id = p_cafeteria_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CAFETERIA_NOT_CONFIGURED');
  END IF;

  -- Exclude PACKAGE_SALE orders; they are credit purchases, not lunch slots.
  SELECT COUNT(*) INTO v_sold
  FROM   orders
  WHERE  cafeteria_id = p_cafeteria_id
    AND  target_date   = v_target_date
    AND  record_status = 'ACTIVO'
    AND  sale_type    != 'PACKAGE_SALE';

  IF v_sold >= v_max_meals THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CAPACITY_EXCEEDED');
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
    p_buyer_name, p_buyer_email, '', '',
    p_menu_id, p_menu_title, p_menu_description, p_menu_price,
    p_payment_method::payment_method_enum,
    'PENDIENTE_DE_PAGO', 'SOLICITADO',
    'PENDIENTE_ENTREGA', 'ACTIVO', p_tracking_token,
    COALESCE(p_order_channel,    'DIGITAL'),
    COALESCE(p_created_by_staff, FALSE),
    COALESCE(p_sale_type,        'SINGLE_SALE')
  )
  RETURNING id INTO v_order_id;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id);
END;
$$;


-- ── 13. get_day_stats (updated) ───────────────────────────────
-- Excludes PACKAGE_SALE orders from lunch totals so daily
-- capacity reporting stays accurate.

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
    AND record_status = 'ACTIVO'
    AND sale_type    != 'PACKAGE_SALE';
$$;
