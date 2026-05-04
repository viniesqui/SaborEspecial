-- ============================================================
-- SaborEspecial — Combined Database Schema
-- Generated from supabase/migrations/ (001 → 015)
-- Paste this entire file into the Supabase SQL Editor once.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 001_multi_tenant_schema.sql
-- ────────────────────────────────────────────────────────────
-- ============================================================
-- SaborEspecial: Multi-Tenant Supabase Migration
-- Target: Supabase SQL Editor or supabase db push
-- Timezone: America/Costa_Rica (UTC-6)
-- ============================================================


-- ============================================================
-- SECTION 1: Custom ENUM Types
-- ============================================================

CREATE TYPE payment_method_enum AS ENUM (
  'SINPE',
  'EFECTIVO'
);

CREATE TYPE payment_status_enum AS ENUM (
  'PENDIENTE_DE_PAGO',
  'PAGADO',
  'CONFIRMADO',
  'CONFIRMADO_SINPE',
  'POR_VERIFICAR'
);

CREATE TYPE order_status_enum AS ENUM (
  'SOLICITADO'
);

CREATE TYPE delivery_status_enum AS ENUM (
  'PENDIENTE_ENTREGA',
  'ENTREGADO'
);

CREATE TYPE record_status_enum AS ENUM (
  'ACTIVO',
  'CANCELADO'
);

CREATE TYPE user_role_enum AS ENUM (
  'ADMIN',
  'HELPER'
);


-- ============================================================
-- SECTION 2: Core Tables
-- ============================================================

