#!/bin/bash
# Dev server wrapper that ensures clean startup and shutdown.
#
# Fixes two macOS issues:
# 1. Inspector port race: Astro/Cloudflare dev servers fight for Vite's
#    inspector WebSocket port. Staggered starts prevent this.
# 2. Zombie processes: Node/workerd children survive Ctrl+C.
#    Cleanup kills owned dev ports. Set SCALIUS_DEV_KILL_ALL_WORKERD=1 for
#    the old aggressive workerd cleanup behavior.

DEV_PORTS=(8787 4322 4323 9229 9230 9231 9232 9233)
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN="${SCALIUS_DEV_DRY_RUN:-0}"
API_READY_URL="${SCALIUS_DEV_API_READY_URL:-http://localhost:8787/api/v1/setup}"
API_READY_TIMEOUT_SECONDS="${SCALIUS_DEV_API_READY_TIMEOUT_SECONDS:-60}"
STAGGER_SECONDS="${SCALIUS_DEV_STAGGER_SECONDS:-3}"
API_PID=""

lsof_dev_ports() {
  local args=()
  local port
  for port in "${DEV_PORTS[@]}"; do
    args+=("-iTCP:$port")
  done
  lsof -ti "${args[@]}" -sTCP:LISTEN 2>/dev/null
}

kill_dev_ports() {
  lsof_dev_ports | xargs kill -9 2>/dev/null
  if [ "${SCALIUS_DEV_KILL_ALL_WORKERD:-0}" = "1" ]; then
    pkill -9 -f "workerd" 2>/dev/null
  fi
}

apply_local_migrations() {
  if [ "${SCALIUS_SKIP_DEV_MIGRATIONS:-0}" = "1" ]; then
    echo "Skipping local D1 migrations (SCALIUS_SKIP_DEV_MIGRATIONS=1)."
    return
  fi

  echo "Applying local D1 migrations..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] node scripts/deploy.mjs --migrate-only --local"
    return
  fi

  (cd "$ROOT_DIR" && node scripts/deploy.mjs --migrate-only --local) || exit 1
}

cleanup() {
  local status=$?
  trap - EXIT SIGINT SIGTERM
  if [ "$DRY_RUN" = "1" ]; then
    exit "$status"
  fi

  echo ""
  echo "Shutting down dev servers..."
  kill_dev_ports
  sleep 1
  # Second pass for stubborn processes
  kill_dev_ports
  echo "Done."
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' SIGINT
trap 'exit 143' SIGTERM

# Clean up stale processes from previous runs
if [ "$DRY_RUN" != "1" ]; then
  STALE=$(lsof_dev_ports)
  if [ -n "$STALE" ]; then
    echo "Killing stale processes on dev ports..."
    kill_dev_ports
    sleep 1
  fi
fi

validate_numeric_setting() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "$name must be a non-negative integer, got '$value'." >&2
    exit 1
  fi
}

start_api() {
  echo "Starting API worker (port 8787)..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] cd apps/api && pnpm dev"
    return
  fi

  (cd "$ROOT_DIR/apps/api" && pnpm dev) &
  API_PID=$!
}

start_admin() {
  echo "Starting admin dashboard (port 4323)..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] cd apps/admin-v2 && pnpm dev"
    return
  fi

  (cd "$ROOT_DIR/apps/admin-v2" && pnpm dev) &
}

start_storefront() {
  echo "Starting storefront (port 4322)..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] cd apps/storefront && pnpm dev"
    return
  fi

  (cd "$ROOT_DIR/apps/storefront" && pnpm dev) &
}

wait_for_api_ready() {
  validate_numeric_setting "SCALIUS_DEV_API_READY_TIMEOUT_SECONDS" "$API_READY_TIMEOUT_SECONDS"
  echo "Waiting for API readiness at $API_READY_URL..."

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] API readiness assumed."
    return
  fi

  local waited=0
  while [ "$waited" -lt "$API_READY_TIMEOUT_SECONDS" ]; do
    if [ -n "$API_PID" ] && ! kill -0 "$API_PID" 2>/dev/null; then
      wait "$API_PID"
      local api_status=$?
      if [ "$api_status" = "0" ]; then
        api_status=1
      fi
      echo "API worker exited before it was ready (status ${api_status})." >&2
      exit "$api_status"
    fi

    if curl -fsS --max-time 2 "$API_READY_URL" >/dev/null 2>&1; then
      echo "API is ready."
      return
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "API did not become ready within ${API_READY_TIMEOUT_SECONDS}s." >&2
  echo "Check the API logs above, then run pnpm dev:doctor." >&2
  exit 1
}

stagger_next_start() {
  validate_numeric_setting "SCALIUS_DEV_STAGGER_SECONDS" "$STAGGER_SECONDS"
  if [ "$STAGGER_SECONDS" = "0" ]; then
    return
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would wait ${STAGGER_SECONDS}s before starting the next dev server."
    return
  fi

  sleep "$STAGGER_SECONDS"
}

HAS_FILTERS=0
HAS_API=0
HAS_ADMIN=0
HAS_STOREFRONT=0
if [[ "$*" == *"--filter"* ]]; then
  HAS_FILTERS=1
  [[ "$*" == *"@scalius/api"* ]] && HAS_API=1
  [[ "$*" == *"@scalius/admin-v2"* ]] && HAS_ADMIN=1
  [[ "$*" == *"@scalius/storefront"* ]] && HAS_STOREFRONT=1
fi

if [ "$HAS_FILTERS" = "1" ]; then
  if [ "$HAS_API" = "1" ] && [ "$HAS_ADMIN" = "0" ] && [ "$HAS_STOREFRONT" = "0" ]; then
    apply_local_migrations
    start_api
    wait_for_api_ready
    echo ""
    echo "API dev server running. Ctrl+C to stop."
    echo "  API:     http://localhost:8787"
    echo "  Swagger: http://localhost:8787/api/v1/docs"
    echo ""
    wait
    exit 0
  fi

  if [ "$HAS_API" = "1" ] && [ "$HAS_ADMIN" = "1" ] && [ "$HAS_STOREFRONT" = "0" ]; then
    apply_local_migrations
    start_api
    wait_for_api_ready
    start_admin
    wait
    exit 0
  fi

  if [ "$HAS_API" = "1" ] && [ "$HAS_STOREFRONT" = "1" ] && [ "$HAS_ADMIN" = "0" ]; then
    apply_local_migrations
    start_api
    wait_for_api_ready
    start_storefront
    wait
    exit 0
  fi

  turbo run dev "$@" &
  wait $!
  exit 0
fi

# dev:all — start each app with a staggered delay to prevent inspector port races
apply_local_migrations

start_api
wait_for_api_ready

start_admin
stagger_next_start

start_storefront

echo ""
echo "All dev servers starting. Ctrl+C to stop all."
echo "  API:        http://localhost:8787"
echo "  Admin:      http://localhost:4323"
echo "  Storefront: http://localhost:4322"
echo "  Swagger:    http://localhost:8787/api/v1/docs"
echo ""
wait
