# SaborEspecial API

Canonical reference for the public HTTP surface. Tenant resolution
(WS-01) is in flight; until it lands, staff endpoints derive
`cafeteria_id` from the authenticated JWT and the public dashboard
accepts a `?slug=` parameter as a fallback.

## `GET /api/dashboard`

Primary read endpoint for both the customer day view and the
management console. Returns a snapshot built by
`lib/dashboard.js :: buildDashboardSnapshot` from today's settings,
menu, orders, and aggregate stats.

### Auth

- `Authorization: Bearer <jwt>` — for `ADMIN`, `HELPER`, or `ORDERS`
  roles. Resolves the cafeteria from the JWT claim.
- `?slug=<cafeteria-slug>` — public fallback for the customer page;
  ignored when an `Authorization` header is present.

### Query parameters

| Param     | Values           | Effect                                                                                  |
|-----------|------------------|-----------------------------------------------------------------------------------------|
| `slug`    | string           | Public tenant slug (used only when no `Authorization` header is sent).                  |
| `week`    | `"true"`         | Adds `weekMenus[]` + `cutoffTime` for the customer's day-selector UI. Includes per-day  |
|           |                  | `availableMeals` and `isOrderingOpen`.                                                  |
| `include` | comma-separated  | Optional resource toggles. Currently supports `menu`.                                   |
|           | `menu`           | Returns the management weekly menu grid: `{ ok, weekMenus: [{ date, menu }] }`. This    |
|           |                  | replaces the previous `GET /api/menu` response shape.                                   |

The base response (no `include`, no `week`) is the customer dashboard
snapshot and preserves the prior `/api/dashboard` behavior bit-for-bit.

## `POST /api/dashboard`

Upserts the menu for a given day. Replaces the previous
`POST /api/menu` handler. Requires `ADMIN` or `HELPER` auth.

### Body

```json
{
  "menu":   { "title": "string", "description": "string", "price": number, "cost"?: number },
  "dayKey": "YYYY-MM-DD",
  "validateOnly": false
}
```

- `dayKey` defaults to today (Costa Rica) when omitted.
- `validateOnly: true` short-circuits to a role-confirmation response
  without writing.

### Response

```json
{
  "ok":       true,
  "message":  "Menú guardado correctamente.",
  "dayKey":   "YYYY-MM-DD",
  "snapshot": { /* same shape as GET /api/dashboard */ }
}
```

## `GET /api/menu` and `POST /api/menu` — DEPRECATED (R-07-2)

Thin proxy retained for **one deploy cycle** so older client builds
keep working during rollout. Behavior:

- `GET /api/menu` → forwards to `GET /api/dashboard?include=menu`.
- `POST /api/menu` → forwards to `POST /api/dashboard`.

Frontend callers in `management.js` were migrated to
`/api/dashboard` in the same change that introduced this proxy.
The proxy will be removed in the next sprint; do not add new
callers.

## Other endpoints

See the source files in `api/` for the remaining handlers
(`admin-orders`, `orders`, `deliveries`, `accounting`, `credits`,
`packages`, `track`, `onboard`, `auth-role`, `config-js`). They are
out of scope for WS-07 and unchanged.
