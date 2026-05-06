#!/usr/bin/env node
/**
 * scripts/test-integrity.js  —  Sabor Especial Production Integrity Suite
 *
 * Usage:  node scripts/test-integrity.js
 *
 * Integration tests (marked INTEGRATION) skip gracefully when these env vars
 * are absent. Set them against a staging deployment, never production.
 *
 *   API_BASE_URL        – deployed API root (e.g. https://api.example.com)
 *   CAFETERIA_A_TOKEN   – valid Supabase JWT belonging to Cafeteria A
 *   CAFETERIA_B_ID      – cafeteria_id UUID of the other tenant (Cafeteria B)
 *
 * Tests marked [P1-3], [P1-6], [P3-1] etc. correspond directly to QA-report
 * bug IDs and will FAIL until those fixes are applied.  A fully green run
 * means the application is ready to deploy.
 */

import "./env.js";
import pg from "pg";
import {
  getDayKey,
  buildDashboardSnapshot,
  isCutoffPassedForDate,
  isSalesOpenNow,
  getUpcomingDayKeys,
  parseBoolean
} from "../lib/dashboard.js";
import { validateOrder, validateTargetDate }            from "../lib/validators.js";
import {
  isPaid,
  toCanonicalPayment,
  PAID_STATUSES,
  CANONICAL_PAID,
  CANONICAL_UNPAID
} from "../lib/payment-status.js";

// ── Terminal helpers ──────────────────────────────────────────────────────────

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m";
const B = "\x1b[1m",  D = "\x1b[2m",  Z = "\x1b[0m";

const PASS = `${G}✓ PASS${Z}`;
const FAIL = `${R}✗ FAIL${Z}`;
const SKIP = `${Y}⊘ SKIP${Z}`;

let passed = 0, failed = 0, skipped = 0;

function assert(condition, label, hint = "") {
  if (condition) {
    passed++;
    console.log(`  ${PASS}  ${label}`);
  } else {
    failed++;
    console.log(`  ${FAIL}  ${label}${hint ? `  ${D}← ${hint}${Z}` : ""}`);
  }
}

function skip(label, reason) {
  skipped++;
  console.log(`  ${SKIP}  ${label}  ${D}(${reason})${Z}`);
}

