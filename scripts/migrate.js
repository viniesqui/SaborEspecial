#!/usr/bin/env node
// Headless, idempotent migration runner.
// Tracks applied migrations in a _migrations table so it's safe to run repeatedly.
// Each migration runs in a transaction — partial failures are rolled back cleanly.
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

    const sql = readFileSync(join(dir, file), "utf8");

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
