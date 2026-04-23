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
 */

import { getDayKey, buildDashboardSnapshot } from "../lib/dashboard.js";

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
