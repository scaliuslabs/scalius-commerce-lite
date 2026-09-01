#!/bin/bash
# Dev server wrapper that ensures clean startup and shutdown.
#
# Fixes two macOS issues:
# 1. Inspector port race: Astro/Cloudflare dev servers fight for Vite's
#    inspector WebSocket port. Staggered starts prevent this.
# 2. Zombie processes: Node/workerd children survive Ctrl+C.
#    Cleanup terminates only processes started and tracked by this wrapper.

DEV_PORTS=(8787 4322 4323)
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN="${SCALIUS_DEV_DRY_RUN:-0}"
API_READY_URL="${SCALIUS_DEV_API_READY_URL:-http://localhost:8787/api/v1/setup}"
API_READY_TIMEOUT_SECONDS="${SCALIUS_DEV_API_READY_TIMEOUT_SECONDS:-60}"
STAGGER_SECONDS="${SCALIUS_DEV_STAGGER_SECONDS:-3}"
API_PID=""
ADMIN_PID=""
STOREFRONT_PID=""
TURBO_PID=""
MAILPIT_PID=""
MAILPIT_URL="http://127.0.0.1:8025"
MAILPIT_READY_TIMEOUT_SECONDS="${SCALIUS_DEV_MAILPIT_READY_TIMEOUT_SECONDS:-10}"

resolve_pnpm_bin() {
  if [ -n "${SCALIUS_PNPM_BIN:-}" ]; then
    printf "%s\n" "$SCALIUS_PNPM_BIN"
    return
  fi

  if command -v pnpm >/dev/null 2>&1; then
    command -v pnpm
    return
  fi

  if [ -n "${npm_execpath:-}" ] && [ -f "$npm_execpath" ]; then
    case "$npm_execpath" in
      *pnpm*|*corepack*)
        printf "%s\n" "$npm_execpath"
        return
        ;;
    esac
  fi

  local node_bin node_prefix candidate
  node_bin="$(command -v node 2>/dev/null || true)"
  if [ -n "$node_bin" ]; then
    node_prefix="$(cd "$(dirname "$node_bin")/.." && pwd)"
    candidate="$node_prefix/lib/node_modules/corepack/shims/pnpm"
    if [ -f "$candidate" ]; then
      printf "%s\n" "$candidate"
      return
    fi
  fi

  for candidate in \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm" \
    "$HOME"/.nvm/versions/node/*/lib/node_modules/corepack/shims/pnpm; do
    if [ -f "$candidate" ]; then
      printf "%s\n" "$candidate"
      return
    fi
  done

  printf "%s\n" "pnpm"
}

PNPM_BIN="$(resolve_pnpm_bin)"
export SCALIUS_PNPM_BIN="$PNPM_BIN"

assert_dev_ports_available() {
  if ! command -v lsof >/dev/null 2>&1; then
    echo "lsof is required to verify local dev ports safely." >&2
    exit 1
  fi

  local port pids pid command conflict=0
  for port in "${DEV_PORTS[@]}"; do
    pids="$(lsof -nP -a -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    for pid in $pids; do
      command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      echo "Port $port is already in use by PID $pid${command:+ ($command)}." >&2
      conflict=1
    done
  done

  if [ "$conflict" = "1" ]; then
    echo "Stop or reconfigure the conflicting process, then rerun pnpm dev." >&2
    exit 1
  fi
}

terminate_owned_process() {
  local pid="$1"
  local label="$2"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    return
  fi

  kill -TERM "$pid" 2>/dev/null || true
  local attempts=0
  while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 30 ]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "$label did not stop after SIGTERM; stopping the same owned PID." >&2
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

