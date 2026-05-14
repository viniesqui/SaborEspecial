#!/usr/bin/env node
// WS-09 R-09-3 — bundle-budget gate.
// Compares dist/build-report.json against .bundle-baseline.json.
// Fails CI when any tracked bundle grows >5% over baseline (gzip),
// or when critical-path JS+CSS exceeds SM-3 (60 KB gzipped).

import { readFile } from "node:fs/promises";

const MAX_GROWTH = 1.05;
const SM3_LIMIT  = 60 * 1024;

function fmt(n) { return (n / 1024).toFixed(2) + " KB"; }

let report;
try {
  report = JSON.parse(await readFile("dist/build-report.json", "utf8"));
} catch {
  console.error("dist/build-report.json missing — run `npm run build` first.");
  process.exit(2);
}

let baseline = null;
try {
  baseline = JSON.parse(await readFile(".bundle-baseline.json", "utf8"));
} catch {
  console.warn("No .bundle-baseline.json — skipping per-bundle delta check.");
}

const violations = [];

if (baseline?.bundles) {
  for (const [name, cur] of Object.entries(report.bundles)) {
    const base = baseline.bundles[name];
    if (!base) continue;
    if (cur.gzip > base.gzip * MAX_GROWTH) {
      violations.push({
        kind: "bundle-growth",
        name,
        baseline_gzip: base.gzip,
        current_gzip:  cur.gzip,
        delta_pct:     ((cur.gzip / base.gzip - 1) * 100).toFixed(1),
      });
    }
  }
  if (baseline.criticalPath && report.criticalPath.gzip > baseline.criticalPath.gzip * MAX_GROWTH) {
    violations.push({
      kind: "critical-path-growth",
      baseline_gzip: baseline.criticalPath.gzip,
      current_gzip:  report.criticalPath.gzip,
      delta_pct:     ((report.criticalPath.gzip / baseline.criticalPath.gzip - 1) * 100).toFixed(1),
    });
  }
}

if (report.criticalPath.gzip > SM3_LIMIT) {
  violations.push({
    kind: "sm3-critical-path",
    limit_gzip:   SM3_LIMIT,
    current_gzip: report.criticalPath.gzip,
  });
}

if (violations.length) {
  console.error("Bundle budget violations:");
  for (const v of violations) console.error("  -", v);
  process.exit(1);
}

console.log(`bundle budget OK — critical path ${fmt(report.criticalPath.gzip)} gzip (limit ${fmt(SM3_LIMIT)})`);
