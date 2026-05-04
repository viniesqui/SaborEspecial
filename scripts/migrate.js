#!/usr/bin/env node
// Headless, idempotent migration runner.
// Tracks applied migrations in a _migrations table so it's safe to run repeatedly.
// Each migration runs in a transaction — partial failures are rolled back cleanly.
//
// ── Enum-extension policy ────────────────────────────────────────────────────
// PostgreSQL forbids using a value created by ALTER TYPE … ADD VALUE inside
// the same transaction that added it. Wrapping such a statement in
// BEGIN/COMMIT is fine on its own, but mixing it with later DDL/DML that
// references the new value in the same file produces an opaque
// "unsafe use of new value" error at runtime.
//
// Policy enforced by this runner:
//   1. Migration files that contain ALTER TYPE … ADD VALUE must contain
//      ONLY enum extensions (and comments/whitespace). Mixed files are
//      rejected with a clear message — split them into two migrations.
//   2. Enum-only files are executed statement-by-statement WITHOUT a
//      surrounding BEGIN/COMMIT, so each ADD VALUE auto-commits before
//      anything else can reference it.
//
// Usage:
//   DATABASE_URL=postgresql://... node scripts/migrate.js
//   npm run init-db   (reads DATABASE_URL from .env.local automatically)

import "./env.js";
import pg from "pg";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const { Client } = pg;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error(
    "\nMissing DATABASE_URL.\n" +
    "Format:  postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres\n" +
    "Find the password in: Supabase Dashboard → Settings → Database\n"
  );
  process.exit(1);
}

const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

// ── Enum-extension detection ────────────────────────────────────────────────
// Strip line comments and block comments, then look for ALTER TYPE … ADD VALUE.
// If found, verify nothing else lives in the file.
const ENUM_ADD_RE      = /ALTER\s+TYPE\s+[\w."]+\s+ADD\s+VALUE\b/gi;
const ENUM_ADD_STMT_RE = /^\s*ALTER\s+TYPE\s+[\w."]+\s+ADD\s+VALUE\b/i;

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/--[^\n]*/g, "");        // line comments
}

function splitStatements(sql) {
  // Naive splitter: enum-only files contain plain ALTER TYPE statements with
  // no string literals or dollar-quoted bodies, so a simple semicolon split
  // is safe here.
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function classify(sql) {
  const stripped = stripSqlComments(sql);
  const enumAdds = stripped.match(ENUM_ADD_RE) || [];
  if (enumAdds.length === 0) return { kind: "regular" };

  const statements     = splitStatements(stripped);
  const nonEnumPresent = statements.some((stmt) => !ENUM_ADD_STMT_RE.test(stmt));

  if (nonEnumPresent) {
    return {
      kind:    "mixed",
      message:
        "Mixed migration: ALTER TYPE … ADD VALUE statements cannot share a file with " +
        "other DDL/DML. Move the enum additions into their own migration file " +
        "(see scripts/migrate.js header for the policy)."
    };
  }
  return { kind: "enum-only", statements };
}

async function run() {
  await client.connect();

  // Tracking table — idempotent creation.
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  const { rows } = await client.query(
    "SELECT filename FROM _migrations ORDER BY filename"
  );
  const applied = new Set(rows.map((r) => r.filename));

  const dir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }

    const sql        = readFileSync(join(dir, file), "utf8");
    const classified = classify(sql);

    if (classified.kind === "mixed") {
      throw new Error(`[${file}] ${classified.message}`);
    }

    // Enum-only files run statement-by-statement OUTSIDE a transaction so
    // each ADD VALUE auto-commits before the next statement runs. The
    // _migrations bookkeeping is wrapped in its own micro-transaction so
    // a partial failure does not mark the file as applied.
    if (classified.kind === "enum-only") {
      try {
        for (const stmt of classified.statements) {
          await client.query(stmt);
        }
        await client.query(
          "INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
          [file]
        );
        console.log(`  ✓     ${file}  (enum-only, autocommit)`);
        count++;
        continue;
      } catch (err) {
        // ALTER TYPE … ADD VALUE IF NOT EXISTS already swallows duplicates,
        // but tolerate 42710 (duplicate_object) for older syntax in 002.
        if (err.code === "42710") {
          await client.query(
            "INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
            [file]
          );
          console.log(`  ~     ${file}  (enum value ya existía — marcado como aplicado)`);
          count++;
          continue;
        }
        throw new Error(`[${file}] ${err.message}`);
      }
    }

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`  ✓     ${file}`);
      count++;
    } catch (err) {
      await client.query("ROLLBACK");

      // If the object already exists, the migration was applied before tracking
      // was introduced (e.g. via the SQL editor). Mark it done and continue.
      const alreadyExists =
        err.code === "42710" || // duplicate_object (ENUM, etc.)
        err.code === "42P07" || // duplicate_table
        err.code === "42723" || // duplicate_function
        err.code === "42701" || // duplicate_column
        err.code === "42P13";   // cannot change return type of existing function

      if (alreadyExists) {
        await client.query(
          "INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
          [file]
        );
        console.log(`  ~     ${file}  (ya existía — marcado como aplicado)`);
        count++;
      } else {
        throw new Error(`[${file}] ${err.message}`);
      }
    }
  }

  console.log(`\n  ${count} de ${files.length} migración(es) procesada(s).`);
  await client.end();
}

run().catch((err) => {
  console.error("\nMigración fallida:", err.message);
  process.exit(1);
});
