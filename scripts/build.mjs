#!/usr/bin/env node
// WS-04 build pipeline: minify, content-hash, manifest, build-report.
// No bundling — each source is shipped as an independent IIFE that
// already publishes its globals (window.SE, etc.). Bundling them would
// duplicate shared helpers across page bundles.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join, extname } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");

const JS_ENTRIES = [
  ["logger",          "lib/logger.js"],
  ["supabase-client", "supabase-client.js"],
  ["status-banner",   "shared/status-banner.js"],
  ["api-client",      "shared/api-client.js"],
  ["formatters",      "shared/formatters.js"],
  ["ui-feedback",     "shared/ui-feedback.js"],
  ["app",             "app.js"],
  ["management",      "management.js"],
  ["deliveries",      "deliveries.js"],
  ["track",           "track.js"],
  ["login",           "login.js"],
  ["signup",          "signup.js"],
];

const CSS_ENTRIES = [
  ["styles", "styles.css"],
];

// Critical-path = what customer-app.html loads before first paint.
// Tracked against SM-3 (<60 KB gzipped JS+CSS).
const CRITICAL_PATH_NAMES = [
  "styles.css",
  "logger.js",
  "supabase-client.js",
  "status-banner.js",
  "api-client.js",
  "formatters.js",
  "ui-feedback.js",
  "app.js",
];

async function compileOne(name, src) {
  const ext = extname(src);
  const result = await build({
    entryPoints: [src],
    bundle: false,
    minify: true,
    write: false,
    target: ["es2018"],
    loader: { ".css": "css" },
    legalComments: "none",
    sourcemap: false,
  });
  const out = result.outputFiles[0];
  const contents = out.contents;
  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 10);
  const file = `${name}.${hash}${ext}`;
  await writeFile(join(DIST, file), contents);
  return {
    logical: name + ext,
    src,
    file,
    bytes: contents.length,
    gzip: gzipSync(contents, { level: 9 }).length,
    brotli: brotliCompressSync(contents).length,
  };
}

async function main() {
  const t0 = performance.now();
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const all = [...JS_ENTRIES, ...CSS_ENTRIES];
  const reports = await Promise.all(all.map(([n, s]) => compileOne(n, s)));

  const manifest = {};
  for (const r of reports) manifest[r.logical] = r.file;

  // Manifest hash: deterministic over logical→file mapping. Drives SW
  // cache version (closes EP-5 / WS-04 acceptance "SW cache version derives
  // from build manifest hash, not hand-edited").
  const manifestBody = JSON.stringify(manifest, Object.keys(manifest).sort());
  const manifestHash = createHash("sha256").update(manifestBody).digest("hex").slice(0, 12);
  const manifestOut = { ...manifest, __hash: manifestHash };
  await writeFile(join(DIST, "manifest.json"), JSON.stringify(manifestOut, null, 2));

  const totals = reports.reduce(
    (a, r) => ({ bytes: a.bytes + r.bytes, gzip: a.gzip + r.gzip, brotli: a.brotli + r.brotli }),
    { bytes: 0, gzip: 0, brotli: 0 },
  );

  const critical = reports
    .filter((r) => CRITICAL_PATH_NAMES.includes(r.logical))
    .reduce(
      (a, r) => ({ bytes: a.bytes + r.bytes, gzip: a.gzip + r.gzip, brotli: a.brotli + r.brotli }),
      { bytes: 0, gzip: 0, brotli: 0 },
    );

  const elapsedMs = Math.round(performance.now() - t0);

  const buildReport = {
    builtAt: new Date().toISOString(),
    manifestHash,
    elapsedMs,
    nodeVersion: process.version,
    bundles: Object.fromEntries(
      reports.map((r) => [r.logical, { file: r.file, src: r.src, bytes: r.bytes, gzip: r.gzip, brotli: r.brotli }]),
    ),
    totals,
    criticalPath: { names: CRITICAL_PATH_NAMES, ...critical },
  };
  await writeFile(join(DIST, "build-report.json"), JSON.stringify(buildReport, null, 2));

  const kb = (n) => (n / 1024).toFixed(2) + " KB";
  console.log(`build ${elapsedMs}ms — manifest ${manifestHash}`);
  console.log(`  total:         ${kb(totals.bytes)} raw / ${kb(totals.gzip)} gzip / ${kb(totals.brotli)} brotli`);
  console.log(`  critical path: ${kb(critical.bytes)} raw / ${kb(critical.gzip)} gzip  (SM-3 budget 60.00 KB gzip)`);
  if (critical.gzip > 60 * 1024) {
    console.error("  SM-3 critical-path budget exceeded.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
