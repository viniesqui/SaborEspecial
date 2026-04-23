window.APP_CONFIG = {
  apiBaseUrl: (typeof window !== "undefined" ? window.location.origin : "") + "/api",
  businessName: "Almuerzos CEEP",
  maxDailyMeals: 15,
  refreshIntervalMs: 30000,
  cacheKey: "ceep-lunch-cache-v1",
  // Replace these two values before deploying. The anon key is safe to expose in the browser.
  supabaseUrl: "https://REPLACE_WITH_YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "REPLACE_WITH_YOUR_ANON_KEY"
};
