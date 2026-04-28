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
