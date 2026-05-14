#!/usr/bin/env node
// WS-09 R-09-1 — lint only files changed in this PR.
// Compares HEAD against the merge-base with the target branch
// (LINT_BASE env var, default `origin/main`). Falls back to working-tree
// diff when no base is available, so the script is also useful locally.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const TARGET = process.env.LINT_BASE || "origin/main";

function tryRun(cmd) {
  try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString(); }
  catch { return ""; }
}

let base = "";
try {
  base = execSync(`git merge-base HEAD ${TARGET}`, { stdio: ["ignore", "pipe", "ignore"] })
    .toString().trim();
} catch { /* target ref unavailable */ }

const diff = base
  ? tryRun(`git diff --name-only --diff-filter=ACMR ${base}..HEAD`)
  : tryRun(`git diff --name-only --diff-filter=ACMR HEAD`);

const files = diff
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((f) => /\.(js|mjs)$/.test(f))
  .filter((f) => existsSync(f))
  .filter((f) => !f.startsWith("dist/") && !f.startsWith("node_modules/"))
  .filter((f) => !f.startsWith("api/") && !f.startsWith("supabase/"));

if (!files.length) {
  console.log("lint:changed — no JS files changed.");
  process.exit(0);
}

console.log("lint:changed — linting:", files.join(", "));
try {
  execSync(
    `npx --no-install eslint --max-warnings=0 ${files.map((f) => JSON.stringify(f)).join(" ")}`,
    { stdio: "inherit" },
  );
} catch {
  process.exit(1);
}
