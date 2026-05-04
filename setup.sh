#!/usr/bin/env bash
# setup.sh — zero-touch environment initialisation.
# git clone → npm run setup → npm start. That's it.
#
# Any variable can be pre-set to skip its prompt, e.g.:
#   DATABASE_URL="postgresql://..." npm run setup
set -euo pipefail

# Capture env-provided values before anything overwrites them.
_ENV_DATABASE_URL="${DATABASE_URL:-}"
_ENV_SUPABASE_URL="${SUPABASE_URL:-}"
_ENV_SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"
_ENV_SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

# ── Colour helpers ────────────────────────────────────────────────────────────
BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC}  $*"; }
warn() { echo -e "  ${YELLOW}!${NC}  $*"; }
die()  { echo -e "  ${RED}✗${NC}  $*"; exit 1; }
step() { echo -e "\n${BOLD}${BLUE}▶ $*${NC}"; }

# ── Input helper ─────────────────────────────────────────────────────────────
# read_field <prompt> <varname> [default] [secret]
read_field() {
  local prompt="$1" var="$2" default="${3:-}" secret="${4:-}"
  local hint=""; [ -n "$default" ] && hint=" [${default:0:10}…]"
  while true; do
    if [ "$secret" = "secret" ]; then
      read -rsp "  ${prompt}${hint}: " v; echo ""
    else
      read -rp  "  ${prompt}${hint}: " v
    fi
    v="${v:-$default}"
    if [ -n "$v" ]; then eval "$var=\$v"; return; fi
    echo "  Obligatorio."
  done
}

token() { node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))"; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔════════════════════════════════════════════╗"
echo    "║   Sabor Especial — Setup                   ║"
echo -e "╚════════════════════════════════════════════╝${NC}"
echo ""

# ── 1. Node 18+ ───────────────────────────────────────────────────────────────
step "Entorno"
command -v node &>/dev/null || die "Node.js no encontrado. Instalar desde https://nodejs.org"
MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
[ "$MAJOR" -ge 18 ] || die "Se requiere Node.js 18+. Versión actual: $(node -v)"
ok "Node.js $(node -v)"

command -v vercel &>/dev/null || { warn "Instalando Vercel CLI…"; npm i -g vercel --silent; }
ok "Vercel CLI $(vercel --version 2>/dev/null | head -1)"

npm install --silent
ok "Dependencias instaladas"

# ── 2. Credentials ────────────────────────────────────────────────────────────
step "Credenciales"
echo ""
echo "  Supabase Dashboard → Settings → API"
echo ""

# Load existing .env.local as defaults so re-running is painless.
SUPABASE_URL=""; SUPABASE_ANON_KEY=""; SUPABASE_SERVICE_ROLE_KEY=""
DATABASE_URL=""; ADMIN_SECRET=""; ORDERS_PASSWORD=""
CAFETERIA_SLUG="test-cafeteria"

if [ -f .env.local ]; then
  _load() { grep -E "^$1=" .env.local | cut -d= -f2- || true; }
  SUPABASE_URL=$(_load SUPABASE_URL)
  SUPABASE_ANON_KEY=$(_load SUPABASE_ANON_KEY)
  SUPABASE_SERVICE_ROLE_KEY=$(_load SUPABASE_SERVICE_ROLE_KEY)
  DATABASE_URL=$(_load DATABASE_URL)
  ADMIN_SECRET=$(_load ADMIN_SECRET)
  ORDERS_PASSWORD=$(_load ORDERS_PASSWORD)
  CAFETERIA_SLUG=$(_load CAFETERIA_SLUG); CAFETERIA_SLUG="${CAFETERIA_SLUG:-test-cafeteria}"
  echo "  .env.local encontrado — usando valores previos como default."
  echo ""
fi

# Env-provided values always override .env.local defaults.
[ -n "$_ENV_SUPABASE_URL"              ] && SUPABASE_URL="$_ENV_SUPABASE_URL"
[ -n "$_ENV_SUPABASE_ANON_KEY"         ] && SUPABASE_ANON_KEY="$_ENV_SUPABASE_ANON_KEY"
[ -n "$_ENV_SUPABASE_SERVICE_ROLE_KEY" ] && SUPABASE_SERVICE_ROLE_KEY="$_ENV_SUPABASE_SERVICE_ROLE_KEY"
[ -n "$_ENV_DATABASE_URL"              ] && DATABASE_URL="$_ENV_DATABASE_URL"