-- 2.1 Cafeterias — one row per SaaS tenant
CREATE TABLE cafeterias (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL UNIQUE,  -- used in URL routing, e.g. "ceep"
  timezone    TEXT        NOT NULL DEFAULT 'America/Costa_Rica',
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.2 Cafeteria Users — maps auth.uid() to cafeteria_id + role (anchor for all RLS)
CREATE TABLE cafeteria_users (
  id            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  cafeteria_id  UUID           NOT NULL REFERENCES cafeterias(id) ON DELETE CASCADE,
  user_id       UUID           NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role          user_role_enum NOT NULL DEFAULT 'HELPER',
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (cafeteria_id, user_id)
);

-- 2.3 Settings — one row per cafeteria, replaces MongoDB "app_config" document
CREATE TABLE settings (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  cafeteria_id         UUID         NOT NULL UNIQUE REFERENCES cafeterias(id) ON DELETE CASCADE,
  max_meals            INTEGER      NOT NULL DEFAULT 15 CHECK (max_meals > 0),
  sales_start          TIME         NOT NULL DEFAULT '10:00',
  sales_end            TIME         NOT NULL DEFAULT '12:00',
  delivery_window      TEXT         NOT NULL DEFAULT '12:00 - 12:30',
  disable_sales_window BOOLEAN      NOT NULL DEFAULT FALSE,
  message              TEXT         NOT NULL DEFAULT 'Venta maxima de 15 almuerzos por dia.',
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 2.4 Menus — one active menu per cafeteria per day
-- UNIQUE(cafeteria_id, day_key) enforces the single-menu-per-day constraint
-- that was previously managed in application code via upsert.
CREATE TABLE menus (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  cafeteria_id  UUID          NOT NULL REFERENCES cafeterias(id) ON DELETE CASCADE,
  day_key       DATE          NOT NULL,  -- replaces the MongoDB dayKey string (YYYY-MM-DD)
  title         TEXT          NOT NULL,
  description   TEXT          NOT NULL DEFAULT '',
  price         NUMERIC(10,2) NOT NULL DEFAULT 1000.00 CHECK (price >= 0),
  active        BOOLEAN       NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (cafeteria_id, day_key)
);

-- 2.5 Orders — full payment and delivery lifecycle
-- menu_title/menu_description/menu_price are denormalized snapshots so
-- historical orders remain accurate if the menu is later edited.
CREATE TABLE orders (
  id                    UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  cafeteria_id          UUID                 NOT NULL REFERENCES cafeterias(id) ON DELETE CASCADE,
  day_key               DATE                 NOT NULL,
  -- Buyer info
  buyer_name            TEXT                 NOT NULL,
  buyer_id              TEXT                 NOT NULL DEFAULT '',
  buyer_phone           TEXT                 NOT NULL DEFAULT '',
  -- Menu snapshot at time of order
  menu_id               UUID                 REFERENCES menus(id),
  menu_title            TEXT                 NOT NULL DEFAULT 'Menu no configurado',
  menu_description      TEXT                 NOT NULL DEFAULT '',
  menu_price            NUMERIC(10,2)        NOT NULL DEFAULT 1000.00,
  -- Payment (supports the SINPE manual verification workflow)
  payment_method        payment_method_enum  NOT NULL,
  payment_status        payment_status_enum  NOT NULL DEFAULT 'PENDIENTE_DE_PAGO',
  payment_reference     TEXT                 NOT NULL DEFAULT '',  -- SINPE confirmation code
  payment_confirmed_at  TIMESTAMPTZ,
  -- Order and delivery lifecycle
  order_status          order_status_enum    NOT NULL DEFAULT 'SOLICITADO',
  delivery_status       delivery_status_enum NOT NULL DEFAULT 'PENDIENTE_ENTREGA',
  delivered_at          TIMESTAMPTZ,
  record_status         record_status_enum   NOT NULL DEFAULT 'ACTIVO',
  notes                 TEXT                 NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ          NOT NULL DEFAULT NOW()
);

-- 2.6 Delivery Events — audit log for delivery status transitions
CREATE TABLE delivery_events (
  id               UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  cafeteria_id     UUID                 NOT NULL REFERENCES cafeterias(id) ON DELETE CASCADE,
  order_id         UUID                 NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  day_key          DATE                 NOT NULL,
  delivery_status  delivery_status_enum NOT NULL,
  created_at       TIMESTAMPTZ          NOT NULL DEFAULT NOW()
);


-- ============================================================
-- SECTION 3: Indexes
-- ============================================================

-- Primary query pattern: today's active orders for a cafeteria
CREATE INDEX idx_orders_cafeteria_day
  ON orders (cafeteria_id, day_key);

-- Date-range queries: CSV export, sales history
CREATE INDEX idx_orders_cafeteria_created
  ON orders (cafeteria_id, created_at DESC);

-- Admin dashboard: pending payment review
CREATE INDEX idx_orders_payment_status
  ON orders (cafeteria_id, payment_status)
  WHERE record_status = 'ACTIVO';

-- Kitchen/delivery dashboard: pending deliveries
CREATE INDEX idx_orders_delivery_status
  ON orders (cafeteria_id, delivery_status)
  WHERE record_status = 'ACTIVO';

-- Daily menu lookup
CREATE INDEX idx_menus_cafeteria_day
  ON menus (cafeteria_id, day_key);

-- Audit log lookups by order
CREATE INDEX idx_delivery_events_order
  ON delivery_events (order_id, created_at DESC);

-- Delivery events by day for a cafeteria
CREATE INDEX idx_delivery_events_cafeteria
  ON delivery_events (cafeteria_id, day_key);

-- Critical path for all RLS helper function calls
CREATE INDEX idx_cafeteria_users_user_id
  ON cafeteria_users (user_id);


-- ============================================================
-- SECTION 4: updated_at Auto-Update Trigger
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cafeterias_updated_at
  BEFORE UPDATE ON cafeterias
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_settings_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_menus_updated_at
  BEFORE UPDATE ON menus
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- SECTION 5: RLS Helper Functions
-- ============================================================

-- Returns the cafeteria_id for the currently authenticated user.
-- SECURITY DEFINER bypasses RLS on cafeteria_users.
-- SET search_path = public prevents search path injection attacks.
CREATE OR REPLACE FUNCTION get_my_cafeteria_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT cafeteria_id
  FROM cafeteria_users
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

-- Returns the role ('ADMIN' or 'HELPER') of the current user within their cafeteria.
CREATE OR REPLACE FUNCTION get_my_role()
RETURNS user_role_enum
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role
  FROM cafeteria_users
  WHERE user_id       = auth.uid()
    AND cafeteria_id  = get_my_cafeteria_id()
  LIMIT 1;
$$;


-- ============================================================
-- SECTION 6: Enable Row-Level Security
-- ============================================================

ALTER TABLE cafeterias       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cafeteria_users  ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE menus            ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_events  ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- SECTION 7: RLS Policies
-- ============================================================

-- ---- cafeterias ----
-- Authenticated staff can view only their own cafeteria's record.
-- INSERT/UPDATE is reserved for the service_role key (server-side provisioning).
CREATE POLICY "cafeterias_select_own"
  ON cafeterias FOR SELECT
  TO authenticated
  USING (id = get_my_cafeteria_id());

-- ---- cafeteria_users ----
-- Users can see only their own membership row.
-- INSERT/UPDATE/DELETE is reserved for the service_role key.
CREATE POLICY "cafeteria_users_select_own"
  ON cafeteria_users FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ---- settings ----
CREATE POLICY "settings_select_own"
  ON settings FOR SELECT
  TO authenticated
  USING (cafeteria_id = get_my_cafeteria_id());

-- Only ADMIN can change cafeteria settings.
CREATE POLICY "settings_update_admin"
  ON settings FOR UPDATE
  TO authenticated
  USING (
    cafeteria_id = get_my_cafeteria_id()
    AND get_my_role() = 'ADMIN'
  )
  WITH CHECK (cafeteria_id = get_my_cafeteria_id());

-- ---- menus ----
CREATE POLICY "menus_select_own"
  ON menus FOR SELECT
  TO authenticated
  USING (cafeteria_id = get_my_cafeteria_id());

-- ADMIN and HELPER can manage menus (matches existing HELPER_PASSWORD access).
CREATE POLICY "menus_insert_staff"
  ON menus FOR INSERT
  TO authenticated
  WITH CHECK (cafeteria_id = get_my_cafeteria_id());

CREATE POLICY "menus_update_staff"
  ON menus FOR UPDATE
  TO authenticated
  USING  (cafeteria_id = get_my_cafeteria_id())
  WITH CHECK (cafeteria_id = get_my_cafeteria_id());

-- ---- orders ----
CREATE POLICY "orders_select_own"
  ON orders FOR SELECT
  TO authenticated
  USING (cafeteria_id = get_my_cafeteria_id());

CREATE POLICY "orders_insert_staff"
  ON orders FOR INSERT
  TO authenticated
  WITH CHECK (cafeteria_id = get_my_cafeteria_id());

-- All staff can update orders (delivery and payment status).
-- Payment-confirmation restriction (ADMIN only) is enforced at the API layer.
CREATE POLICY "orders_update_staff"
  ON orders FOR UPDATE
  TO authenticated
  USING  (cafeteria_id = get_my_cafeteria_id())
  WITH CHECK (cafeteria_id = get_my_cafeteria_id());

-- No DELETE policy: cancellations are soft-deletes (record_status = 'CANCELADO').

-- ---- delivery_events ----
CREATE POLICY "delivery_events_select_own"
  ON delivery_events FOR SELECT
  TO authenticated
  USING (cafeteria_id = get_my_cafeteria_id());

CREATE POLICY "delivery_events_insert_staff"
  ON delivery_events FOR INSERT
  TO authenticated
  WITH CHECK (cafeteria_id = get_my_cafeteria_id());


-- ============================================================
-- SECTION 8: Seed Data — Bootstrap CEEP Tenant
-- ============================================================
-- Uncomment and run AFTER creating the admin user in Supabase Auth.
-- Replace <ADMIN_USER_UUID> with the value from auth.users.id.

-- INSERT INTO cafeterias (name, slug, timezone)
-- VALUES ('CEEP', 'ceep', 'America/Costa_Rica');

-- INSERT INTO cafeteria_users (cafeteria_id, user_id, role)
-- VALUES (
--   (SELECT id FROM cafeterias WHERE slug = 'ceep'),
--   '<ADMIN_USER_UUID>',
--   'ADMIN'
-- );

-- INSERT INTO settings (cafeteria_id)
-- VALUES ((SELECT id FROM cafeterias WHERE slug = 'ceep'));
-- All columns default: max_meals=15, sales_start='10:00', sales_end='12:00', etc.

-- ────────────────────────────────────────────────────────────
-- 002_add_orders_role.sql
-- ────────────────────────────────────────────────────────────
-- Add ORDERS role to user_role_enum for delivery-only staff members.
-- Must run after migration 001 which created the enum.
ALTER TYPE user_role_enum ADD VALUE 'ORDERS';

-- ────────────────────────────────────────────────────────────
-- 003_add_buyer_email.sql
-- ────────────────────────────────────────────────────────────
-- Add buyer_email to orders so no-login buyers receive status notification emails.
ALTER TABLE orders
  ADD COLUMN buyer_email TEXT NOT NULL DEFAULT '';

-- ────────────────────────────────────────────────────────────
-- 004_analytics_views.sql
-- ────────────────────────────────────────────────────────────
-- ============================================================
-- SaborEspecial: Analytics Views
-- Creates four read-only views for the Admin Insights tab.
-- Each view exposes cafeteria_id so the API layer can apply
-- per-tenant filtering before returning data to the browser.
--
-- Performance notes:
--   - v_daily_prep_list   → uses idx_orders_cafeteria_day
--   - v_demand_forecast   → uses idx_orders_cafeteria_day (range)
--   - v_peak_hour_heatmap → uses idx_orders_cafeteria_day (range)
--   - v_weekly_summary    → uses idx_orders_cafeteria_day (range)
--
-- All views are simple (non-materialized) so the query planner
-- can push the cafeteria_id predicate into the base scan.
-- ============================================================


-- ----------------------------------------------------------------
-- VIEW 1: v_daily_prep_list
-- Answers: "How many portions of each menu item do I need to
-- prepare right now?"  Groups today's active orders by menu_title
-- (denormalized snapshot) and breaks them down by payment state
-- and payment method so the cook knows exactly what to make.
-- ----------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_prep_list AS
SELECT
  cafeteria_id,
  day_key,
  menu_title,
  COUNT(*)                                                                AS total_portions,
  COUNT(*) FILTER (
    WHERE payment_status IN ('PAGADO', 'CONFIRMADO', 'CONFIRMADO_SINPE')
  )                                                                       AS confirmed_portions,
  COUNT(*) FILTER (
    WHERE payment_status NOT IN ('PAGADO', 'CONFIRMADO', 'CONFIRMADO_SINPE')
  )                                                                       AS pending_portions,
  COUNT(*) FILTER (WHERE payment_method = 'SINPE')                       AS sinpe_count,
  COUNT(*) FILTER (WHERE payment_method = 'EFECTIVO')                    AS cash_count
FROM orders
WHERE record_status = 'ACTIVO'
GROUP BY cafeteria_id, day_key, menu_title;


-- ----------------------------------------------------------------
-- VIEW 2: v_demand_forecast
-- Answers: "Based on history, how many meals should I authorize
-- for this day of the week?"
--
-- Aggregates completed days (day_key < CURRENT_DATE) over the last
-- 56 days, grouped by day-of-week (0 = Sunday … 6 = Saturday).
-- Excludes today so partial data does not skew the average.
-- ----------------------------------------------------------------
CREATE OR REPLACE VIEW v_demand_forecast AS
SELECT
  cafeteria_id,
  EXTRACT(DOW FROM day_key)::SMALLINT  AS day_of_week,
  ROUND(AVG(daily_count), 1)           AS avg_orders,
  MAX(daily_count)                      AS max_orders,
  MIN(daily_count)                      AS min_orders,
  COUNT(DISTINCT day_key)               AS sample_days
FROM (
  SELECT
    cafeteria_id,
    day_key,
    COUNT(*) AS daily_count
  FROM orders
  WHERE record_status = 'ACTIVO'
    AND day_key >= CURRENT_DATE - INTERVAL '56 days'
    AND day_key  < CURRENT_DATE
  GROUP BY cafeteria_id, day_key
) daily_totals
GROUP BY cafeteria_id, EXTRACT(DOW FROM day_key)::SMALLINT;


-- ----------------------------------------------------------------
-- VIEW 3: v_peak_hour_heatmap
-- Answers: "When do orders typically arrive so I can plan deep
-- prep work vs. active order-taking windows?"
--
-- Groups active orders from the last 28 days by hour-of-day in
-- Costa Rica local time. avg_per_day smooths out day count
-- differences so hours are fairly comparable.
-- ----------------------------------------------------------------
CREATE OR REPLACE VIEW v_peak_hour_heatmap AS
SELECT
  cafeteria_id,
  EXTRACT(
    HOUR FROM (created_at AT TIME ZONE 'America/Costa_Rica')
  )::SMALLINT                                                             AS hour_of_day,
  COUNT(*)                                                                AS order_count,
  COUNT(DISTINCT day_key)                                                 AS distinct_days,
  ROUND(
    COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT day_key), 0),
    2
  )                                                                       AS avg_per_day
