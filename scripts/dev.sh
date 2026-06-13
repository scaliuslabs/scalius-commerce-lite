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
  (cd "$ROOT_DIR" && node scripts/deploy.mjs --migrate-only --local) || exit 1
}

cleanup() {
  local status=$?
  trap - EXIT SIGINT SIGTERM
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
STALE=$(lsof_dev_ports)
if [ -n "$STALE" ]; then
  echo "Killing stale processes on dev ports..."
  kill_dev_ports
  sleep 1
fi

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
  if [ "$HAS_API" = "1" ] && [ "$HAS_ADMIN" = "1" ] && [ "$HAS_STOREFRONT" = "0" ]; then
    apply_local_migrations
    echo "Starting API worker (port 8787)..."
    (cd "$ROOT_DIR/apps/api" && pnpm dev) &
    sleep 3
    echo "Starting admin dashboard (port 4323)..."
    (cd "$ROOT_DIR/apps/admin-v2" && pnpm dev) &
    wait
    exit 0
  fi

  if [ "$HAS_API" = "1" ] && [ "$HAS_STOREFRONT" = "1" ] && [ "$HAS_ADMIN" = "0" ]; then
    apply_local_migrations
    echo "Starting API worker (port 8787)..."
    (cd "$ROOT_DIR/apps/api" && pnpm dev) &
    sleep 3
    echo "Starting storefront (port 4322)..."
    (cd "$ROOT_DIR/apps/storefront" && pnpm dev) &
    wait
    exit 0
  fi

  turbo run dev "$@" &
  wait $!
  exit 0
fi

# dev:all — start each app with a staggered delay to prevent inspector port races
apply_local_migrations

echo "Starting API worker (port 8787)..."
(cd "$ROOT_DIR/apps/api" && pnpm dev) &

sleep 3

echo "Starting admin dashboard (port 4323)..."
(cd "$ROOT_DIR/apps/admin-v2" && pnpm dev) &

sleep 3

echo "Starting storefront (port 4322)..."
(cd "$ROOT_DIR/apps/storefront" && pnpm dev) &

echo ""
echo "All dev servers starting. Ctrl+C to stop all."
echo "  API:        http://localhost:8787"
echo "  Admin:      http://localhost:4323"
echo "  Storefront: http://localhost:4322"
echo "  Swagger:    http://localhost:8787/api/v1/docs"
echo ""
wait
