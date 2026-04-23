# Sabor Especial — Production Readiness Checklist

Go / No-Go before the first 12:00 PM cafeteria rush.
Mark each item **[DONE]** or **[BLOCKED reason]**.

---

## 0 · Pre-Flight (run once before deploying)

| # | Check | Expected |
|---|-------|----------|
| 0.1 | `node scripts/test-integrity.js` passes with 0 failures | All suites green |
| 0.2 | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CAFETERIA_ID`, `APP_BASE_URL` set in deployment env | No 500s on cold start |
| 0.3 | `SUPABASE_ANON_KEY` set in `config.js` / CDN env for the browser | Login works |
| 0.4 | `place_order_atomic` Postgres function deployed (see Suite 2 comment) | Race condition closed |
| 0.5 | `isSalesOpenNow()` timezone fix applied (Suite 5, HIGH finding #2) | Window is 10:00–12:00 CR, not 04:00–06:00 CR |
| 0.6 | `getDayKey()` refactored to use `Intl.DateTimeFormat` (Suite 5, HIGH finding #1) | Correct date after any timezone policy change |

---

## 1 · Service Worker Installation

**Goal:** Confirm `sw.js` installs, activates, and serves the correct cache version.

### Steps

1. Open `customer-app.html` in Chrome DevTools → **Application → Service Workers**.
2. Confirm status shows **"activated and is running"** with source `sw.js`.
3. Check **Cache Storage → ceep-lunch-static-v11** contains all assets from the
   `STATIC_ASSETS` list in `sw.js` (index.html, app.js, styles.css, etc.).
4. Check **Cache Storage → ceep-api-v1** is present (may be empty on first load).
5. Hard-reload the page (`Ctrl+Shift+R`). In the Network tab, static assets must
   show `(ServiceWorker)` as the initiator — not the network.

### Pass Criteria
- No `sw.js` errors in the Console.
- `ceep-lunch-static-v11` cache exists and is fully populated.
- Old cache versions (`ceep-lunch-static-v1` … `v10`) are **absent** — the
  `activate` handler in `sw.js` deletes unknown caches automatically.

---

## 2 · Offline-First / Cache Fallback

**Goal:** Buyers list and menu are served from `ceep-api-v1` when offline.

### Steps

1. Load `customer-app.html` while online. Wait for the sync banner to show
   "Sincronizado a las HH:MM" (data in `ceep-api-v1` is now warm).
2. DevTools → **Network tab → throttling dropdown → Offline**.
3. Reload the page (`Ctrl+R` — not hard reload; that bypasses the SW).
4. Verify:
   - The **menu title, price, and description** render correctly.
   - The **buyers list** renders the last known orders.
   - The **status banner** shows `"Sin conexión — mostrando datos guardados"`.
   - The **submit button is disabled** (snapshot shows `isSalesOpen=false` since
     the API could not confirm the live state).
5. Re-enable the network. Verify the banner transitions to "Sincronizando…"
   then "Sincronizado a las HH:MM" within one 30-second poll cycle.

### Pass Criteria
- No blank / broken UI while offline.
- No JavaScript errors in the Console.
- Submit button is disabled offline (prevents ghost orders that can never reach the API).

### Edge Case — Stale Cache
- If the menu changed after the last online load, the offline view shows the
  **old** menu. This is acceptable (noted in `sw.js` Network-First strategy).
- Confirm `localStorage` key `config.cacheKey` (set in `config.js`) stores the
  last good snapshot for `loadCachedSnapshot()` in `app.js`.

---

## 3 · SINPE Payment State Verification

**Goal:** Payment status transitions are correct and visible in the admin panel.

| Transition | Trigger | Expected buyer badge | Expected admin badge |
|-----------|---------|----------------------|----------------------|
| PENDIENTE_DE_PAGO → CONFIRMADO_SINPE | Admin clicks "Confirmado" | PAGADO (green) | PAGADO (green) |
| PENDIENTE_DE_PAGO → POR_VERIFICAR   | Intermediate state       | PENDIENTE DE PAGO (grey) | PENDIENTE DE PAGO (grey) |
| Any → CANCELADO                     | record_status update     | Order disappears from buyers list (excluded by `.neq("record_status","CANCELADO")` query) | — |

### Steps

1. Place a test order via SINPE on `customer-app.html`.
2. Open `admin.html` → Operations tab → confirm order appears with "PENDIENTE DE PAGO".
3. Click **"Confirmado"** on the order. Verify:
   - Admin panel badge turns green.
   - `payment_confirmed_at` timestamp appears.
   - Email notification sent (check inbox or Resend/SendGrid logs).
4. Reload `customer-app.html`. Verify the buyers list shows PAGADO for that order.
5. Confirm the `sinpeCount` in the dashboard snapshot increments correctly.

### Pass Criteria
- Payment state visible to the buyer within the 30-second auto-refresh cycle.
- `payment_confirmed_at` persisted in `orders` table.
- No double-confirmation possible (button is disabled after click while request is in-flight).

---

## 4 · 12:00 PM Rush — High-Latency Load State

**Goal:** Under 2 000 ms API latency the submit button stays disabled (no double orders).

### Manual Simulation

1. DevTools → Network tab → throttling → **"Slow 3G"** (≈1 400 ms RTT).
2. Load `customer-app.html`, fill in Name + SINPE payment method.
3. Click **"Comprar Almuerzo"** — immediately click again several times.
4. Observe:
   - Button becomes **disabled** on the first click.
   - Feedback shows "Registrando compra..."
   - Only **one** POST to `/orders` appears in the Network tab.
   - After response, the button re-enables (or stays disabled if sold out).

### Automated Check
`scripts/test-integrity.js` Suite 4 validates the `isSubmitting` guard
programmatically with a 2 000 ms simulated latency.

### Pass Criteria
- Exactly 1 `/orders` request per user submission, regardless of click speed.
- The `availableMeals` counter in the snapshot returned by the server is the
  authoritative value — the UI re-renders from it after each successful order.

---

## 5 · Multi-Tenant Isolation Smoke Test

**Goal:** One cafeteria cannot see another cafeteria's orders.

> Requires a second test cafeteria on the same Supabase project.

### Steps

1. Set env vars `CAFETERIA_A_TOKEN` and `CAFETERIA_B_ID` (see `test-integrity.js`).
2. Run `node scripts/test-integrity.js` — Suite 3 executes automatically.
3. Manual check: log into `admin.html` with Cafeteria A credentials.
4. Attempt to open `admin.html` with a URL parameter for Cafeteria B's ID.
5. Verify the admin panel shows **only Cafeteria A's orders**.

### Pass Criteria
- `requireAuth()` in `lib/auth.js` always derives `cafeteria_id` from the
  Supabase JWT, never from a client-supplied header or query parameter.
- A forged or expired JWT returns HTTP 401; a valid but wrong-tenant JWT
  returns an empty dataset (not a 403, because the route is valid — just empty).

---

## 6 · Midnight Reset Manual Validation

**Goal:** `availableMeals` counter resets to `max_meals` at 00:00 CR without a server restart.

### Steps

1. At 23:55 CR (05:55 UTC), load the dashboard. Note `availableMeals` and `soldMeals`.
2. Wait until 00:01 CR (06:01 UTC).
3. Reload the page (or wait for the 30-second auto-refresh).
4. Verify `availableMeals` equals `max_meals` from `settings` and `soldMeals = 0`.

### Automated Check
`scripts/test-integrity.js` Suite 1 validates the timezone boundary logic
for `getDayKey()` using fixed UTC timestamps. No server restart is required
because `getDayKey()` calls `new Date()` on every request.

### Pass Criteria
- Day boundary triggers at exactly 06:00 UTC (00:00 CR).
- Prior-day orders do **not** appear in the new day's count.
- No manual intervention or cron job needed for the reset.

---

## 7 · Cache Version Bump Protocol

When static assets change (new deploy):

1. Increment `CACHE_NAME` in `sw.js`: `ceep-lunch-static-vN` → `ceep-lunch-static-v(N+1)`.
2. Deploy. The `install` event pre-caches the new assets.
3. The `activate` event deletes all caches **not** in `KNOWN_CACHES` (old versions).
4. Verify in DevTools that the old cache name is gone after the SW activates.

> Do **not** change `API_CACHE_NAME` (`ceep-api-v1`) unless the API response
> shape changes — users would lose their offline fallback data on activation.

---

## 8 · Post-Launch Monitoring (first 30 minutes)

| Signal | Where | Threshold |
|--------|-------|-----------|
| Order insert errors | Supabase Logs → `orders` table | 0 errors |
| `availableMeals` goes negative | Dashboard snapshot `.availableMeals` | Must be ≥ 0 always |
| Duplicate orders (same name, same minute) | `orders` table query | Investigate immediately |
| Admin JWT failures | Vercel / server logs — 401 count | Baseline < 5/min |
| SW registration failures | Browser Console errors | 0 |

---

*Last updated: 2026-04-23. Re-run this checklist before every major deploy.*