FROM orders
WHERE record_status = 'ACTIVO'
  AND day_key >= CURRENT_DATE - INTERVAL '28 days'
GROUP BY
  cafeteria_id,
  EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/Costa_Rica'))::SMALLINT;


-- ----------------------------------------------------------------
-- VIEW 4: v_weekly_summary
-- Answers: "What were my revenues, payment method split, and
-- cancellation rate for each of the past eight weeks?"
--
-- Week buckets use date_trunc('week', day_key) which starts on
-- Monday (ISO default in PostgreSQL).
-- ----------------------------------------------------------------
CREATE OR REPLACE VIEW v_weekly_summary AS
SELECT
  cafeteria_id,
  date_trunc('week', day_key)::DATE                                       AS week_start,
  COUNT(*) FILTER (WHERE record_status = 'ACTIVO')                       AS total_orders,
  COUNT(*) FILTER (WHERE record_status = 'CANCELADO')                    AS cancelled_orders,
  COALESCE(
    ROUND(SUM(menu_price) FILTER (WHERE record_status = 'ACTIVO'), 0),
    0
  )                                                                       AS total_revenue,
  COALESCE(
    ROUND(SUM(menu_price) FILTER (
      WHERE record_status = 'ACTIVO' AND payment_method = 'SINPE'
    ), 0),
    0
  )                                                                       AS sinpe_revenue,
  COALESCE(
    ROUND(SUM(menu_price) FILTER (
      WHERE record_status = 'ACTIVO' AND payment_method = 'EFECTIVO'
    ), 0),
    0
  )                                                                       AS cash_revenue,
  COUNT(*) FILTER (
    WHERE record_status = 'ACTIVO' AND payment_method = 'SINPE'
  )                                                                       AS sinpe_count,
  COUNT(*) FILTER (
    WHERE record_status = 'ACTIVO' AND payment_method = 'EFECTIVO'
  )                                                                       AS cash_count,
  ROUND(
    COUNT(*) FILTER (WHERE record_status = 'CANCELADO') * 100.0
    / NULLIF(COUNT(*), 0),
    1
  )                                                                       AS cancellation_rate_pct
