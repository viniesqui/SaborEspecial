window.APP_CONFIG = (function () {
  // Resolve the cafeteria slug from the URL so any soda can be served
  // from the same deployment without touching this file.
  //
  // Priority:
  //   1. URL path segment:  /s/<slug>  or  /s/<slug>/...
  //   2. Query parameter:   ?slug=<slug>
  //   3. Hardcoded fallback (used when accessing pages directly, e.g. management.html)
  var slug = (function () {
    var pathMatch = window.location.pathname.match(/\/s\/([^/?#]+)/);
    if (pathMatch) return decodeURIComponent(pathMatch[1]).toLowerCase();

    var searchSlug = new URLSearchParams(window.location.search).get("slug");
    if (searchSlug) return searchSlug.toLowerCase();

    return "ceep";
  })();

  return {
    apiBaseUrl:        window.location.origin + "/api",
    cafeteriaSlug:     slug,
    maxDailyMeals:     15,
    refreshIntervalMs: 30000,
    // Namespace the cache key per slug so different sodas never share stale data.
    cacheKey:          "se-lunch-cache-v1-" + slug,
    // Replace these two values once before deploying. The anon key is safe
    // to expose in the browser — all sensitive ops go through the backend.
    supabaseUrl:       "https://REPLACE_WITH_YOUR_PROJECT_REF.supabase.co",
    supabaseAnonKey:   "REPLACE_WITH_YOUR_ANON_KEY"
  };
})();
