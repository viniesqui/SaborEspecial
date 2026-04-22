(function () {
  "use strict";

  const config = window.APP_CONFIG || {};

  if (!window.supabase) {
    console.error("Supabase CDN script not loaded before supabase-client.js");
    return;
  }

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    console.error("supabaseUrl and supabaseAnonKey must be set in config.js");
    return;
  }

  window.supabaseClient = window.supabase.createClient(
    config.supabaseUrl,
    config.supabaseAnonKey
  );
})();
