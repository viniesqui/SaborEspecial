-- ============================================================
-- Migration 019: Decouple Staff Invites from Tenant Creation
--
-- Problem solved:
--   Migration 015's handle_new_user() unconditionally creates a
--   new cafeteria for every auth.users INSERT. That makes it
--   impossible to invite a HELPER/ORDERS staff member into an
--   existing cafeteria via Supabase Auth — the trigger would
--   spawn a phantom cafeteria for them.
--
-- This migration teaches the trigger to recognize an "invited
-- staff" signup by inspecting NEW.raw_user_meta_data:
--
--   { "invite_cafeteria_id": "<uuid>", "invite_role": "HELPER" }
--
-- When both keys are present and valid, the trigger:
--   • inserts ONLY a row into cafeteria_users with the invited
--     role, scoped to the invited cafeteria
--   • does NOT create a new cafeteria, settings, or menus
--
-- When the keys are absent, the original "owner self-signup"
-- path runs unchanged (cafeteria + ADMIN + settings + menus).
--
-- Idempotent: CREATE OR REPLACE; trigger is dropped + recreated.
--
-- Run in the Supabase Dashboard SQL Editor.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite_cafeteria_id UUID;
  v_invite_role         TEXT;
  v_cafeteria_exists    BOOLEAN;
  v_cafeteria_name      TEXT;
  v_base_slug           TEXT;
  v_slug                TEXT;
  v_suffix              INT  := 0;
  v_cafeteria_id        UUID;
  v_week_start          DATE;
  v_day                 DATE;
  v_week_offset         INT;
  v_day_offset          INT;
BEGIN
  -- ───────────────────────────────────────────────────────────
  -- BRANCH A: Invited staff signup
  -- ───────────────────────────────────────────────────────────
  -- The inviter (an ADMIN) issues an invite link with metadata:
  --   { invite_cafeteria_id: <uuid>, invite_role: 'HELPER'|'ORDERS' }
  -- We trust this metadata because Supabase Auth only allows the
  -- service_role key to set raw_user_meta_data on invite, and the
  -- /api/staff endpoint validates the caller is ADMIN of that
  -- cafeteria before issuing the invite.
  -- ───────────────────────────────────────────────────────────
  BEGIN
    v_invite_cafeteria_id := NULLIF(NEW.raw_user_meta_data->>'invite_cafeteria_id', '')::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    v_invite_cafeteria_id := NULL;
  END;

  v_invite_role := UPPER(NULLIF(trim(NEW.raw_user_meta_data->>'invite_role'), ''));

  IF v_invite_cafeteria_id IS NOT NULL
     AND v_invite_role IN ('ADMIN', 'HELPER', 'ORDERS') THEN

    SELECT EXISTS(SELECT 1 FROM public.cafeterias WHERE id = v_invite_cafeteria_id)
    INTO   v_cafeteria_exists;

    IF v_cafeteria_exists THEN
      INSERT INTO public.cafeteria_users (cafeteria_id, user_id, role)
      VALUES (v_invite_cafeteria_id, NEW.id, v_invite_role::user_role_enum)
      ON CONFLICT (cafeteria_id, user_id) DO NOTHING;

      RETURN NEW;
    END IF;
    -- If the invited cafeteria does not exist, fall through to the
    -- owner-signup path so the user is not orphaned.
  END IF;

  -- ───────────────────────────────────────────────────────────
  -- BRANCH B: Owner self-signup (unchanged from migration 015)
  -- ───────────────────────────────────────────────────────────
  v_cafeteria_name := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data->>'cafeteria_name'), ''),
    split_part(NEW.email, '@', 1)
  );

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

  INSERT INTO public.cafeteria_users (cafeteria_id, user_id, role)
  VALUES (v_cafeteria_id, NEW.id, 'ADMIN')
  ON CONFLICT (cafeteria_id, user_id) DO NOTHING;

  INSERT INTO public.settings (cafeteria_id, max_meals, cutoff_time, message)
  VALUES (
    v_cafeteria_id,
    15,
    '09:00',
    'Bienvenido a SaborEspecial. Configure su menú semanal desde el panel de administración.'
  )
  ON CONFLICT (cafeteria_id) DO NOTHING;

  v_week_start := date_trunc('week', CURRENT_DATE)::DATE;

  FOR v_week_offset IN 0..1 LOOP
    FOR v_day_offset IN 0..4 LOOP
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


DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
