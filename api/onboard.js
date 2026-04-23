import { createClient } from "@supabase/supabase-js";
import { handleOptions, setCors } from "../lib/http.js";

function getServiceClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function requireSuperAdmin(req) {
  const provided = String(req.headers["x-super-admin-secret"] || "");
  const expected = process.env.SUPER_ADMIN_SECRET || "";
  if (!expected || provided !== expected) {
    throw { status: 401, message: "Acceso no autorizado." };
  }
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed." });
  }

  try {
    requireSuperAdmin(req);

    const supabase = getServiceClient();
    const action = String(req.body?.action || "");

    // ---- LIST all cafeterias ----
    if (action === "list") {
      const { data: cafeterias, error } = await supabase
        .from("cafeterias")
        .select("id, name, slug, is_active, created_at")
        .order("created_at", { ascending: false });

      if (error) throw error;

      return res.status(200).json({ ok: true, cafeterias: cafeterias || [] });
    }

    // ---- PROVISION a new cafeteria + settings + admin user ----
    if (action === "provision") {
      const cafeteriaName = String(req.body?.cafeteriaName || "").trim();
      const userEmail     = String(req.body?.userEmail     || "").trim().toLowerCase();

      if (!cafeteriaName || !userEmail) {
        return res.status(400).json({
          ok: false,
          message: "Se requiere cafeteriaName y userEmail."
        });
      }

      // Look up the auth user by email
      const { data: { users }, error: lookupError } = await supabase.auth.admin.listUsers();
      if (lookupError) throw lookupError;

      const targetUser = users.find((u) => u.email === userEmail);
      if (!targetUser) {
        return res.status(404).json({
          ok: false,
          message: `No existe ningún usuario registrado con el correo ${userEmail}.`
        });
      }

      // Derive a unique slug
      let baseSlug = slugify(cafeteriaName) || "cafeteria-" + targetUser.id.slice(0, 8);
      let slug = baseSlug;
      let suffix = 0;

      while (true) {
        const { data: existing } = await supabase
          .from("cafeterias")
          .select("id")
          .eq("slug", slug)
          .maybeSingle();

        if (!existing) break;
        suffix++;
        slug = baseSlug + "-" + suffix;
      }

      // Insert cafeteria
      const { data: cafeteria, error: cafError } = await supabase
        .from("cafeterias")
        .insert({ name: cafeteriaName, slug, timezone: "America/Costa_Rica" })
        .select("id")
        .single();

      if (cafError) throw cafError;

      const cafeteriaId = cafeteria.id;

      // Assign ADMIN role (upsert to handle case where trigger already ran)
      const { error: memberError } = await supabase
        .from("cafeteria_users")
        .upsert(
          { cafeteria_id: cafeteriaId, user_id: targetUser.id, role: "ADMIN" },
          { onConflict: "cafeteria_id,user_id" }
        );

      if (memberError) throw memberError;

      // Create default settings row (ignore unique conflict if trigger already ran)
      const { error: settingsError } = await supabase
        .from("settings")
        .insert({ cafeteria_id: cafeteriaId });

      if (settingsError && settingsError.code !== "23505") throw settingsError;

      return res.status(200).json({
        ok: true,
        message: `Cafetería "${cafeteriaName}" creada y asignada a ${userEmail}.`,
        cafeteriaId,
        slug
      });
    }

    return res.status(400).json({ ok: false, message: "Acción no soportada. Use 'list' o 'provision'." });

  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ ok: false, message: error.message });
    }
    return res.status(500).json({
      ok: false,
      message: error.message || "Error inesperado en onboarding."
    });
  }
}
