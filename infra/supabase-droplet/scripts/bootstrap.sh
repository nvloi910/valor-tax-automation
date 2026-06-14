#!/usr/bin/env bash
# Bootstrap self-hosted Supabase on a Linux VPS (DigitalOcean droplet, etc.)
# Uses the official Supabase Docker Compose stack.
#
# Usage (on the droplet, as root or a sudo user):
#   export DROPLET_IP=138.197.80.72          # required
#   export SUPABASE_PROJECT_DIR=~/supabase-project  # optional
#   bash bootstrap.sh
#
# Prerequisites: curl, git (script installs Docker if missing on supported distros)

set -euo pipefail

wait_for_apt_lock() {
  local max_wait="${1:-300}"
  local waited=0
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
    || fuser /var/lib/apt/lists/lock >/dev/null 2>&1 \
    || fuser /var/lib/dpkg/lock >/dev/null 2>&1; do
    if [[ "$waited" -eq 0 ]]; then
      echo "==> Waiting for apt/dpkg lock (another package manager is running)..."
    fi
    if [[ "$waited" -ge "$max_wait" ]]; then
      echo "ERROR: apt lock still held after ${max_wait}s. On the droplet run:"
      echo "  ps aux | grep -E 'apt|dpkg'"
      echo "  sudo kill 35442   # only if unattended-upgrades is stuck"
      echo "  sudo rm -f /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock"
      exit 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  if [[ "$waited" -gt 0 ]]; then
    echo "==> apt lock released after ${waited}s"
  fi
}

DROPLET_IP="${DROPLET_IP:-}"
SUPABASE_PROJECT_DIR="${SUPABASE_PROJECT_DIR:-$HOME/supabase-project}"
NONINTERACTIVE="${NONINTERACTIVE:-1}"

if [[ -z "$DROPLET_IP" ]]; then
  echo "ERROR: Set DROPLET_IP to your droplet public IP (e.g. export DROPLET_IP=138.197.80.72)"
  exit 1
fi

PUBLIC_URL="http://${DROPLET_IP}:8000"
SITE_URL="http://${DROPLET_IP}:3000"

echo "==> Valor Supabase bootstrap"
echo "    Project dir: ${SUPABASE_PROJECT_DIR}"
echo "    Public URL:  ${PUBLIC_URL}"

if [[ ! -d "$SUPABASE_PROJECT_DIR" ]]; then
  wait_for_apt_lock
  echo "==> Running official Supabase setup script..."
  if [[ "$NONINTERACTIVE" == "1" ]]; then
    curl -fsSL https://supabase.link/setup.sh | sh -s -- -y
  else
    curl -fsSL https://supabase.link/setup.sh | sh
  fi
fi

if [[ ! -f "${SUPABASE_PROJECT_DIR}/docker-compose.yml" ]]; then
  # setup.sh creates supabase-project in cwd; move if we're elsewhere
  if [[ -f "./supabase-project/docker-compose.yml" ]]; then
    mv ./supabase-project "$SUPABASE_PROJECT_DIR"
  else
    echo "ERROR: ${SUPABASE_PROJECT_DIR}/docker-compose.yml not found after setup."
    echo "       Clone manually: https://supabase.com/docs/guides/self-hosting/docker"
    exit 1
  fi
fi

cd "$SUPABASE_PROJECT_DIR"

echo "==> Configuring URLs in .env"
if grep -q '^SUPABASE_PUBLIC_URL=' .env; then
  sed -i.bak "s|^SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=${PUBLIC_URL}|" .env
else
  echo "SUPABASE_PUBLIC_URL=${PUBLIC_URL}" >> .env
fi

if grep -q '^API_EXTERNAL_URL=' .env; then
  sed -i.bak "s|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=${PUBLIC_URL}|" .env
else
  echo "API_EXTERNAL_URL=${PUBLIC_URL}" >> .env
fi

if grep -q '^SITE_URL=' .env; then
  sed -i.bak "s|^SITE_URL=.*|SITE_URL=${SITE_URL}|" .env
else
  echo "SITE_URL=${SITE_URL}" >> .env
fi

if [[ ! -f .env.bak ]]; then
  : # sed -i.bak may not run on all systems without existing keys
fi

echo "==> Pulling images and starting stack (this can take several minutes)..."
docker compose pull
sh run.sh start

echo ""
echo "==> Bootstrap complete."
echo "    Studio:  ${PUBLIC_URL}"
echo "    REST:    ${PUBLIC_URL}/rest/v1/"
echo ""
echo "Next steps:"
echo "  1. Open Studio and log in (credentials: sh run.sh secrets)"
echo "  2. Apply Valor schema: bash apply-valor-schema.sh"
echo "  3. Point Vercel SUPABASE_URL at ${PUBLIC_URL}"
echo "  4. Set SUPABASE_SERVICE_ROLE_KEY to SUPABASE_SECRET_KEY from .env"