FROM orders
WHERE day_key >= CURRENT_DATE - INTERVAL '56 days'
GROUP BY cafeteria_id, date_trunc('week', day_key)::DATE;

-- ────────────────────────────────────────────────────────────
-- 005_onboarding_trigger.sql
-- ────────────────────────────────────────────────────────────
-- ============================================================
-- SaborEspecial: Zero-Touch Onboarding Trigger
-- Automatically provisions a cafeteria, admin user mapping,
-- and default settings when a new user signs up via Supabase Auth.
--
-- Run this in the Supabase Dashboard SQL Editor (requires
-- superuser access to auth.users; do NOT use supabase db push).
-- ============================================================


-- ---------------------------------------------------------------
-- Helper: derive a URL-safe slug from an arbitrary string.
-- Lowercase, strip non-alphanumeric/space/hyphen, collapse runs
-- of whitespace and hyphens into a single hyphen.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.slugify(source TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT regexp_replace(
    regexp_replace(
      lower(trim(source)),
      '[^a-z0-9\s\-]', '', 'g'
    ),
    '[\s\-]+', '-', 'g'
  );
$$;


-- ---------------------------------------------------------------
-- Main trigger function: handle_new_user()
--
-- Called AFTER INSERT on auth.users.
-- Reads raw_user_meta_data->>'cafeteria_name' if supplied
-- during signUp({ options: { data: { cafeteria_name: "..." } } }).
-- Falls back to the email prefix before '@'.
--
-- All three INSERTs use ON CONFLICT DO NOTHING for idempotency
-- so the trigger is safe to replay or re-run on migrations.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cafeteria_name  TEXT;
  v_base_slug       TEXT;
  v_slug            TEXT;
  v_suffix          INT := 0;
  v_cafeteria_id    UUID;
BEGIN
  -- 1. Derive cafeteria name from signup metadata or email prefix
  v_cafeteria_name := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data->>'cafeteria_name'), ''),
    split_part(NEW.email, '@', 1)
  );

  -- 2. Derive a unique URL slug with numeric suffix on collision
  v_base_slug := public.slugify(v_cafeteria_name);

  -- Guard: if slug is empty after sanitising (e.g. pure unicode), use uid prefix
  IF v_base_slug IS NULL OR v_base_slug = '' THEN
    v_base_slug := 'cafeteria-' || left(NEW.id::TEXT, 8);
  END IF;

  v_slug := v_base_slug;
  LOOP
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.cafeterias WHERE slug = v_slug);
    v_suffix := v_suffix + 1;
    v_slug   := v_base_slug || '-' || v_suffix;
  END LOOP;

  -- 3. Create the cafeteria row (skip if this user already has one)
  INSERT INTO public.cafeterias (name, slug, timezone)
  VALUES (v_cafeteria_name, v_slug, 'America/Costa_Rica')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_cafeteria_id;

  -- If the INSERT was skipped by ON CONFLICT, fetch the existing cafeteria
  IF v_cafeteria_id IS NULL THEN
    SELECT cafeteria_id INTO v_cafeteria_id
    FROM public.cafeteria_users
    WHERE user_id = NEW.id
    LIMIT 1;
  END IF;

  -- If still null (shouldn't happen in normal flow), exit cleanly
  IF v_cafeteria_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 4. Assign ADMIN role to the new user
  INSERT INTO public.cafeteria_users (cafeteria_id, user_id, role)
  VALUES (v_cafeteria_id, NEW.id, 'ADMIN')
  ON CONFLICT (cafeteria_id, user_id) DO NOTHING;

  -- 5. Create default settings row
  -- Defaults: max_meals=15, sales_start='10:00', sales_end='12:00', etc.
  INSERT INTO public.settings (cafeteria_id)
  VALUES (v_cafeteria_id)
  ON CONFLICT (cafeteria_id) DO NOTHING;

  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------
-- Wire the trigger to auth.users
-- DROP + CREATE ensures this migration is idempotent.
-- ---------------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ────────────────────────────────────────────────────────────
-- 006_extend_delivery_status.sql
-- ────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────
-- 007_atomic_order_create.sql
-- ────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────
-- 008_error_logs.sql
-- ────────────────────────────────────────────────────────────
-- Frontend error capture table.
-- The anon role can INSERT rows (write-only); no row can ever be read or
-- modified through the public API, keeping the log tamper-proof.

CREATE TABLE IF NOT EXISTS error_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_url    text,
  message     text        NOT NULL,
  stack       text,
  user_agent  text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;

-- Authenticated service-role queries bypass RLS; no extra policy needed for
-- admins reading the table from the Supabase dashboard.
CREATE POLICY "anon_insert_errors"
  ON error_logs
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- ────────────────────────────────────────────────────────────
-- 009_payment_verification_audit.sql
-- ────────────────────────────────────────────────────────────
-- Seamless Loop: payment verification audit trail and kitchen status timestamps.
--
-- payment_verified_by  → which staff member confirmed the SINPE payment
-- prepared_at          → when the kitchen clicked "En Preparación"
-- ready_at             → when the kitchen clicked "Listo para Entrega"
--
-- delivered_at already existed; these three fill in the remaining steps so the
-- buyer tracking page can show precise timestamps for every workflow stage.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_verified_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS prepared_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ready_at            TIMESTAMPTZ;

-- Allow the analytics engineer to join auth.users for reporting.
CREATE INDEX IF NOT EXISTS idx_orders_payment_verified_by
  ON orders (payment_verified_by)
  WHERE payment_verified_by IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 010_weekly_scheduling.sql
-- ────────────────────────────────────────────────────────────
-- ============================================================
-- Migration 010: Weekly Menu Scheduling & Advanced Ordering
--
-- Changes:
--   1. settings.cutoff_time  — single daily deadline for same-day orders.
--   2. orders.target_date    — the date the lunch is ordered FOR
--                             (separate from created_at / day_key).
--   3. create_order_atomic   — updated to count capacity by target_date,
--                             accepts the new p_target_date parameter.
--   4. get_day_stats         — updated to filter by target_date instead
--                             of day_key so future pre-orders are counted
--                             correctly toward per-day capacity.
--   5. Index on (cafeteria_id, target_date) for kitchen view queries.
-- ============================================================


-- ── 1. settings: add cutoff_time ─────────────────────────────
-- Orders for today are blocked once the current CR time passes this value.
-- Default 09:00 gives the kitchen one hour before a typical 10:00 prep start.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS cutoff_time TIME NOT NULL DEFAULT '09:00';


-- ── 2. orders: add target_date ───────────────────────────────
-- Nullable first so existing rows can be backfilled.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS target_date DATE;

-- Backfill: for all pre-existing orders target_date == day_key (same-day ordering).
UPDATE orders
  SET target_date = day_key
  WHERE target_date IS NULL;

-- Now enforce NOT NULL and set a sensible default for future inserts.
ALTER TABLE orders ALTER COLUMN target_date SET NOT NULL;
ALTER TABLE orders ALTER COLUMN target_date SET DEFAULT CURRENT_DATE;


-- ── 3. Index: orders by target_date ─────────────────────────
-- Kitchen filter ("show tomorrow's prep") and capacity count both use this.

CREATE INDEX IF NOT EXISTS idx_orders_cafeteria_target_date
  ON orders (cafeteria_id, target_date)
  WHERE record_status = 'ACTIVO';


-- ── 4. create_order_atomic (updated) ────────────────────────
-- Now accepts p_target_date and counts capacity per target_date, not day_key.
-- The old signature (without p_target_date) is replaced; existing callers
-- that omit the new parameter get COALESCE(NULL, p_day_key) = p_day_key,
-- so backward-compat is maintained at the SQL level.

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
  p_tracking_token    UUID,
  p_target_date       DATE DEFAULT NULL
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
  -- Use explicit target_date when provided, otherwise fall back to the
  -- creation date (today).  This keeps the function backward-compatible.
  v_target_date := COALESCE(p_target_date, p_day_key);

  -- Serialize concurrent requests: lock this cafeteria's settings row
  -- so the capacity check + INSERT happen atomically.
  SELECT max_meals INTO v_max_meals
  FROM settings
  WHERE cafeteria_id = p_cafeteria_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CAFETERIA_NOT_CONFIGURED');
  END IF;

  -- Capacity is enforced per target_date: each day has its own limit.
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
    delivery_status, record_status, tracking_token
  ) VALUES (
    p_cafeteria_id, p_day_key, v_target_date,
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


-- ── 5. get_day_stats (updated) ───────────────────────────────
-- Filters by target_date so pre-orders placed on previous days are
-- correctly aggregated into the day they are scheduled for.

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
      AS total_amount
  FROM orders
  WHERE cafeteria_id = p_cafeteria_id
    AND target_date   = p_day_key    -- was: day_key = p_day_key
    AND record_status = 'ACTIVO';
$$;

-- ────────────────────────────────────────────────────────────
-- 011_manual_order_channel.sql
-- ────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────
-- 012_meal_packages_credits.sql
-- ────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────
-- 013_cost_accounting.sql
-- ────────────────────────────────────────────────────────────
-- ============================================================
-- Migration 013: Cost Accounting & Business Intelligence
--
-- Adds cost tracking to menus so the owner can enter the
-- estimated cost (ingredients + labor) per dish each day.
-- This data feeds the profitability reports in the admin panel.
-- ============================================================

ALTER TABLE menus
  ADD COLUMN IF NOT EXISTS cost_per_dish NUMERIC(10,2);

-- ────────────────────────────────────────────────────────────
-- 014_security_hardening.sql
-- ────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────
-- 015_plug_and_play_onboarding.sql
-- ────────────────────────────────────────────────────────────
-- ============================================================
-- Migration 015: Plug-and-Play Onboarding Engine
--
-- Enhances the handle_new_user() trigger (first introduced in
-- migration 005) with two additions:
--
--   1. Explicit sane defaults in the settings INSERT so the owner
--      sees correct values even before touching the admin panel:
--      max_meals = 15, cutoff_time = '09:00'.
--
--   2. Weekly menu seed: inserts placeholder menu rows for Mon–Fri
--      of the current week AND the next week (up to 10 rows) so the
--      customer-facing app shows a live, functional weekly grid the
--      moment the owner signs up. All inserts use ON CONFLICT DO
--      NOTHING, making the function fully idempotent.
--
-- Run in the Supabase Dashboard SQL Editor (requires superuser
-- access to auth.users; do NOT use supabase db push).
-- ============================================================


-- ---------------------------------------------------------------
-- Re-create slugify() — idempotent, no behaviour change.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.slugify(source TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT regexp_replace(
    regexp_replace(
      lower(trim(source)),
      '[^a-z0-9\s\-]', '', 'g'
    ),
    '[\s\-]+', '-', 'g'
  );
$$;


-- ---------------------------------------------------------------
-- Enhanced handle_new_user()
--
-- Diff from migration 005:
--   • Settings INSERT is explicit about max_meals and cutoff_time.
--   • After settings, seeds Mon–Fri placeholder menus for the
--     current week and the following week.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cafeteria_name  TEXT;
  v_base_slug       TEXT;
  v_slug            TEXT;
  v_suffix          INT  := 0;
  v_cafeteria_id    UUID;
  v_week_start      DATE;
  v_day             DATE;
  v_week_offset     INT;
  v_day_offset      INT;
BEGIN
  -- 1. Derive cafeteria name from signup metadata or email prefix
  v_cafeteria_name := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data->>'cafeteria_name'), ''),
    split_part(NEW.email, '@', 1)
  );

  -- 2. Build a unique URL-safe slug (numeric suffix on collision)
  v_base_slug := public.slugify(v_cafeteria_name);

  IF v_base_slug IS NULL OR v_base_slug = '' THEN
    v_base_slug := 'cafeteria-' || left(NEW.id::TEXT, 8);
  END IF;

  v_slug := v_base_slug;
  LOOP
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.cafeterias WHERE slug = v_slug);
    v_suffix := v_suffix + 1;
    v_slug   := v_base_slug || '-' || v_suffix;
  END LOOP;

  -- 3. Create the cafeteria row
  INSERT INTO public.cafeterias (name, slug, timezone)
  VALUES (v_cafeteria_name, v_slug, 'America/Costa_Rica')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_cafeteria_id;

  IF v_cafeteria_id IS NULL THEN
    SELECT cafeteria_id INTO v_cafeteria_id
    FROM public.cafeteria_users
    WHERE user_id = NEW.id
    LIMIT 1;
  END IF;

  IF v_cafeteria_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 4. Assign ADMIN role to the signing-up user
  INSERT INTO public.cafeteria_users (cafeteria_id, user_id, role)
  VALUES (v_cafeteria_id, NEW.id, 'ADMIN')
  ON CONFLICT (cafeteria_id, user_id) DO NOTHING;

  -- 5. Create settings with explicit sane defaults
  --    cutoff_time '09:00' gives the kitchen one hour before the
  --    default 10:00 prep window; max_meals = 15 matches the
  --    $10/month tier capacity expectation.
  INSERT INTO public.settings (cafeteria_id, max_meals, cutoff_time, message)
  VALUES (
    v_cafeteria_id,
    15,
    '09:00',
    'Bienvenido a SaborEspecial. Configure su menú semanal desde el panel de administración.'
  )
  ON CONFLICT (cafeteria_id) DO NOTHING;

  -- 6. Seed placeholder menus for Mon–Fri of the current week and
  --    the following week so the owner immediately sees a populated
  --    weekly grid. ON CONFLICT DO NOTHING keeps this idempotent.
  v_week_start := date_trunc('week', CURRENT_DATE)::DATE;  -- Monday (ISO week)

  FOR v_week_offset IN 0..1 LOOP          -- current week, then next week
    FOR v_day_offset IN 0..4 LOOP         -- Monday (0) through Friday (4)
      v_day := v_week_start + (v_week_offset * 7) + v_day_offset;

      INSERT INTO public.menus (cafeteria_id, day_key, title, description, price)
      VALUES (
        v_cafeteria_id,
        v_day,
        'Menú del día',
        'Configure este menú desde el panel de administración.',
        2500.00
      )
      ON CONFLICT (cafeteria_id, day_key) DO NOTHING;
    END LOOP;
  END LOOP;

  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------
