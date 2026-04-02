#!/bin/bash
# Dev server wrapper that ensures clean startup and shutdown.
#
# Fixes two macOS issues:
# 1. Inspector port race: Astro/Cloudflare dev servers fight for Vite's
#    inspector WebSocket port. Staggered starts prevent this.
# 2. Zombie processes: Node/workerd children survive Ctrl+C.
#    Aggressive cleanup kills everything on dev ports.

DEV_PORTS="8787,4322,4323,9229,9230,9231,9232,9233"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

kill_dev_ports() {
  lsof -ti :$DEV_PORTS 2>/dev/null | xargs kill -9 2>/dev/null
  pkill -9 -f "workerd" 2>/dev/null
}

cleanup() {
  echo ""
  echo "Shutting down dev servers..."
  kill_dev_ports
  sleep 1
  # Second pass for stubborn processes
  kill_dev_ports
  echo "Done."
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# Clean up stale processes from previous runs
STALE=$(lsof -ti :$DEV_PORTS 2>/dev/null)
if [ -n "$STALE" ]; then
  echo "Killing stale processes on dev ports..."
  kill_dev_ports
  sleep 1
fi

# If turbo filters are passed, use turbo directly (no port race with 1-2 apps)
if [[ "$*" == *"--filter"* ]]; then
  turbo dev "$@" &
  wait $!
  exit 0
fi

# dev:all — start each app with a staggered delay to prevent inspector port races
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
