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
