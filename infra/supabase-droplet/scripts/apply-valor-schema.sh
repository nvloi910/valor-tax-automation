#!/usr/bin/env bash
# Apply Valor application tables to the self-hosted Supabase Postgres database.
#
# Usage (on the droplet, from repo infra folder):
#   export SUPABASE_PROJECT_DIR=~/supabase-project
#   bash apply-valor-schema.sh
#
# Or with explicit SQL path:
#   VALOR_SQL=/path/to/valor_schema.sql bash apply-valor-schema.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_PROJECT_DIR="${SUPABASE_PROJECT_DIR:-$HOME/supabase-project}"
VALOR_SQL="${VALOR_SQL:-$SCRIPT_DIR/../sql/valor_schema.sql}"

if [[ ! -f "$VALOR_SQL" ]]; then
  echo "ERROR: SQL file not found: $VALOR_SQL"
  exit 1
fi

if [[ ! -f "${SUPABASE_PROJECT_DIR}/docker-compose.yml" ]]; then
  echo "ERROR: Supabase project not found at ${SUPABASE_PROJECT_DIR}"
  echo "       Run bootstrap.sh first."
  exit 1
fi

cd "$SUPABASE_PROJECT_DIR"

if ! docker compose ps --status running 2>/dev/null | grep -q 'db'; then
  echo "ERROR: Supabase db container is not running. Start with: sh run.sh start"
  exit 1
fi

echo "==> Applying Valor schema from ${VALOR_SQL}"
docker compose exec -T db psql -U postgres -d postgres < "$VALOR_SQL"

echo "==> Verifying tables"
docker compose exec -T db psql -U postgres -d postgres -c "\dt public.*"

echo "==> Officer count"
docker compose exec -T db psql -U postgres -d postgres -c "SELECT count(*) AS officers FROM officers WHERE is_active = true;"

echo "==> Done. REST endpoints:"
echo "    task_logs, pending_tasks, officers, round_robin"
