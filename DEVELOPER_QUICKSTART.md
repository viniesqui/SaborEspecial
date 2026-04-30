# Developer Quickstart — Sabor Especial

Zero to running, locally or in production, with one command at each stage.

---

## Prerequisites

| Tool | Min version |
|------|-------------|
| Node.js | 18+ |
| Git | any |

`npm run setup` installs the Vercel CLI for you if it's missing. You also need a free [Supabase](https://supabase.com) project — keep its **URL**, **anon key**, **service_role key**, and **DB password** (Settings → API and Settings → Database) handy.

---

## Local development

```bash
git clone https://github.com/viniesqui/saborespecial.git
cd saborespecial
npm run setup   # asks for Supabase credentials once, then migrates + seeds
npm start       # http://localhost:3000
```

`npm run setup` is idempotent — re-run it any time. It writes `.env.local`, runs every migration in `supabase/migrations/`, seeds a test cafetería, and prints the admin/kitchen passwords plus URLs.

The frontend loads its public Supabase config from `GET /config.js` (served by `api/config-js.js`), so there is no `config.js` to edit by hand. Schema is applied by `scripts/migrate.js` — no SQL editor required.

---

## URLs

| Quién | URL |
|-------|-----|
| Customers | `/s/<slug>` |
| Admin | `/management.html?slug=<slug>` (password: `ADMIN_SECRET`) |
| Kitchen | `/deliveries.html?slug=<slug>` (password: `ORDERS_PASSWORD`) |
| Tracking | `/track.html?slug=<slug>` |

Both passwords are auto-generated on first setup and stored in `.env.local`.

---

## Verify the stack

```bash
curl http://localhost:3000/api/health
curl "http://localhost:3000/api/dashboard?slug=test-cafeteria"
curl "http://localhost:3000/api/menu?slug=test-cafeteria"
```

All three return JSON. If `dashboard` returns `cafeteria not found`, re-run `npm run setup`.

---

## Tests

```bash
npm test                                       # against localhost
API_BASE_URL=https://your-domain.com npm test  # against any deploy
```

Suites that need extra env vars (multi-tenant tokens) skip gracefully. The six suites cover midnight reset, race conditions, multi-tenant isolation, latency resilience, input validation, and offline cache.

---

## Production deploy

```bash
vercel link                              # one-time
vercel env pull .env.production.local    # or set vars in dashboard
vercel --prod
```

Push the same variables `npm run setup` wrote to `.env.local` into Vercel (Settings → Environment Variables). Set `CORS_ORIGIN` to your exact frontend domain instead of `*`. The frontend resolves `apiBaseUrl` from `window.location.origin`, so no code change is needed for a custom domain.

For email notifications, create a [Resend](https://resend.com) API key, verify a sender domain, and set `RESEND_API_KEY`. If left blank, email calls fail silently and are logged to `error_logs`.

To onboard additional cafeterías after launch:

```bash
curl -X POST https://your-domain.com/api/onboard \
  -H "Content-Type: application/json" \
  -d '{"slug":"mi-soda","name":"Mi Soda","adminEmail":"admin@mi-soda.com"}'
```

The onboarding trigger creates the row plus default settings (15 meals, 10:00–12:00 CR window, `America/Costa_Rica` timezone).

---

## Manual testing (no automated coverage)

Walk these before a real launch — see `PRODUCTION_CHECKLIST.md` for the full version.

| Area | How |
|------|-----|
| SINPE payment flow | Order with SINPE → confirm phone number in confirmation |
| Credits / packages | Buy a package → spend a credit → balance updates |
| Excel export | Click `Exportar Excel` in admin → check CSV columns |
| Email notifications | Set real `RESEND_API_KEY`, place order with email |
| Offline fallback | DevTools → Network → Offline, reload, last snapshot shows |
| Slow 3G | DevTools throttle → submit order, no double-submit |
| Midnight rollover | Around 06:00 UTC, counter resets without a deploy |
| Multi-tenant isolation | Two cafeterías → orders don't leak across them |

---

## Project structure

```
/
├── *.html, *.js, styles.css   # static frontend (no build step)
├── api/                        # Vercel serverless functions
│   ├── config-js.js            # serves /config.js to the browser
│   ├── health.js, dashboard.js, menu.js, orders.js, …
│   └── onboard.js
├── lib/                        # backend utilities (auth, email, logging)
├── data/                       # repository layer (DB queries)
├── supabase/migrations/        # SQL migrations applied by scripts/migrate.js
├── scripts/
│   ├── migrate.js              # headless schema migration
│   ├── seed.js                 # test cafetería seed
│   └── test-integrity.js       # automated test suite
└── shared/                     # shared browser utilities
```

---

## Common issues

**`cafeteria not found` on every API call**
The slug doesn't match a row in `cafeterias`. Re-run `npm run setup` or check the slug in the URL.

**`invalid API key` from Supabase**
Anon and service_role keys are swapped. Backend uses `SUPABASE_SERVICE_ROLE_KEY`; the browser receives the anon key from `/config.js`. Re-run setup.

**Order count doesn't reset at midnight**
The reset is timezone-aware (`America/Costa_Rica`, UTC-6). `getDayKey()` in `app.js` handles this — confirm the host clock and Supabase project aren't filtering by raw UTC.

**`vercel dev` can't find env vars**
Run `vercel link`, then `vercel env pull .env.local`. The CLI reads `.env.local` automatically.

**Service Worker serving stale pages after a deploy**
Bump the cache version constant in `sw.js` and redeploy. Clients pick up the new version on next load.

---

## Going-live checklist

| # | Item | Done when… |
|---|------|------------|
| 1 | Vercel deployment with all env vars | `GET /api/health` returns 200 |
| 2 | Cafeteria onboarded via `/api/onboard` | Slug returns data from `/api/dashboard` |
| 3 | Email configured (Resend) | Test order sends a confirmation |
| 4 | RLS active on all tables | `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'` returns `t` everywhere |
| 5 | Staff URLs shared | Admin, kitchen, customer links bookmarked |
| 6 | `PRODUCTION_CHECKLIST.md` green | All 8 checks marked DONE |
| 7 | First 30 min of lunch monitored | No errors in Vercel/Supabase logs |