start_mailpit() {
  echo "Starting local mailbox (port 8025)..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] mailpit --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025 --max 100 --max-age 24h --quiet"
    return
  fi

  if curl -fsS --max-time 1 "$MAILPIT_URL/api/v1/info" >/dev/null 2>&1; then
    echo "Local mailbox is already ready."
    return
  fi

  if ! command -v mailpit >/dev/null 2>&1; then
    echo "Mailpit is required for local email and OTP testing." >&2
    echo "Install it with 'brew install mailpit' on macOS or follow https://mailpit.axllent.org/docs/install/." >&2
    exit 1
  fi

  validate_numeric_setting "SCALIUS_DEV_MAILPIT_READY_TIMEOUT_SECONDS" "$MAILPIT_READY_TIMEOUT_SECONDS"
  mailpit --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025 --max 100 --max-age 24h --quiet &
  MAILPIT_PID=$!

  local waited=0
  while [ "$waited" -lt "$MAILPIT_READY_TIMEOUT_SECONDS" ]; do
    if curl -fsS --max-time 1 "$MAILPIT_URL/api/v1/info" >/dev/null 2>&1; then
      echo "Local mailbox is ready."
      return
    fi
    if ! kill -0 "$MAILPIT_PID" 2>/dev/null; then
      echo "Mailpit exited before its API was ready." >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "Mailpit did not become ready within ${MAILPIT_READY_TIMEOUT_SECONDS}s." >&2
  exit 1
}

stop_storefront_background() {
  if [ "$DRY_RUN" = "1" ] || [ -z "$STOREFRONT_PID" ]; then
    return
  fi

  (cd "$ROOT_DIR/apps/storefront" && "$PNPM_BIN" exec astro dev stop >/dev/null 2>&1) || true
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

run_dev_preflight() {
  echo "Checking local development readiness..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] node scripts/dev-doctor.mjs --profile api"
    return
  fi

  local report
  if ! report="$(cd "$ROOT_DIR" && node scripts/dev-doctor.mjs --profile api 2>&1)"; then
    printf "%s\n" "$report" >&2
    exit 1
  fi
}

cleanup() {
  local status=$?
  trap - EXIT SIGINT SIGTERM
  if [ "$DRY_RUN" = "1" ]; then
    exit "$status"
  fi

  echo ""
  echo "Shutting down dev servers..."
  stop_storefront_background
  terminate_owned_process "$STOREFRONT_PID" "Storefront"
  terminate_owned_process "$ADMIN_PID" "Admin dashboard"
  terminate_owned_process "$API_PID" "API worker"
  terminate_owned_process "$TURBO_PID" "Turbo dev"
  terminate_owned_process "$MAILPIT_PID" "Mailpit"
  echo "Done."
  exit "$status"
}

if [ "$DRY_RUN" != "1" ]; then
  assert_dev_ports_available
fi

run_dev_preflight

trap cleanup EXIT
trap 'exit 130' SIGINT
trap 'exit 143' SIGTERM

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
    echo "[dry-run] cd apps/api && $PNPM_BIN dev"
    return
  fi

  (cd "$ROOT_DIR/apps/api" && exec "$PNPM_BIN" dev) &
  API_PID=$!
}

start_admin() {
  echo "Starting admin dashboard (port 4323)..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] cd apps/admin-v2 && $PNPM_BIN dev"
    return
  fi

  (cd "$ROOT_DIR/apps/admin-v2" && exec "$PNPM_BIN" dev) &
  ADMIN_PID=$!
}

start_storefront() {
  echo "Starting storefront (port 4322)..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] cd apps/storefront && $PNPM_BIN dev"
    return
  fi

  (
    cd "$ROOT_DIR/apps/storefront" || exit 1
    "$PNPM_BIN" dev
    status=$?
    if [ "$status" -ne 0 ]; then
      exit "$status"
    fi

    if "$PNPM_BIN" exec astro dev status >/dev/null 2>&1; then
      echo "Storefront is running in Astro background mode; streaming astro dev logs."
      exec "$PNPM_BIN" exec astro dev logs --follow
    fi
  ) &
  STOREFRONT_PID=$!
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

if [ "$HAS_FILTERS" = "0" ] || [ "$HAS_API" = "1" ]; then
  start_mailpit
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
    echo "  Mailbox: http://127.0.0.1:8025"
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

  "$PNPM_BIN" exec turbo run dev "$@" &
  TURBO_PID=$!
  wait "$TURBO_PID"
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
echo "  Mailbox:    http://127.0.0.1:8025"
echo ""
wait