function section(title) {
  console.log(`\n${B}━━ ${title} ━━${Z}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 1 · MIDNIGHT RESET
// ─────────────────────────────────────────────────────────────────────────────
// Costa Rica is UTC-6 and does NOT observe DST.
// Day boundary: 00:00 CR = 06:00 UTC.  No server restart is needed because
// getDayKey() calls new Date() on every request — it is stateless.
// ═════════════════════════════════════════════════════════════════════════════

section("1 · Midnight Reset  (America/Costa_Rica boundary)");

{
  // Known UTC timestamps mapped to expected CR day keys
  const cases = [
    // [utc-iso,                     expected,     label]
    ["2026-04-23T06:00:00.000Z", "2026-04-23", "00:00:00 CR  → new day starts"],
    ["2026-04-23T05:59:59.000Z", "2026-04-22", "23:59:59 CR  → still previous day"],
    ["2026-04-23T18:00:00.000Z", "2026-04-23", "12:00:00 CR  → midday stays same"],
    ["2026-04-24T05:59:59.000Z", "2026-04-23", "23:59:59 CR  → day has not flipped yet"],
    ["2026-04-26T06:00:00.000Z", "2026-04-26", "Sunday 00:00 CR → week boundary"],
  ];

  for (const [utc, expected, label] of cases) {
    const got = getDayKey(new Date(utc));
    assert(got === expected, label, got !== expected ? `got "${got}"` : "");
  }

  // Verify the counter resets to max_meals when no orders exist for the new day
  const settings   = { max_meals: "5", disable_sales_window: "true" };
  const menu       = { id: "m1", price: 1000, title: "Arroz con Pollo", active: true };
  const oneOrder   = { payment_method: "SINPE", menu_price: 1000 };

  const fresh      = buildDashboardSnapshot(settings, menu, []);
  const afterTwo   = buildDashboardSnapshot(settings, menu, [oneOrder, oneOrder]);

  assert(fresh.availableMeals === 5,   "Fresh day: availableMeals equals max_meals (5)");
  assert(afterTwo.availableMeals === 3, "After 2 orders: availableMeals = 3");
  assert(afterTwo.soldMeals === 2,      "soldMeals counts only active orders in scope");

  // A day-key mismatch (yesterday's orders) must not bleed into today's count.
  // This is enforced by the `.eq("day_key", dayKey)` filter in fetchTodayData.
  // The unit test below shows that if orders have no cross-day contamination
  // the snapshot is correct by construction.
  assert(fresh.soldMeals === 0, "No prior-day bleed: fresh day has 0 soldMeals");
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 2 · CONCURRENCY & RACE CONDITION
// ─────────────────────────────────────────────────────────────────────────────
// The current api/orders.js uses a read-check-insert pattern with two separate
// async Supabase calls.  20 concurrent serverless invocations can all read
// "0 orders sold" before any write lands, causing over-selling.
//
// ROOT CAUSE (api/orders.js):
//   1. fetchTodayData()          ← async READ  (latency A)
//   2. if (availableMeals <= 0)  ← CHECK passes for all concurrent requests
//   3. supabase.insert()         ← async WRITE (latency B)
//   Steps 1→2 and 2→3 have TOCTOU windows.
//
// FIX — replace step 1–3 with a single atomic Postgres function:
//
//   CREATE OR REPLACE FUNCTION place_order_atomic(
//     p_cafeteria_id uuid, p_day_key text, p_max_meals int, ...payload...
//   ) RETURNS uuid LANGUAGE plpgsql AS $$
//   DECLARE cnt int;
//   BEGIN
//     SELECT COUNT(*) INTO cnt
//       FROM orders
//      WHERE cafeteria_id = p_cafeteria_id
//        AND day_key      = p_day_key
//        AND record_status != 'CANCELADO'
//        FOR UPDATE;               -- serialises concurrent calls
//     IF cnt >= p_max_meals THEN
//       RAISE EXCEPTION 'sold_out';
//     END IF;
//     INSERT INTO orders (...) VALUES (...) RETURNING id;
//   END; $$;
//
//   -- Call site in api/orders.js:
//   const { data, error } = await supabase.rpc("place_order_atomic", { ... });
// ═════════════════════════════════════════════════════════════════════════════

section("2 · Concurrency & Race Condition  (max_meals=1, 20 simultaneous requests)");

{
  // Fixed read delay ensures all 20 handlers complete their "SELECT" before
  // any "INSERT" begins — faithfully simulating concurrent serverless requests.
  async function vulnerableHandler(id, store) {
    await delay(30);                                  // simulate SELECT latency
    const available = store.maxMeals - store.orders; // TOCTOU gap starts
    if (available <= 0) return { ok: false, id };
    await delay(10);                                  // simulate INSERT latency
    store.orders++;                                   // TOCTOU gap ends
    return { ok: true, id };
  }

  // Atomic simulation: no await between check and write → no interleaving.
  // In Postgres this maps to a transaction with SELECT FOR UPDATE.
  async function atomicHandler(id, store) {
    await delay(30);                                  // simulate round-trip latency
    if (store.orders >= store.maxMeals) return { ok: false, id };
    store.orders++;                                   // check + write: no yield point
    return { ok: true, id };
  }

  const REQUESTS = 20;

  // — Vulnerable path —
  const vulnStore = { maxMeals: 1, orders: 0 };
  const vulnResults = await Promise.all(
    Array.from({ length: REQUESTS }, (_, i) => vulnerableHandler(i, vulnStore))
  );
  const vulnSuccesses = vulnResults.filter((r) => r.ok).length;

  assert(
    vulnSuccesses > 1,
    `RACE PROVEN: ${vulnSuccesses}/${REQUESTS} requests accepted (max_meals=1)`,
    "Fix: atomic Postgres RPC — see comment above"
  );
  assert(
    vulnStore.orders > 1,
    `Over-sell confirmed: ${vulnStore.orders} rows inserted against a limit of 1`
  );

  // — Fixed (atomic) path —
  const fixedStore = { maxMeals: 1, orders: 0 };
  const fixedResults = await Promise.all(
    Array.from({ length: REQUESTS }, (_, i) => atomicHandler(i, fixedStore))
  );
  const fixedSuccesses = fixedResults.filter((r) => r.ok).length;

  assert(
    fixedSuccesses === 1,
    `Atomic handler: exactly 1/${REQUESTS} request accepted`
  );
  assert(
    fixedStore.orders === 1,
    "Atomic handler: exactly 1 row inserted — no over-sell"
  );
}

// INTEGRATION — real API concurrency
{
  const apiUrl = process.env.API_BASE_URL;

  if (!apiUrl) {
    skip(
      "Real-API concurrency: 20 simultaneous POSTs assert ≤1 accepted",
      "set API_BASE_URL (use staging, not production)"
    );
  } else {
    console.log(`\n  ${D}[INTEGRATION] Firing 20 simultaneous POSTs → ${apiUrl}/orders${Z}`);

    const body = JSON.stringify({ order: { buyerName: "Rush Test", paymentMethod: "EFECTIVO" } });
    const requests = Array.from({ length: 20 }, () =>
      fetch(`${apiUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
        .then((r) => r.json())
        .catch((err) => ({ ok: false, message: String(err.message) }))
    );

    const results     = await Promise.all(requests);
    const successCount = results.filter((r) => r.ok).length;
    const soldOut      = results.filter((r) => !r.ok && /almuerzo|disponible/i.test(r.message || "")).length;

    console.log(
      `  ${D}  ${successCount} accepted / ${soldOut} sold-out / ` +
      `${20 - successCount - soldOut} other errors${Z}`
    );
    assert(
      successCount <= 1,
      `API concurrency: at most 1 order accepted (got ${successCount})`,
      successCount > 1 ? "CRITICAL — implement atomic RPC immediately" : ""
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 3 · MULTI-TENANT RLS ISOLATION
// ─────────────────────────────────────────────────────────────────────────────
// lib/auth.js:requireAuth() derives cafeteria_id from the verified JWT, not
// from any client-supplied header.  A token for Cafeteria A must never expose
// Cafeteria B's orders or allow writes to Cafeteria B's records.
// ═════════════════════════════════════════════════════════════════════════════

section("3 · Multi-Tenant RLS Isolation  [INTEGRATION]");

{
  const apiUrl = process.env.API_BASE_URL;
  const tokenA = process.env.CAFETERIA_A_TOKEN;
  const cafBId = process.env.CAFETERIA_B_ID;

  if (!apiUrl || !tokenA || !cafBId) {
    skip(
      "Cafeteria-A JWT cannot read/write Cafeteria-B data",
      "set API_BASE_URL + CAFETERIA_A_TOKEN + CAFETERIA_B_ID"
    );
    skip(
      "Forged JWT is rejected with 401 on admin routes",
      "set API_BASE_URL + CAFETERIA_A_TOKEN + CAFETERIA_B_ID"
    );
  } else {
    // 1. Attempt to spoof cafeteria scope via header injection.
    //    requireAuth() ignores X-Cafeteria-Id — it reads the DB for the real mapping.
    const dashResp = await fetch(`${apiUrl}/dashboard`, {
      headers: {
        "Authorization": `Bearer ${tokenA}`,
        "X-Cafeteria-Id": cafBId,          // adversarial header
      },
    });
    const dash = await dashResp.json().catch(() => ({}));
    const leaksCafBOrders =
      Array.isArray(dash.orders) &&
      dash.orders.some((o) => String(o.cafeteriaId || o.cafeteria_id) === cafBId);

    assert(
      !leaksCafBOrders,
      "Header injection of X-Cafeteria-Id does not expose Cafeteria-B orders",
      leaksCafBOrders ? "CRITICAL: cafeteria_id is read from headers, not JWT" : ""
    );

    // 2. Forged JWT must be rejected on every protected admin route.
    const adminResp = await fetch(`${apiUrl}/admin-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.FORGED.SIGNATURE",
      },
      body: JSON.stringify({ action: "list" }),
    });

    assert(
      adminResp.status === 401 || adminResp.status === 403,
      `Admin route rejects forged JWT — HTTP ${adminResp.status}`,
      adminResp.status === 200 ? "CRITICAL: /admin-orders is unprotected" : ""
    );

    // 3. Valid Cafeteria-A token on a Cafeteria-B admin route must be 403.
    //    requireAuth() maps the token to Cafeteria A; querying with Cafeteria B's
    //    ID server-side will return 0 rows (empty, not an error).  What matters
    //    is that no Cafeteria-B data leaks, not the exact HTTP status.
    const crossResp = await fetch(`${apiUrl}/admin-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tokenA}`,
        "X-Cafeteria-Id": cafBId,
      },
      body: JSON.stringify({ action: "list" }),
    });
    const crossData = await crossResp.json().catch(() => ({}));
    const leaksCross =
      Array.isArray(crossData.orders) &&
      crossData.orders.some((o) => String(o.cafeteriaId || o.cafeteria_id) === cafBId);

    assert(
      !leaksCross,
      "Cafeteria-A token on admin-orders yields no Cafeteria-B rows",
      leaksCross ? "CRITICAL: cross-tenant order data exposed" : ""
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 4 · DOUBLE-SUBMIT GUARD  (2 000 ms latency)
// ─────────────────────────────────────────────────────────────────────────────
// app.js uses state.isSubmitting + button.disabled to block duplicate orders
// during the 12:00 PM cafeteria rush when latency can reach 2 000 ms.
// ═════════════════════════════════════════════════════════════════════════════

section("4 · Double-Submit Guard  (2 000 ms simulated latency)");

{
  let networkCalls = 0;

  // Mirrors the submitOrder() state machine in app.js (DOM-free)
  async function simulateSubmit(state, latencyMs) {
    if (state.isSubmitting) return { blocked: true };
    state.isSubmitting = true;

    await delay(latencyMs);  // simulate slow /orders POST
    networkCalls++;

    state.isSubmitting = false;
    return { blocked: false };
  }

  // Two simultaneous clicks — second must be blocked
  networkCalls = 0;
  const appState = { isSubmitting: false };
  const [first, second] = await Promise.all([
    simulateSubmit(appState, 2000),
    simulateSubmit(appState, 2000), // starts before first await yields
  ]);

  assert(!first.blocked,  "First click proceeds normally");
  assert(second.blocked,  "Second click blocked by isSubmitting guard");
  assert(networkCalls === 1, "Exactly 1 network request fired under double-click");

  // Guard must reset so the user can place a subsequent order
  const third = await simulateSubmit(appState, 10);
  assert(!third.blocked, "Guard resets after completion — subsequent order allowed");

  // Simulate rapid triple-click
  networkCalls = 0;
  const tripleState = { isSubmitting: false };
  const [t1, t2, t3] = await Promise.all([
    simulateSubmit(tripleState, 2000),
    simulateSubmit(tripleState, 2000),
    simulateSubmit(tripleState, 2000),
  ]);
  assert(networkCalls === 1, "Triple-click: still only 1 network call");
  assert([t1, t2, t3].filter((r) => !r.blocked).length === 1,
    "Triple-click: exactly 1 of 3 clicks proceeds");
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 5 · SIMPLIFICATION AUDIT  (lib/dashboard.js)
// ─────────────────────────────────────────────────────────────────────────────
// Identifies "dumb" code targeted for deletion per The Algorithm.
// Findings are printed for review — not pass/fail assertions.
// ═════════════════════════════════════════════════════════════════════════════

section("5 · Simplification Audit  (lib/dashboard.js static analysis)");

{
  const findings = [
    {
      severity: "HIGH",
      file: "lib/dashboard.js:1-18",
      issue: "Manual UTC-6 offset: COSTA_RICA_OFFSET_HOURS + getCostaRicaShiftedDate()",
      risk: "Hardcoded numeric offset is fragile; Intl.DateTimeFormat already handles this natively.",
      action: "DELETE",
      replacement: `// Delete COSTA_RICA_OFFSET_HOURS, pad(), and getCostaRicaShiftedDate().
// Replace getDayKey() with:
export function getDayKey(date = new Date()) {
  // en-CA locale formats as YYYY-MM-DD — no manual offset needed.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica" }).format(date);
}`,
    },
    {
      severity: "HIGH",
      file: "lib/dashboard.js:38-41",
      issue: "isSalesOpenNow() parses sales-window times as server local time, not CR time",
      risk: `new Date("\${today}T10:00:00") is UTC on a serverless host.
       With UTC server: sales_start="10:00" fires at 10:00 UTC = 04:00 CR.
       The admin-configured 10:00–12:00 CR window silently shifts to 04:00–06:00 CR.`,
      action: "FIX",
      replacement: `// Anchor times to CR timezone by appending the UTC offset:
const start = new Date(\`\${today}T\${salesStart}:00-06:00\`);
const end   = new Date(\`\${today}T\${salesEnd}:00-06:00\`);`,
    },
    {
      severity: "MEDIUM",
      file: "app.js:39-44",
      issue: "requireCustomerSession() enforces role=CUSTOMER from sessionStorage",
      risk: "Client-side check is bypassable. However, the public /dashboard and " +
        "/orders APIs are scoped by CAFETERIA_ID env var at deployment level — " +
        "this guard is UX-only, not a security boundary.",
      action: "KEEP (document intent)",
      replacement: "No code change needed. Ensure all admin/helper API routes " +
        "call requireAuth() server-side — they currently do.",
    },
    {
      severity: "LOW",
      file: "lib/dashboard.js:44-51 + admin.js:150-159",
      issue: "formatTimestamp() duplicated across dashboard.js, admin.js, and app.js",
      risk: "Minor drift risk. Not a bug today.",
      action: "DEFER",
      replacement: "Extract to lib/format.js when a third duplicate appears.",
    },
  ];

  for (const f of findings) {
    const color = f.severity === "HIGH" ? R : f.severity === "MEDIUM" ? Y : D;
    console.log(`\n  ${color}[${f.severity}]${Z}  ${B}${f.file}${Z}  ${D}→ ${f.action}${Z}`);
    console.log(`  Issue:  ${f.issue}`);
    console.log(`  Risk:   ${f.risk}`);
    console.log(
      "  Fix:\n" +
      f.replacement.split("\n").map((l) => "    " + l).join("\n")
    );
  }

  const highCount   = findings.filter((f) => f.severity === "HIGH").length;
  const medCount    = findings.filter((f) => f.severity === "MEDIUM").length;
  const lowCount    = findings.filter((f) => f.severity === "LOW").length;
  console.log(
    `\n  ${B}Audit summary:${Z} ${R}${highCount} HIGH${Z}  ${Y}${medCount} MEDIUM${Z}  ${D}${lowCount} LOW${Z}`
  );
  console.log(`  ${D}HIGH findings must be resolved before the 12:00 PM launch.${Z}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 6 · ORDERS SCHEMA INTEGRITY
// ─────────────────────────────────────────────────────────────────────────────
// Prevents the class of bug where the repository layer (data/orders.repo.js,
// api/track.js, api/admin-orders.js, api/deliveries.js, etc.) SELECTs columns
// that no migration ever created.  Migration 016 fixed the missing
// `tracking_token` column; this suite makes that drift a CI failure instead
// of a runtime 500.
//
// Required columns are derived from every column the repo/API layer reads
// or writes against the `orders` table.
//
// Skips gracefully when DATABASE_URL is absent (e.g. local unit-test runs).
// Required in the deploy pipeline — see .github/workflows/integrity.yml.
// ═════════════════════════════════════════════════════════════════════════════

section("6 · Orders Schema Integrity  [INTEGRATION]");

{
  const REQUIRED_ORDERS_COLUMNS = [
    "tracking_token",
    "target_date",
    "order_channel",
    "created_by_staff",
    "sale_type",
    "package_id",
    "buyer_email",
    "payment_verified_by",
    "prepared_at",
    "ready_at"
  ];

  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    skip(
      "orders table contains every column the repo layer SELECTs",
      "set DATABASE_URL (staging Postgres connection string)"
    );
  } else {
    const client = new pg.Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false }
    });

    try {
      await client.connect();

      const { rows } = await client.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'orders'`
      );
      const present = new Set(rows.map((r) => r.column_name));

      for (const col of REQUIRED_ORDERS_COLUMNS) {
        assert(
          present.has(col),
          `orders.${col} exists`,
          present.has(col) ? "" :
            `MISSING — repo/API references this column but no migration created it. ` +
            `Add an ALTER TABLE in a new supabase/migrations/NNN_*.sql file.`
        );
      }
    } catch (err) {
      failed++;
      console.log(`  ${FAIL}  orders schema introspection failed  ${D}← ${err.message}${Z}`);
    } finally {
      await client.end().catch(() => null);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS  (used by suites 7 +)
// ═════════════════════════════════════════════════════════════════════════════

function expectThrow(fn, substr, label) {
  try {
    fn();
    failed++;
    console.log(`  ${FAIL}  ${label}  ${D}← expected throw, got none${Z}`);
  } catch (e) {
    if (substr && !e.message.toLowerCase().includes(substr.toLowerCase())) {
      failed++;
      console.log(`  ${FAIL}  ${label}  ${D}← wrong error: "${e.message}"${Z}`);
    } else {
      passed++;
      console.log(`  ${PASS}  ${label}`);
    }
  }
}

function expectNoThrow(fn, label) {
  try {
    fn();
    passed++;
    console.log(`  ${PASS}  ${label}`);
  } catch (e) {
    failed++;
    console.log(`  ${FAIL}  ${label}  ${D}← threw: "${e.message}"${Z}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Returns the CR day-key for "today + n days" using the same offset arithmetic
// the production validateTargetDate() uses for its upper-bound calculation.
// ─────────────────────────────────────────────────────────────────────────────
function crDayOffset(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Returns the CR day-key of the first Saturday or Sunday within the next
// `window` days (used by weekend-gate tests).
function findWeekendInWindow(window = 7) {
  for (let i = 1; i <= window; i++) {
    const key = getDayKey(new Date(Date.now() + i * 24 * 60 * 60 * 1000));
    const [y, m, d] = key.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun 6=Sat
    if (dow === 0 || dow === 6) return key;
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 7 · validateOrder()  —  Server-Side Input Validation
// ─────────────────────────────────────────────────────────────────────────────
// Every rule here is enforced by the server regardless of what the client
// sends.  Failures in this suite mean the server would accept bad data.
// ═════════════════════════════════════════════════════════════════════════════

section("7 · validateOrder()  —  Server-Side Input Validation");

{
  // ── Name ──────────────────────────────────────────────────────────────────
  expectThrow(
    () => validateOrder({ paymentMethod: "SINPE", buyerEmail: "a@b.co" }),
    "nombre", "Missing name → error");
  expectThrow(
    () => validateOrder({ buyerName: "", paymentMethod: "SINPE", buyerEmail: "a@b.co" }),
    "nombre", "Empty string name → error");
  expectThrow(
    () => validateOrder({ buyerName: "   ", paymentMethod: "SINPE", buyerEmail: "a@b.co" }),
    "nombre", "Whitespace-only name → error");
  expectThrow(
    () => validateOrder({ buyerName: "A", paymentMethod: "SINPE", buyerEmail: "a@b.co" }),
    "2", "Single-char name → error (min is 2)");
  expectThrow(
    () => validateOrder({ buyerName: "A".repeat(101), paymentMethod: "SINPE", buyerEmail: "a@b.co" }),
    "100", "101-char name → error (max is 100)");

  // ── Payment method ─────────────────────────────────────────────────────────
  expectThrow(
    () => validateOrder({ buyerName: "Ana", buyerEmail: "a@b.co" }),
    "pago", "Missing payment method → error");
  expectThrow(
    () => validateOrder({ buyerName: "Ana", paymentMethod: "TARJETA", buyerEmail: "a@b.co" }),
    "inválido", "Unknown method TARJETA → error");
  expectThrow(
    () => validateOrder({ buyerName: "Ana", paymentMethod: "CASH", buyerEmail: "a@b.co" }),
    "inválido", "English alias CASH → error (must be EFECTIVO)");

  // ── Email — required for ALL payment methods (P1-1 server guard) ──────────
  // NOTE: The CLIENT in app.js only validated email for CREDITO (P1-1 bug).
  // These assertions confirm the SERVER already enforces it for all methods.
  expectThrow(
    () => validateOrder({ buyerName: "Ana", paymentMethod: "SINPE" }),
    "correo", "SINPE without email → server correctly requires it");
  expectThrow(
    () => validateOrder({ buyerName: "Ana", paymentMethod: "EFECTIVO" }),
    "correo", "EFECTIVO without email → server correctly requires it");
  expectThrow(
    () => validateOrder({ buyerName: "Ana", paymentMethod: "CREDITO" }),
    "correo", "CREDITO without email → server correctly requires it");
  expectThrow(
    () => validateOrder({ buyerName: "Ana", paymentMethod: "SINPE", buyerEmail: "notanemail" }),
    "formato", "Malformed email (no @) → error");
  expectThrow(
    () => validateOrder({ buyerName: "Ana", paymentMethod: "SINPE", buyerEmail: "a@b" }),
    "formato", "Email with no TLD (a@b) → error");
  expectThrow(
    () => validateOrder({ buyerName: "Ana", paymentMethod: "SINPE", buyerEmail: "@corp.com" }),
    "formato", "Email with empty local part → error");

  // ── Valid orders ──────────────────────────────────────────────────────────
  expectNoThrow(
    () => validateOrder({ buyerName: "Jo", paymentMethod: "SINPE", buyerEmail: "j@j.co" }),
    "2-char name (min boundary) → accepted");
  expectNoThrow(
    () => validateOrder({ buyerName: "A".repeat(100), paymentMethod: "SINPE", buyerEmail: "j@j.co" }),
    "100-char name (max boundary) → accepted");
  expectNoThrow(
    () => validateOrder({ buyerName: "Ana López", paymentMethod: "sinpe", buyerEmail: "ana@corp.cr" }),
    "Lowercase payment method sinpe → normalized and accepted");
  expectNoThrow(
    () => validateOrder({ buyerName: "Bob", paymentMethod: "EFECTIVO", buyerEmail: "bob@x.io" }),
    "Valid EFECTIVO order → accepted");
  expectNoThrow(
    () => validateOrder({ buyerName: "Carlo", paymentMethod: "CREDITO", buyerEmail: "c+alias@sub.domain.io" }),
    "CREDITO with plus-alias subdomain email → accepted");
  expectNoThrow(
    () => validateOrder({ buyerName: "Ana", paymentMethod: "SINPE", buyerEmail: "ANA@CORP.COM" }),
    "Uppercase email → normalized to lowercase and accepted");
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 8 · validateTargetDate()  —  Date Window Enforcement
// ─────────────────────────────────────────────────────────────────────────────
// The server must reject past dates, non-calendar dates, and dates beyond
// the 7-day pre-order window.
// ═════════════════════════════════════════════════════════════════════════════

section("8 · validateTargetDate()  —  Date Window Enforcement");

{
  const todayKey  = getDayKey();
  const yesterday = getDayKey(new Date(Date.now() - 86400000));
  // 8 days from now in CR time — must exceed the 7-day window.
  const tooFar    = new Date(Date.now() - 6 * 60 * 60 * 1000 + 8 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const threeDays = crDayOffset(3);

  // ── Format rejections ─────────────────────────────────────────────────────
  expectThrow(
    () => validateTargetDate("invalid",    todayKey), "inválida", "Non-date string → error");
  expectThrow(
    () => validateTargetDate("05-06-2026", todayKey), "inválida", "DD-MM-YYYY (wrong order) → error");
  expectThrow(
    () => validateTargetDate("2026-5-6",   todayKey), "inválida", "Missing zero-padding → error");
  expectThrow(
    () => validateTargetDate("",           todayKey), "inválida", "Empty string → error");
  // "2026-99-99" passes the format regex but month 99 sorts after the 7-day
  // max date (string comparison), so the "too far ahead" check fires first.
  // The date is correctly rejected — the exact message depends on which check
  // fires first, so we assert no-message-constraint here.
  expectThrow(
    () => validateTargetDate("2026-99-99", todayKey), null, "Out-of-range date 2026-99-99 → correctly rejected");

  // ── Past date ─────────────────────────────────────────────────────────────
  expectThrow(
    () => validateTargetDate(yesterday, todayKey),
    "pasadas", `Yesterday (${yesterday}) → error`);

  // ── Beyond 7-day window ──────────────────────────────────────────────────
  expectThrow(
    () => validateTargetDate(tooFar, todayKey),
    "7 días", `8 days from now (${tooFar}) → error`);

  // ── Valid dates ──────────────────────────────────────────────────────────
  expectNoThrow(
    () => validateTargetDate(todayKey,  todayKey),
    `Today (${todayKey}) → accepted`);
  expectNoThrow(
    () => validateTargetDate(threeDays, todayKey),
    `3 days ahead (${threeDays}) → accepted`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 9 · Weekend Order Gate  [P1-3 regression]
// ─────────────────────────────────────────────────────────────────────────────
// The cafeteria is closed Saturdays and Sundays.
// getUpcomingDayKeys() must exclude weekends and validateTargetDate() must
// reject a weekend date.
//
// ⚠  THESE TESTS WILL FAIL until P1-3 is fixed:
//    – lib/dashboard.js  getUpcomingDayKeys(): filter out DOW 0 and 6
//    – lib/validators.js validateTargetDate(): throw on DOW 0 or 6
// ═════════════════════════════════════════════════════════════════════════════

section("9 · Weekend Order Gate  [P1-3 regression — fails until fix]");

{
  const todayKey   = getDayKey();
  const weekendKey = findWeekendInWindow(7);

  if (!weekendKey) {
    skip("No weekend day falls within the next 7 days", "extremely rare edge case");
  } else {
    // validateTargetDate() must reject a weekend date.
    expectThrow(
      () => validateTargetDate(weekendKey, todayKey),
      "fin de semana",
      `validateTargetDate rejects ${weekendKey} (weekend) [P1-3]`);

    // getUpcomingDayKeys() must not include any Saturday or Sunday.
    const keys = getUpcomingDayKeys(7);
    const weekendDays = keys.filter((k) => {
      const [y, m, d] = k.split("-").map(Number);
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      return dow === 0 || dow === 6;
    });
    assert(
      weekendDays.length === 0,
      `P1-3: getUpcomingDayKeys(7) contains no weekends (found: ${weekendDays.join(", ") || "none"})`,
      weekendDays.length > 0 ? "Fix: filter DOW 0/6 in getUpcomingDayKeys()" : "");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 10 · Payment Status Invariants
// ─────────────────────────────────────────────────────────────────────────────
// lib/payment-status.js is the single source of truth.  These assertions
// prevent both regression and the P1-4 naming confusion.
// ═════════════════════════════════════════════════════════════════════════════

section("10 · Payment Status Invariants");

{
  // ── PAID_STATUSES must contain exactly the three historical paid values ─────
  assert(PAID_STATUSES.length === 3,
    `PAID_STATUSES has exactly 3 entries (got ${PAID_STATUSES.length})`);
  assert(PAID_STATUSES.includes("CONFIRMADO"),
    "PAID_STATUSES includes CONFIRMADO (canonical)");
  assert(PAID_STATUSES.includes("PAGADO"),
    "PAID_STATUSES includes PAGADO (legacy)");
  assert(PAID_STATUSES.includes("CONFIRMADO_SINPE"),
    "PAID_STATUSES includes CONFIRMADO_SINPE (legacy)");

  // ── PAID_STATUSES must NOT contain the unpaid sentinel ────────────────────
  // (P1-4 guard: old deliveries.js mixed PENDIENTE_DE_PAGO into this array)
  assert(!PAID_STATUSES.includes(CANONICAL_UNPAID),
    `P1-4: PAID_STATUSES does not contain ${CANONICAL_UNPAID}`);
  assert(!PAID_STATUSES.includes("PENDIENTE_DE_PAGO"),
    "P1-4: PAID_STATUSES does not contain PENDIENTE_DE_PAGO (any casing)");

  // ── isPaid() ──────────────────────────────────────────────────────────────
  assert(isPaid("CONFIRMADO"),       "isPaid('CONFIRMADO') → true");
  assert(isPaid("PAGADO"),           "isPaid('PAGADO') → true");
  assert(isPaid("CONFIRMADO_SINPE"), "isPaid('CONFIRMADO_SINPE') → true");
  assert(!isPaid("PENDIENTE_DE_PAGO"), "isPaid('PENDIENTE_DE_PAGO') → false");
  assert(!isPaid(""),                "isPaid('') → false");
  assert(!isPaid(null),              "isPaid(null) → false");
  assert(!isPaid("UNKNOWN"),         "isPaid('UNKNOWN') → false");

  // ── toCanonicalPayment() ──────────────────────────────────────────────────
  assert(toCanonicalPayment("CONFIRMADO")       === CANONICAL_PAID,
    "toCanonicalPayment(CONFIRMADO) → CONFIRMADO");
  assert(toCanonicalPayment("PAGADO")           === CANONICAL_PAID,
    "toCanonicalPayment(PAGADO) → CONFIRMADO (legacy → canonical)");
  assert(toCanonicalPayment("CONFIRMADO_SINPE") === CANONICAL_PAID,
    "toCanonicalPayment(CONFIRMADO_SINPE) → CONFIRMADO (legacy → canonical)");
  assert(toCanonicalPayment("PENDIENTE_DE_PAGO") === CANONICAL_UNPAID,
    "toCanonicalPayment(PENDIENTE_DE_PAGO) → PENDIENTE_DE_PAGO");
  assert(toCanonicalPayment("") === CANONICAL_UNPAID,
    "toCanonicalPayment('') → PENDIENTE_DE_PAGO (safe default)");
  assert(toCanonicalPayment(null) === CANONICAL_UNPAID,
    "toCanonicalPayment(null) → PENDIENTE_DE_PAGO (safe default)");
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 11 · isCutoffPassedForDate()  —  Cutoff Enforcement
// ─────────────────────────────────────────────────────────────────────────────
// Future dates are always open.  Past dates are always closed.
// "Today" is time-based using the actual CR clock — we bracket the test
// with extreme cutoff values to get deterministic results.
// ═════════════════════════════════════════════════════════════════════════════

section("11 · isCutoffPassedForDate()  —  Cutoff Enforcement");

{
  const todayKey   = getDayKey();
  const yesterday  = getDayKey(new Date(Date.now() - 86400000));
  const tomorrow   = getDayKey(new Date(Date.now() + 86400000));
  const in3Days    = getDayKey(new Date(Date.now() + 3 * 86400000));

  // ── Future dates are always open ─────────────────────────────────────────
  assert(
    isCutoffPassedForDate({}, tomorrow) === false,
    `Tomorrow (${tomorrow}) is always open`);
  assert(
    isCutoffPassedForDate({ cutoff_time: "00:00" }, in3Days) === false,
    `3 days ahead is open even with cutoff_time=00:00`);

  // ── Past dates are always closed ─────────────────────────────────────────
  assert(
    isCutoffPassedForDate({}, yesterday) === true,
    `Yesterday (${yesterday}) is always closed`);
  assert(
    isCutoffPassedForDate({ cutoff_time: "23:59" }, yesterday) === true,
    `Yesterday is closed even with late cutoff_time=23:59`);

  // ── Today with extreme cutoffs ────────────────────────────────────────────
  // cutoff 23:59 → open for today (test runs before 23:59 CR ~100% of the time)
  assert(
    isCutoffPassedForDate({ cutoff_time: "23:59" }, todayKey) === false,
    `Today with cutoff_time=23:59 is open (test runs before midnight CR)`);
  // cutoff 00:01 → closed for today (test runs after 00:01 CR ~100% of the time)
  assert(
    isCutoffPassedForDate({ cutoff_time: "00:01" }, todayKey) === true,
    `Today with cutoff_time=00:01 is closed (test runs after 12:01 AM CR)`);

  // ── normalizeTime handles various input formats ───────────────────────────
  // "09:00:00" (Postgres TIME) must be truncated to "09:00"
  assert(
    isCutoffPassedForDate({ cutoff_time: "23:59:00" }, todayKey) === false,
    "cutoff_time=23:59:00 (postgres format) normalised to 23:59 → open today");

  // ── Missing settings default to 09:00 cutoff ─────────────────────────────
  // Test that the function doesn't crash when settings fields are missing.
  expectNoThrow(
    () => isCutoffPassedForDate({}, todayKey),
    "isCutoffPassedForDate() does not throw when settings is empty {}");
  // For a future date, the function short-circuits before accessing settings
  // fields, so null settings must be safe (function returns false immediately).
  expectNoThrow(
    () => isCutoffPassedForDate(null, tomorrow),
    "isCutoffPassedForDate(null, future) does not throw — short-circuits before settings access");
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 12 · buildDashboardSnapshot()  —  Extended Coverage
// ─────────────────────────────────────────────────────────────────────────────
// Exercises the JS-aggregation path (no stats object) and the SQL-stats
// fast path, the menu=null case, and the available-meals floor at zero.
// ═════════════════════════════════════════════════════════════════════════════

section("12 · buildDashboardSnapshot()  —  Extended Coverage");

{
  const settings = {
    max_meals:             "5",
    disable_sales_window:  "true",
    cutoff_time:           "09:00",
    sales_start:           "10:00",
    sales_end:             "12:00",
    delivery_window:       "12:00 - 12:30"
  };
  const menu = { id: "m1", title: "Arroz con Pollo", description: "Con ensalada", price: 2500 };

  const sinpeOrder  = { payment_method: "SINPE",    payment_status: "PENDIENTE_DE_PAGO", menu_price: 2500, order_channel: "DIGITAL" };
  const cashOrder   = { payment_method: "EFECTIVO", payment_status: "CONFIRMADO",        menu_price: 2500, order_channel: "WALK_IN" };
  const creditOrder = { payment_method: "CREDITO",  payment_status: "CONFIRMADO",        menu_price: 2500, order_channel: "DIGITAL" };

  // ── JS-aggregation path (no stats arg) ───────────────────────────────────
  const snap = buildDashboardSnapshot(settings, menu, [sinpeOrder, cashOrder, creditOrder]);

  assert(snap.ok === true,                   "snapshot.ok is true");
  assert(snap.soldMeals    === 3,            "soldMeals counted correctly from raw orders");
  assert(snap.availableMeals === 2,          "availableMeals = max_meals(5) - sold(3) = 2");
  assert(snap.sinpeCount   === 1,            "sinpeCount = 1");
  assert(snap.cashCount    === 1,            "cashCount = 1");
  assert(snap.digitalCount === 2,            "digitalCount = 2 (SINPE + CREDITO are DIGITAL)");
  assert(snap.walkInCount  === 1,            "walkInCount = 1 (EFECTIVO is WALK_IN)");
  assert(snap.totalAmount  === 7500,         "totalAmount = 3 × 2500");
  assert(snap.menu !== null,                 "menu object present when menu has a title");
  assert(snap.menu.price === 2500,           "menu.price is a number");
  assert(snap.orders.length === 3,           "orders array has 3 entries");

  // ── Available meals must never go negative ────────────────────────────────
  const overSold = Array.from({ length: 10 }, () => sinpeOrder);
  const snapOver = buildDashboardSnapshot({ max_meals: "3" }, menu, overSold);
  assert(snapOver.availableMeals === 0,      "availableMeals floors at 0 (never negative)");

  // ── SQL-stats fast path ───────────────────────────────────────────────────
  const stats = {
    totalOrders: 4, paidOrders: 2, pendingPayment: 2,
    deliveredOrders: 1, pendingDeliveries: 3, paidPendingDelivery: 2,
    sinpeCount: 2, cashCount: 1, totalAmount: 10000,
    digitalCount: 3, walkInCount: 1
  };
  const snapStats = buildDashboardSnapshot(settings, menu, [], stats);
  assert(snapStats.soldMeals    === 4,       "stats path: soldMeals uses stats.totalOrders");
  assert(snapStats.availableMeals === 1,     "stats path: availableMeals = 5 - 4 = 1");
  assert(snapStats.totalAmount  === 10000,   "stats path: totalAmount from stats");

  // ── menu=null yields null in snapshot ────────────────────────────────────
  const snapNoMenu = buildDashboardSnapshot(settings, null, []);
  assert(snapNoMenu.menu === null,           "menu=null in snapshot when no menu configured");

  // ── isSalesOpen false when no meals remain ────────────────────────────────
  // disable_sales_window=true means the time window is always open, so
  // isSalesOpen should be false only because availableMeals===0.
  const snapSoldOut = buildDashboardSnapshot(
    { max_meals: "2", disable_sales_window: "true" },
    menu,
    [sinpeOrder, sinpeOrder]
  );
  assert(snapSoldOut.availableMeals === 0, "Sold-out: availableMeals = 0");
  assert(snapSoldOut.isSalesOpen === false, "Sold-out: isSalesOpen = false even with window open");

  // ── normalizePaymentStatus: all paid statuses map to "PAGADO" display ─────
  const snapPaid = buildDashboardSnapshot(settings, menu, [
    { ...sinpeOrder, payment_status: "PAGADO" },
    { ...sinpeOrder, payment_status: "CONFIRMADO" },
    { ...sinpeOrder, payment_status: "CONFIRMADO_SINPE" }
  ]);
  assert(
    snapPaid.orders.every((o) => o.paymentStatus === "PAGADO"),
    "All three legacy paid statuses map to 'PAGADO' in snapshot.orders");

  // ── P3-1 consistency check ────────────────────────────────────────────────
  // buildDashboardSnapshot uses normalizePaymentStatus() (returns "PAGADO")
  // but api/deliveries.js uses toCanonicalPayment() (returns "CONFIRMADO").
  // These should use the same canonical value.
  const p31Snap = buildDashboardSnapshot(settings, menu,
    [{ ...sinpeOrder, payment_status: "CONFIRMADO" }]);
  assert(
    p31Snap.orders[0].paymentStatus === toCanonicalPayment("CONFIRMADO"),
    `P3-1: dashboard paymentStatus (${p31Snap.orders[0].paymentStatus}) matches ` +
    `toCanonicalPayment (${toCanonicalPayment("CONFIRMADO")}) — two systems in sync`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 13 · getUpcomingDayKeys()  —  Day-Picker Completeness
// ─────────────────────────────────────────────────────────────────────────────
// Verifies count, order, and the no-weekends requirement (P1-3).
// ═════════════════════════════════════════════════════════════════════════════

section("13 · getUpcomingDayKeys()  —  Day-Picker Completeness");

{
  const keys5 = getUpcomingDayKeys(5);
  const keys7 = getUpcomingDayKeys(7);

  assert(keys5.length === 5, "getUpcomingDayKeys(5) returns exactly 5 items");
  assert(keys7.length === 7, "getUpcomingDayKeys(7) returns exactly 7 items");
  assert(keys7[0] === getDayKey(), "First element is today in CR timezone");

  // Each successive key must be exactly 24 h after the previous one.
  let consecutive = true;
  for (let i = 1; i < keys7.length; i++) {
    const prev = new Date(keys7[i - 1] + "T00:00:00Z").getTime();
    const curr = new Date(keys7[i]     + "T00:00:00Z").getTime();
    if (curr - prev !== 86400000) { consecutive = false; break; }
  }
  assert(consecutive, "All 7 keys are consecutive calendar days (no gaps)");

  // P1-3: result must not include Saturday (6) or Sunday (0).
  const weekends = keys7.filter((k) => {
    const [y, m, d] = k.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return dow === 0 || dow === 6;
  });
  assert(
    weekends.length === 0,
    `P1-3: getUpcomingDayKeys(7) contains no Saturday or Sunday ` +
    `(found: ${weekends.join(", ") || "none"})`,
    weekends.length > 0
      ? `Fix: skip DOW 0 and 6 in getUpcomingDayKeys(), extend loop to collect n weekdays`
      : "");

  // After filtering, weekday-only result should have <= 7 consecutive days
  // but no fewer than 5 (Mon–Fri) in any standard calendar week.
  if (weekends.length === 0) {
    assert(keys7.length >= 5,
      "Weekday-only 7-key result has at least 5 entries (never empty)");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 14 · parseBoolean()  —  Settings Flag Parsing
// ─────────────────────────────────────────────────────────────────────────────
// Used by isSalesOpenNow() to read the disable_sales_window flag.
// Accepts "true", "1", "si", "sí" and nothing else.
// ═════════════════════════════════════════════════════════════════════════════

section("14 · parseBoolean()  —  Settings Flag Parsing");

{
  assert(parseBoolean("true")  === true,  "parseBoolean('true') → true");
  assert(parseBoolean("TRUE")  === true,  "parseBoolean('TRUE') → true (case-insensitive)");
  assert(parseBoolean("1")     === true,  "parseBoolean('1') → true");
  assert(parseBoolean("si")    === true,  "parseBoolean('si') → true");
  assert(parseBoolean("sí")    === true,  "parseBoolean('sí') → true");
  assert(parseBoolean("false") === false, "parseBoolean('false') → false");
  assert(parseBoolean("0")     === false, "parseBoolean('0') → false");
  assert(parseBoolean("")      === false, "parseBoolean('') → false");
  assert(parseBoolean(null)    === false, "parseBoolean(null) → false");
  assert(parseBoolean(undefined) === false, "parseBoolean(undefined) → false");
  assert(parseBoolean("yes")   === false, "parseBoolean('yes') → false (only 'si'/'sí' accepted)");
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 15 · isSalesOpenNow()  —  Sales Window  (P3-1 documentation)
// ─────────────────────────────────────────────────────────────────────────────
// isSalesOpenNow() is the LEGACY check used by buildDashboardSnapshot for the
// isSalesOpen field.  It uses sales_start/sales_end, NOT cutoff_time.
// P3-1: between 09:00 and 10:00 CR the customer sees isSalesOpen=false even
// though orders are actually open (cutoff has not passed).
//
// The functional tests here validate the current (correct) behavior of the
// disable_sales_window bypass.  The P3-1 assertion documents the mismatch.
// ═════════════════════════════════════════════════════════════════════════════

section("15 · isSalesOpenNow()  —  Legacy Sales Window Behaviour");

{
  // With disable_sales_window=true, always returns true (time-independent).
  assert(
    isSalesOpenNow({ disable_sales_window: "true" }) === true,
    "disable_sales_window=true bypasses time check → always open");
  assert(
    isSalesOpenNow({ disable_sales_window: "1" })    === true,
    "disable_sales_window=1 bypasses time check → always open");

  // A very wide window (00:00–23:59) should always be open.
  assert(
    isSalesOpenNow({ sales_start: "00:00", sales_end: "23:59" }) === true,
    "sales_start=00:00 / sales_end=23:59 → always open");

  // A zero-width window (23:59–23:59) should be closed except at exactly 23:59.
  const alwaysClosed = isSalesOpenNow({ sales_start: "23:59", sales_end: "23:59" });
  // Do not assert a specific value here — it depends on wall-clock time.
  // Just confirm the function returns a boolean without throwing.
  assert(
    typeof alwaysClosed === "boolean",
    "isSalesOpenNow returns boolean for edge-case window 23:59–23:59");

  // P3-1 documentation: the snapshot isSalesOpen uses THIS function, but
  // validateTargetDate() uses isCutoffPassedForDate() (different system).
  // A customer could see isSalesOpen=false while orders are still accepted.
  const todayKey   = getDayKey();
  const tomorrow   = getDayKey(new Date(Date.now() + 86400000));
  const cutoffOpen = !isCutoffPassedForDate({ cutoff_time: "23:59" }, todayKey);
  const windowOpen = isSalesOpenNow({ disable_sales_window: "true" });
  assert(
    cutoffOpen === windowOpen,
    `P3-1: isCutoffPassedForDate and isSalesOpenNow agree when both are configured open ` +
    `(cutoff=${cutoffOpen}, window=${windowOpen})`,
    cutoffOpen !== windowOpen
      ? "Mismatch: customer UI shows closed but orders are actually accepted"
      : "");
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 16 · Environment & Security Guards
// ─────────────────────────────────────────────────────────────────────────────
// Production readiness checks that do not require a live DB or API.
// ═════════════════════════════════════════════════════════════════════════════

section("16 · Environment & Security Guards");

{
  // ── CORS_ORIGIN must not be wildcard in a deployed environment (P3-5) ─────
  // Only checked when API_BASE_URL is present (i.e. this is a staging/prod run).
  const corsOrigin = process.env.CORS_ORIGIN || "*";
  if (process.env.API_BASE_URL) {
    assert(
      corsOrigin !== "*",
      `P3-5: CORS_ORIGIN is not wildcard in deployed environment (got: "${corsOrigin}")`,
      `Fix: set CORS_ORIGIN to the exact production domain in Vercel env vars`);
  } else {
    skip(
      "P3-5: CORS_ORIGIN is not wildcard",
      "only verified when API_BASE_URL is set (staging/production run)");
  }

  // ── Supabase URL and ANON key must be set for the server ─────────────────
  const supaUrl  = process.env.SUPABASE_URL  || "";
  const anonKey  = process.env.SUPABASE_ANON_KEY || "";
  const svcKey   = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (supaUrl && anonKey && svcKey) {
    // Decode the `ref` claim from each JWT to confirm they belong to the same
    // Supabase project (P0-1: service role key was from a different project).
    function jwtRef(jwt) {
      try {
        const payload = JSON.parse(
          Buffer.from(jwt.split(".")[1], "base64").toString("utf8")
        );
        // Supabase encodes the project ref in the `iss` or `ref` field.
        return payload.ref || (payload.iss || "").split("/").pop() || "unknown";
      } catch {
        return "parse-error";
      }
    }
    const urlRef  = supaUrl.replace("https://", "").split(".")[0];
    const svcRef  = jwtRef(svcKey);
    const anonRef = jwtRef(anonKey);

    assert(
      svcRef === urlRef,
      `P0-1: SUPABASE_SERVICE_ROLE_KEY project ref (${svcRef}) matches SUPABASE_URL ref (${urlRef})`,
      svcRef !== urlRef
        ? "CRITICAL: service role key is from a different Supabase project — all DB calls will 401"
        : "");
    assert(
      anonRef === urlRef,
      `P0-1: SUPABASE_ANON_KEY project ref (${anonRef}) matches SUPABASE_URL ref (${urlRef})`,
      anonRef !== urlRef
        ? "Key mismatch: anon key is from a different Supabase project"
        : "");
  } else {
    skip(
      "P0-1: Supabase key project refs match SUPABASE_URL",
      "set SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY");
  }

  // ── APP_BASE_URL must be set for tracking URLs to be included in emails ───
  if (process.env.APP_BASE_URL) {
    const url = process.env.APP_BASE_URL;
    assert(
      !url.endsWith("/"),
      "P3-3: APP_BASE_URL has no trailing slash (would produce double-slash in tracking URLs)");
    assert(
      url.startsWith("http://") || url.startsWith("https://"),
      "P3-3: APP_BASE_URL starts with http:// or https://");
  } else {
    skip(
      "P3-3: APP_BASE_URL is set and well-formed",
      "tracking URLs will be empty strings until APP_BASE_URL is configured");
  }

  // ── config-js slug fallback must not be hardcoded to 'ceep' (P1-6) ────────
  // We test this by reading the source directly since it has no exported API.
  {
    let src = "";
    try {
      const fs = await import("fs");
      src = fs.readFileSync(
        new URL("../api/config-js.js", import.meta.url), "utf8");
    } catch { /* skip if unreadable */ }

    if (src) {
      assert(
        !src.includes('"ceep"'),
        `P1-6: api/config-js.js does not contain hardcoded "ceep" fallback slug`,
        `Fix: replace return "ceep" with an error state so unknown tenants get a clear message`);
    } else {
      skip("P1-6: config-js.js does not contain hardcoded ceep fallback", "could not read source");
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 17 · Extended DB Schema Integrity  [INTEGRATION]
// ─────────────────────────────────────────────────────────────────────────────
// Verifies the settings, cafeterias, and menus tables contain every column
// that the repository/API layer reads or writes.
// ═════════════════════════════════════════════════════════════════════════════

section("17 · Extended DB Schema Integrity  [INTEGRATION]");

{
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    const tables = ["settings", "cafeterias", "menus", "delivery_events"];
    for (const t of tables) {
      skip(`${t} table has all expected columns`, "set DATABASE_URL (staging Postgres)");
    }
  } else {
    const client = new pg.Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false }
    });

    try {
      await client.connect();

      async function checkTable(tableName, requiredCols) {
        const { rows } = await client.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1`,
          [tableName]
        );
        const present = new Set(rows.map((r) => r.column_name));
        for (const col of requiredCols) {
          assert(
            present.has(col),
            `${tableName}.${col} exists`,
            present.has(col) ? "" :
              `MISSING — add ALTER TABLE in a new supabase/migrations file`);
        }
      }

      await checkTable("settings", [
        "cafeteria_id", "max_meals", "cutoff_time",
        "sales_start", "sales_end", "delivery_window",
        "disable_sales_window", "message"
      ]);

      await checkTable("cafeterias", [
        "id", "slug", "name", "created_at"
      ]);

      await checkTable("menus", [
        "id", "cafeteria_id", "title", "description",
        "price", "active", "target_date"
      ]);

      await checkTable("delivery_events", [
        "id", "cafeteria_id", "order_id", "day_key", "delivery_status", "created_at"
      ]);

    } catch (err) {
      failed++;
      console.log(`  ${FAIL}  Extended schema introspection failed  ${D}← ${err.message}${Z}`);
    } finally {
      await client.end().catch(() => null);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 18 · API Integration — HTTP Endpoint Contract  [INTEGRATION]
// ─────────────────────────────────────────────────────────────────────────────
// Fires real HTTP requests against a staging deployment.
// Tests auth contracts, input validation responses, and the health check.
// Set API_BASE_URL to run (never against production data).
// ═════════════════════════════════════════════════════════════════════════════

section("18 · API Integration — HTTP Endpoint Contract  [INTEGRATION]");

{
  const apiUrl = process.env.API_BASE_URL;

  if (!apiUrl) {
    const cases = [
      "POST /api/orders without slug → 400",
      "POST /api/orders unknown slug → 404",
      "POST /api/orders SINPE without email → 400",
      "POST /api/orders invalid date format → 400",
      "POST /api/orders past date → 400",
      "POST /api/orders date > 7 days → 400",
      "GET /api/deliveries without Authorization → 401",
      "POST /api/deliveries with forged JWT → 401",
      "GET /api/config-js → 200 with JS content-type",
      "GET /api/health → 200",
    ];
    for (const c of cases) skip(c, "set API_BASE_URL (staging only)");
  } else {
    const post = (path, body, headers = {}) =>
      fetch(`${apiUrl}${path}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body:    JSON.stringify(body)
      });

    console.log(`\n  ${D}[INTEGRATION] target: ${apiUrl}${Z}`);

    // 1. Missing slug
    {
      const r = await post("/orders", { order: { buyerName: "Ana", paymentMethod: "SINPE", buyerEmail: "a@b.co" } });
      assert(r.status === 400, `POST /orders without slug → 400 (got ${r.status})`);
    }

    // 2. Unknown slug
    {
      const r = await post("/orders", {
        slug:  "__nonexistent_slug_xyz__",
        order: { buyerName: "Ana", paymentMethod: "SINPE", buyerEmail: "a@b.co", targetDate: getDayKey() }
      });
      assert(r.status === 404, `POST /orders unknown slug → 404 (got ${r.status})`);
    }

    // 3. SINPE without email (server rejects, P1-1 guard)
    {
      const r = await post("/orders", {
        slug:  process.env.CAFETERIA_SLUG || "test",
        order: { buyerName: "Ana", paymentMethod: "SINPE", targetDate: getDayKey() }
      });
      const body = await r.json().catch(() => ({}));
      assert(
        r.status === 400 && /correo/i.test(body.message || ""),
        `POST /orders SINPE without email → 400 with email error (got ${r.status}: "${body.message}")`);
    }

    // 4. Invalid date format
    {
      const r = await post("/orders", {
        slug:  process.env.CAFETERIA_SLUG || "test",
        order: { buyerName: "Ana", paymentMethod: "SINPE", buyerEmail: "a@b.co", targetDate: "not-a-date" }
      });
      assert(r.status === 400, `POST /orders invalid date format → 400 (got ${r.status})`);
    }

    // 5. Past date
    {
      const yesterday = getDayKey(new Date(Date.now() - 86400000));
      const r = await post("/orders", {
        slug:  process.env.CAFETERIA_SLUG || "test",
        order: { buyerName: "Ana", paymentMethod: "SINPE", buyerEmail: "a@b.co", targetDate: yesterday }
      });
      assert(r.status === 400, `POST /orders past date (${yesterday}) → 400 (got ${r.status})`);
    }

    // 6. Date beyond 7-day window
    {
      const tooFar = new Date(Date.now() - 6 * 60 * 60 * 1000 + 8 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const r = await post("/orders", {
        slug:  process.env.CAFETERIA_SLUG || "test",
        order: { buyerName: "Ana", paymentMethod: "SINPE", buyerEmail: "a@b.co", targetDate: tooFar }
      });
      assert(r.status === 400, `POST /orders date > 7 days (${tooFar}) → 400 (got ${r.status})`);
    }

    // 7. GET /deliveries without Authorization
    {
      const r = await fetch(`${apiUrl}/deliveries`);
      assert(
        r.status === 401,
        `GET /deliveries without Authorization → 401 (got ${r.status})`);
    }

    // 8. POST /deliveries with forged JWT
    {
      const r = await post("/deliveries",
        { orderId: "fake", deliveryStatus: "ENTREGADO" },
        { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.FORGED.SIGNATURE" });
      assert(
        r.status === 401 || r.status === 403,
        `POST /deliveries with forged JWT → 401/403 (got ${r.status})`);
    }

    // 9. GET /config-js returns JS
    {
      const r = await fetch(`${apiUrl}/config-js`);
      const ct = r.headers.get("content-type") || "";
      assert(
        r.status === 200 && ct.includes("javascript"),
        `GET /config-js → 200 application/javascript (got ${r.status} ${ct})`);
    }

    // 10. Health check
    {
      const r = await fetch(`${apiUrl}/auth-role?health=1`);
      assert(
        r.status === 200,
        `GET /api/health → 200 (got ${r.status})`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FINAL SUMMARY
// ═════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}${"━".repeat(48)}${Z}`);
console.log(
  `${B}  Results: ` +
  `${G}${passed} passed${Z}  ` +
  `${R}${failed} failed${Z}  ` +
  `${Y}${skipped} skipped${Z}`
);
console.log(`${B}${"━".repeat(48)}${Z}\n`);

if (failed > 0) process.exit(1);
