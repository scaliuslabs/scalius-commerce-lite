#!/bin/sh
set -eu

hook_name=${1:-}
repo_root=$(git rev-parse --show-toplevel)

if ! command -v codex >/dev/null 2>&1; then
  echo "Ponytail review blocked: Codex is not available on PATH." >&2
  exit 1
fi

case "$hook_name" in
  pre-commit)
    if git diff --cached --quiet --exit-code; then
      exit 0
    fi
    target="the exact staged diff. Resolve it with: git diff --cached --no-ext-diff --binary"
    ;;
  pre-push)
    updates=$(cat)
    if test -z "$updates"; then
      exit 0
    fi
    target="the exact outgoing diff described by these pre-push ref updates:
$updates
For an all-zero remote SHA, review the commits reachable from the local SHA but not any remote-tracking ref. Otherwise review remote_sha..local_sha. Ignore deletion updates whose local SHA is all zeroes."
    ;;
  *)
    echo "Ponytail review blocked: unknown hook '$hook_name'." >&2
    exit 1
    ;;
esac

echo "Running /ponytail-review before ${hook_name#pre-}..." >&2
codex \
  --cd "$repo_root" \
  --sandbox read-only \
  --ask-for-approval never \
  exec \
  "/ponytail-review $target

Review only; do not edit files, stage changes, commit, or push. Exit unsuccessfully if the target cannot be resolved or reviewed."