-- Re-wire the trigger — idempotent DROP + CREATE.
-- ---------------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();



-- ────────────────────────────────────────────────────────────
-- 016_add_tracking_token_column.sql
-- ────────────────────────────────────────────────────────────
-- ============================================================
-- Migration 016: Add missing tracking_token column to orders
--
-- Background:
--   The orders table was created in migration 001 without a
--   tracking_token column.  Subsequent migrations (007, 010,
--   011, 012, 014) and the application layer (data/orders.repo.js,
--   api/track.js, api/admin-orders.js, api/deliveries.js,
--   data/credits.repo.js, data/packages.repo.js) all reference
--   the column, but no DDL ever added it.  Because
--   create_order_atomic is plpgsql, the missing column is not
--   caught at function-creation time and surfaces only at runtime
--   as: column "tracking_token" of relation "orders" does not exist.
--
-- This migration:
--   1. Adds the column.
--   2. Backfills existing rows with random UUIDs so /track.html
--      links resolve for historical orders.
--   3. Locks in NOT NULL + DEFAULT gen_random_uuid() so future
--      INSERTs that omit the parameter still work.
--   4. Adds a unique index for /track lookups.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tracking_token UUID;

UPDATE orders
   SET tracking_token = gen_random_uuid()
 WHERE tracking_token IS NULL;

ALTER TABLE orders
  ALTER COLUMN tracking_token SET DEFAULT gen_random_uuid(),
  ALTER COLUMN tracking_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tracking_token
  ON orders (tracking_token);
