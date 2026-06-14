#!/usr/bin/env bash
# Run from your Mac terminal (interactive — you'll enter the SSH key passphrase once).
#
#   chmod +x infra/supabase-droplet/scripts/deploy-from-mac.sh
#   ./infra/supabase-droplet/scripts/deploy-from-mac.sh
#
# Requires: SSH key at /Volumes/JASONT9/Dev/keys/karim_sqp

set -euo pipefail

DROPLET_IP="${DROPLET_IP:-138.197.80.72}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-/Volumes/JASONT9/Dev/keys/karim_sqp}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REMOTE_DIR="~/valor-supabase"

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

echo "==> 1/4 Load SSH key (enter passphrase if prompted)"
ssh-add "$SSH_KEY" 2>/dev/null || true

echo "==> 2/4 Test SSH as ${SSH_USER}@${DROPLET_IP}"
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${DROPLET_IP}" 'echo "Connected as $(whoami) on $(hostname)"'

echo "==> 3/4 Copy infra files to droplet"
scp "${SSH_OPTS[@]}" -r \
  "${REPO_ROOT}/infra/supabase-droplet" \
  "${SSH_USER}@${DROPLET_IP}:${REMOTE_DIR}"

echo "==> 4/4 Bootstrap Supabase + apply Valor schema on droplet"
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${DROPLET_IP}" bash -s <<'REMOTE'
set -euo pipefail
cd ~/valor-supabase/scripts
chmod +x *.sh
export DROPLET_IP=138.197.80.72
export SUPABASE_PROJECT_DIR=~/supabase-project

echo "Waiting for apt lock (fresh droplets often run unattended-upgrades)..."
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
  || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
  sleep 5
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

echo "Starting Supabase bootstrap (5-15 min)..."
bash bootstrap.sh

echo "Applying Valor schema..."
bash apply-valor-schema.sh

echo ""
echo "=== Credentials for Vercel ==="
bash show-credentials.sh

echo ""
echo "=== Open firewall port 8000 if needed ==="
echo "  sudo ufw allow 8000/tcp"
echo "  (Also allow TCP 8000 in DigitalOcean Networking → Firewalls)"
REMOTE

echo ""
echo "==> Deploy finished. Update Vercel env vars with values printed above."
