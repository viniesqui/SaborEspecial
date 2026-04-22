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
