#!/usr/bin/env bash
# Print connection values for Valor Vercel env and local .env
#
# Usage:
#   export SUPABASE_PROJECT_DIR=~/supabase-project
#   bash show-credentials.sh

set -euo pipefail

SUPABASE_PROJECT_DIR="${SUPABASE_PROJECT_DIR:-$HOME/supabase-project}"

if [[ ! -f "${SUPABASE_PROJECT_DIR}/.env" ]]; then
  echo "ERROR: ${SUPABASE_PROJECT_DIR}/.env not found"
  exit 1
fi

cd "$SUPABASE_PROJECT_DIR"

get_env() {
  grep -E "^${1}=" .env | head -1 | cut -d= -f2- | tr -d '"'
}

PUBLIC_URL="$(get_env SUPABASE_PUBLIC_URL)"
SECRET_KEY="$(get_env SUPABASE_SECRET_KEY)"
DASHBOARD_USER="$(get_env DASHBOARD_USERNAME)"
DASHBOARD_PASS="$(get_env DASHBOARD_PASSWORD)"

echo "=== Valor app (Vercel / .env) ==="
echo "SUPABASE_URL=${PUBLIC_URL}"
echo "SUPABASE_SERVICE_ROLE_KEY=${SECRET_KEY}"
echo ""
echo "=== Supabase Studio (browser) ==="
echo "URL:      ${PUBLIC_URL}"
echo "Username: ${DASHBOARD_USER:-supabase}"
echo "Password: (see DASHBOARD_PASSWORD in .env or run: sh run.sh secrets)"
echo ""
echo "=== Quick REST test (from any machine with network access) ==="
echo "curl -s \"${PUBLIC_URL}/rest/v1/officers?select=name,user_id&is_active=eq.true\" \\"
echo "  -H \"apikey: ${SECRET_KEY}\" \\"
echo "  -H \"Authorization: Bearer ${SECRET_KEY}\""
