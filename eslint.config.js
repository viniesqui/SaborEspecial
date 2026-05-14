// WS-09 R-09-1 — ESLint flat config.
// Rules: no-unused-vars, no-implicit-globals, prefer-const, eqeqeq.
// Scope: page-level JS, shared/, lib/, scripts/ — api/ and supabase/ are
// owned by other workstreams in this sprint.

import js from "@eslint/js";
import globals from "globals";

const browserScripts = [
  "app.js",
  "management.js",
  "deliveries.js",
  "track.js",
  "login.js",
  "signup.js",
  "supabase-client.js",
  "shared/**/*.js",
  "lib/logger.js",
  "sw.js",
];

const nodeScripts = ["scripts/**/*.{js,mjs}", "eslint.config.js"];

const serverLib = [
  "lib/auth.js",
  "lib/dashboard.js",
  "lib/email.js",
  "lib/http.js",
  "lib/payment-status.js",
  "lib/supabase.js",
  "lib/validators.js",
];

// R-09-1 rule list is explicit: no-unused-vars, no-implicit-globals,
// prefer-const, eqeqeq. Anything else from the `recommended` baseline
// that catches legitimate code style choices in this codebase (catch
// blocks intentionally swallowing errors, etc.) is turned off so the
// gate stays scoped to what was specified.
const sharedRules = {
  "no-unused-vars": ["error", {
    args: "after-used",
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_|^err$|^e$",
  }],
  "no-implicit-globals": "error",
  "prefer-const": "error",
  eqeqeq: ["error", "always"],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "preserve-caught-error": "off",
};

export default [
  js.configs.recommended,

  {
    files: browserScripts,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        APP_CONFIG: "readonly",
        SE: "writable",
        supabase: "readonly",
        supabaseClient: "writable",
      },
    },
    rules: sharedRules,
  },

  {
    files: nodeScripts,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },

  {
    files: serverLib,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },

  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "api/**",
      "supabase/**",
      "coverage/**",
      ".vercel/**",
    ],
  },
];