[ -n "$SUPABASE_URL"              ] && ok "SUPABASE_URL (del entorno o .env.local)" || read_field "URL del proyecto  (https://xxxx.supabase.co)" SUPABASE_URL    "$SUPABASE_URL"
[ -n "$SUPABASE_ANON_KEY"         ] && ok "SUPABASE_ANON_KEY (del entorno o .env.local)" || read_field "Clave anon"        SUPABASE_ANON_KEY        "$SUPABASE_ANON_KEY"        "secret"
[ -n "$SUPABASE_SERVICE_ROLE_KEY" ] && ok "SUPABASE_SERVICE_ROLE_KEY (del entorno o .env.local)" || read_field "Clave service_role" SUPABASE_SERVICE_ROLE_KEY "$SUPABASE_SERVICE_ROLE_KEY" "secret"

if [ -n "$DATABASE_URL" ]; then
  ok "DATABASE_URL (del entorno o .env.local)"
else
  echo ""
  echo "  Para migrar el esquema necesitamos la cadena de conexión de tu proyecto."
  echo "  Supabase Dashboard → Settings → Database → Connection string"
  echo "  Selecciona 'Session pooler' y copia el URI completo."
  echo "  Luego reemplaza [YOUR-PASSWORD] con tu contraseña real."
  echo ""
  read_field "Database URL (postgresql://postgres.xxx:[password]@...)" DATABASE_URL "$DATABASE_URL" "secret"
fi

SUPABASE_URL="${SUPABASE_URL%/}"

# Auto-generate local secrets on first run.
[ -z "$ADMIN_SECRET"    ] && ADMIN_SECRET=$(token)
[ -z "$ORDERS_PASSWORD" ] && ORDERS_PASSWORD=$(token)

# ── 3. Write .env.local ───────────────────────────────────────────────────────
step "Generando .env.local"
cat > .env.local <<EOF
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
DATABASE_URL=${DATABASE_URL}
APP_BASE_URL=http://localhost:3000
ADMIN_SECRET=${ADMIN_SECRET}
ORDERS_PASSWORD=${ORDERS_PASSWORD}
CORS_ORIGIN=*
RESEND_API_KEY=
CAFETERIA_SLUG=${CAFETERIA_SLUG}
EOF
ok ".env.local creado"

# ── 4. Run migrations (headless) ──────────────────────────────────────────────
step "Migraciones de base de datos"
if DATABASE_URL="$DATABASE_URL" node scripts/migrate.js; then
  ok "Migraciones completadas"
else
  warn "Las migraciones fallaron. Revisa la contraseña de la base de datos y vuelve a ejecutar 'npm run setup'."
  exit 1
fi

# ── 5. Seed test cafeteria ────────────────────────────────────────────────────
step "Cafetería de prueba"
SEED_OUT=$(
  SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  CAFETERIA_SLUG="$CAFETERIA_SLUG" \
  node scripts/seed.js 2>&1
) || { warn "Seeding: $SEED_OUT"; SEED_OUT=""; }

SLUG=$(echo "${SEED_OUT}" | grep '^SLUG:' | sed 's/^SLUG://' || true)
CAFE_ID=$(echo "${SEED_OUT}" | grep '^ID:'   | sed 's/^ID://'   || true)

[ -n "$SLUG" ] && {
  ok "Cafetería: ${SLUG}"
  sed -i "s|^CAFETERIA_SLUG=.*|CAFETERIA_SLUG=${SLUG}|" .env.local
}

# ── Done ──────────────────────────────────────────────────────────────────────
SLUG="${SLUG:-${CAFETERIA_SLUG}}"

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗"
echo    "║  Listo.                                              ║"
echo -e "╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Admin password:   ${BOLD}${ADMIN_SECRET}${NC}"
echo -e "  Kitchen password: ${BOLD}${ORDERS_PASSWORD}${NC}"
echo ""
echo -e "  ${BOLD}npm start${NC}  →  luego abre:"
echo ""
echo -e "    Clientes  →  ${BOLD}http://localhost:3000/s/${SLUG}${NC}"
echo -e "    Admin     →  ${BOLD}http://localhost:3000/management.html?slug=${SLUG}${NC}"
echo -e "    Cocina    →  ${BOLD}http://localhost:3000/deliveries.html?slug=${SLUG}${NC}"
echo ""
