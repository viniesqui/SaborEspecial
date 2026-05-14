#!/usr/bin/env node
// Refresh .bundle-baseline.json from dist/build-report.json.
// Run explicitly when an intentional bundle change lands.

import { readFile, writeFile } from "node:fs/promises";

const report = JSON.parse(await readFile("dist/build-report.json", "utf8"));

const baseline = {
  builtAt: report.builtAt,
  manifestHash: report.manifestHash,
  bundles: Object.fromEntries(
    Object.entries(report.bundles).map(([k, v]) => [k, { bytes: v.bytes, gzip: v.gzip, brotli: v.brotli }]),
  ),
  totals: report.totals,
  criticalPath: { bytes: report.criticalPath.bytes, gzip: report.criticalPath.gzip, brotli: report.criticalPath.brotli },
};

await writeFile(".bundle-baseline.json", JSON.stringify(baseline, null, 2) + "\n");
console.log("Wrote .bundle-baseline.json");
