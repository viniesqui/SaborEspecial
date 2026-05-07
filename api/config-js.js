// Serves /config.js dynamically from server-side environment variables.
// The browser never needs to know where these values come from — they just work.
// Route: /config.js → /api/config-js  (vercel.json rewrites)
export default function handler(req, res) {
  const url = process.env.SUPABASE_URL    || "";
  const key = process.env.SUPABASE_ANON_KEY || "";

  if (!url || !key) {
    // Fail loudly in the browser console so the developer knows exactly what to fix.
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(
      `console.error("[SaborEspecial] SUPABASE_URL y SUPABASE_ANON_KEY no están configurados. Ejecuta: npm run setup");` +
      `window.APP_CONFIG = {};`
    );
  }

  // P1-6: no hardcoded tenant fallback. If neither /s/<slug> nor ?slug= is
  // present, surface an empty slug so the API short-circuits with a clear
  // "tenant not found" error instead of silently routing to a default tenant.
  const slug = [
    `(function(){`,
    `  var m=window.location.pathname.match(/\\/s\\/([^/?#]+)/);`,
    `  if(m) return decodeURIComponent(m[1]).toLowerCase();`,
    `  var s=new URLSearchParams(window.location.search).get("slug");`,
    `  if(s) return s.toLowerCase();`,
    `  return "";`,
    `})()`,
  ].join("");

  const body = [
    `window.APP_CONFIG=(function(){`,
    `  var slug=${slug};`,
    `  return{`,
    `    apiBaseUrl:       window.location.origin+"/api",`,
    `    cafeteriaSlug:    slug,`,
    `    maxDailyMeals:    15,`,
    `    refreshIntervalMs:30000,`,
    `    cacheKey:         "se-lunch-cache-v1-"+slug,`,
    `    supabaseUrl:      ${JSON.stringify(url)},`,
    `    supabaseAnonKey:  ${JSON.stringify(key)}`,
    `  };`,
    `})();`,
  ].join("\n");

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(body);
}
