#!/usr/bin/env bash
# Enable HTTPS + custom domains for self-hosted Supabase (Caddy + Let's Encrypt).
#
# Prerequisites:
#   - DNS A records for API + dashboard subdomains → droplet IP
#   - Ports 80 and 443 open (ufw + DigitalOcean firewall)
#
# Usage (on droplet):
#   export DROPLET_IP=138.197.80.72
#   export SUPABASE_API_DOMAIN=supabase.valortaxrelief.com
#   export SUPABASE_DASHBOARD_DOMAIN=supadashboard.valortaxrelief.com
#   export SUPABASE_PROJECT_DIR=~/supabase-project
#   export VALOR_INFRA_DIR=~/valor-supabase
#   bash enable-https-domains.sh

set -euo pipefail

DROPLET_IP="${DROPLET_IP:-138.197.80.72}"
SUPABASE_API_DOMAIN="${SUPABASE_API_DOMAIN:-supabase.valortaxrelief.com}"
SUPABASE_DASHBOARD_DOMAIN="${SUPABASE_DASHBOARD_DOMAIN:-supadashboard.valortaxrelief.com}"
SUPABASE_PROJECT_DIR="${SUPABASE_PROJECT_DIR:-$HOME/supabase-project}"
VALOR_INFRA_DIR="${VALOR_INFRA_DIR:-$HOME/valor-supabase}"
CADDYFILE_SRC="${CADDYFILE_SRC:-$VALOR_INFRA_DIR/volumes/proxy/caddy/Caddyfile}"

API_URL="https://${SUPABASE_API_DOMAIN}"
DASHBOARD_URL="https://${SUPABASE_DASHBOARD_DOMAIN}"

echo "==> Enable HTTPS domains for Supabase"
echo "    API:        ${API_URL}"
echo "    Dashboard:  ${DASHBOARD_URL}"
echo "    Droplet IP: ${DROPLET_IP}"

if [[ ! -f "$CADDYFILE_SRC" ]]; then
  echo "ERROR: Caddyfile not found: $CADDYFILE_SRC"
  exit 1
fi

if [[ ! -f "${SUPABASE_PROJECT_DIR}/docker-compose.yml" ]]; then
  echo "ERROR: Supabase project not found: ${SUPABASE_PROJECT_DIR}"
  exit 1
fi

check_dns() {
  local host="$1"
  local ip
  ip="$(dig +short "$host" A | head -1)"
  if [[ -z "$ip" ]]; then
    echo "ERROR: No A record for ${host}. Add DNS first."
    exit 1
  fi
  if [[ "$ip" != "$DROPLET_IP" ]]; then
    echo "WARN: ${host} resolves to ${ip}, expected ${DROPLET_IP}"
    echo "      Continuing anyway — fix DNS if HTTPS certificate issuance fails."
  else
    echo "OK: ${host} → ${ip}"
  fi
}

if command -v dig >/dev/null 2>&1; then
  check_dns "$SUPABASE_API_DOMAIN"
  check_dns "$SUPABASE_DASHBOARD_DOMAIN"
else
  echo "WARN: dig not installed — skipping DNS check"
fi

echo "==> Open firewall ports 80/443 (if ufw active)"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp
  ufw allow 443/tcp
fi

echo "==> Install Caddyfile"
mkdir -p "${SUPABASE_PROJECT_DIR}/volumes/proxy/caddy"
cp "$CADDYFILE_SRC" "${SUPABASE_PROJECT_DIR}/volumes/proxy/caddy/Caddyfile"

cd "$SUPABASE_PROJECT_DIR"

update_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

echo "==> Update .env URLs"
update_env SUPABASE_PUBLIC_URL "$API_URL"
update_env API_EXTERNAL_URL "$API_URL"
update_env SITE_URL "$DASHBOARD_URL"
update_env PROXY_DOMAIN "$SUPABASE_API_DOMAIN"

echo "==> Enable Caddy compose override"
if grep -E '^COMPOSE_FILE=.*docker-compose\.caddy\.yml' .env >/dev/null 2>&1; then
  echo "    Caddy override already in COMPOSE_FILE"
else
  sh run.sh config add caddy
fi

echo "==> Pull images and restart stack with Caddy (may take a few minutes)..."
docker compose pull caddy 2>/dev/null || true
sh run.sh recreate

echo ""
echo "==> HTTPS setup complete"
echo ""
echo "Valor / Vercel .env:"
echo "  SUPABASE_URL=${API_URL}"
echo "  SUPABASE_SERVICE_ROLE_KEY=<SUPABASE_SECRET_KEY from .env>"
echo ""
echo "Studio (browser):"
echo "  ${DASHBOARD_URL}"
echo "  Username: DASHBOARD_USERNAME from .env"
echo "  Password: DASHBOARD_PASSWORD from .env (or: sh run.sh secrets)"
echo ""
echo "Test API:"
echo "  curl -s \"${API_URL}/rest/v1/officers?select=name&limit=1\" \\"
echo "    -H \"apikey: <SECRET_KEY>\" -H \"Authorization: Bearer <SECRET_KEY>\""
