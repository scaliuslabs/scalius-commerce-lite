# Operational Runbook

This is the repo-owned operating guide for OPS-005/OPS-008. It names the signals, read-only checks, and deploy evidence future operators should use. The desired provider-side monitoring setup and completion checklist live in [ops-monitoring-contract.md](ops-monitoring-contract.md). External alert rules, notification routing, uptime checks, and dashboards still need to be configured in Cloudflare or the chosen monitoring provider; this repo does not currently create those resources.

Cloudflare-native monitoring should be the default continuous layer: keep Workers Logs/observability enabled in Wrangler, configure a Cloudflare-native synthetic monitor plus notification policy for `https://api.scalius.com/api/v1/readyz`, and alert on queue/DLQ backlog count plus oldest-message age for the queues listed below. Use a Cloudflare Health Check only when the Worker/custom-domain target is valid for Health Checks; otherwise use an independent scheduled monitor Worker or equivalent Cloudflare-native monitor. The repo-owned `pnpm ops:check` command is a read-only smoke/sampler for deploys and incidents; it does not replace continuous Cloudflare monitoring.

## Alert Signals

| Area | Signal | Alert when | First action |
|---|---|---|---|
| Deep readiness | `[api-ops] {"event":"api.readyz.degraded", ...}` grouped by `degradedChecks` such as `d1:timeout`, `api_cache_kv:error`, `r2:timeout`, or `runtime_config:missing` | Same required check degrades 3 times in 5 minutes, or any deploy readiness sampler fails to recover | Run `pnpm ops:check`, then filter Worker logs by `requestId` and `cfRay` |
| API 5xx | `[api-ops] {"event":"api.error","status":500|503,...}` | Any burst of 5 or more 5xx ops logs in 5 minutes, or repeated 5xx on the same `method` + `path` | Inspect the matching request id, route, status, and code; keep buyer/provider payloads out of incident notes |
| Queue backlog/age | Cloudflare Queue metrics plus `[Queue] event=queue_batch_started` fields `queue`, `backlogCount`, `oldestMessageAgeMs`, `maxAttempts`; completion logs include `acked` and `retried` | Any `*-dlq` backlog is non-zero for 5 minutes; any normal queue has `oldestMessageAgeMs > 300000`; backlog grows for 15 minutes; repeated completions have `retried > 0` | Run `pnpm ops:check --queues`; DLQ replay/ignore is a production mutation and is not part of smoke testing |
| Scheduled maintenance | `[scheduled] event=scheduled_run_failed` or `scheduled_operation_failed`; normal cron is `*/15 * * * *` and should emit `scheduled_run_completed` | Any failed scheduled run/operation, or no completed run for 45 minutes | Use `runId` to group operation timings and find the failed operation |
| Post-deploy sampler | `pnpm run deploy:api` output from `scripts/deploy.mjs` | Deploy exits non-zero with `API /readyz did not recover during deploy verification`; warning-only transient recovery should still be recorded | Compare readiness samples and latest Worker version evidence before deciding rollback |

Queue names to monitor: `payment-events`, `payment-events-dlq`, `order-notifications`, `order-notifications-dlq`, `auth-otp`, `auth-otp-dlq`, `storefront-cache`, and `storefront-cache-dlq`.

## Correlation

For HTTP incidents, preserve or set a safe `X-Request-Id` during smokes. API responses echo it, and `[api-ops]` logs include `requestId` plus Cloudflare `cfRay` when available. Filter Cloudflare Worker logs by either value; use `CF-Ray` to cross-check Cloudflare-side request evidence.

Queue and cron work is not tied to an HTTP request id. Use `batchId` for `[Queue] event=queue_batch_*` logs and `runId` for `[scheduled] event=scheduled_*` logs.

## Read-Only Live Smokes

These commands are safe for production because they only use `GET`/read-only provider inspection and app-local Wrangler read commands. Do not use production smoke tests that create orders, send OTPs, create payment sessions, replay webhooks, purge caches, replay DLQs, issue refunds, or change shipments.

```bash
pnpm ops:check
```

```bash
pnpm ops:check --json
```

```bash
pnpm ops:check --queues
```

`pnpm ops:check` sends a safe `X-Request-Id`, disables HTTP cache with `Cache-Control: no-cache`, checks `/health`, samples `/readyz` four times by default, prints only the OpenAPI path count, and proves the latest API Worker deployment via `pnpm --dir apps/api exec wrangler deployments list --json`. Pass `--samples`, `--timeout-ms`, `--api-base-url`, or `--skip-wrangler` when a bounded incident smoke needs a smaller scope. `--skip-wrangler` is for HTTP-only smoke when Cloudflare auth is unavailable; by default missing Cloudflare auth should fail with an action.

Optional follow-up HTTP checks:

```bash
curl -sS -o /tmp/scalius-checkout-config.json \
  -w 'checkout-config HTTP %{http_code} time %{time_total}\n' \
  https://api.scalius.com/api/v1/checkout/config

curl -sS -o /tmp/scalius-admin-orders-401.json \
  -w 'admin-orders-no-cookie HTTP %{http_code} time %{time_total}\n' \
  https://api.scalius.com/api/v1/admin/orders
```

## Deploy And Rollback Investigation

Deploy through the repo script from the root:

```bash
pnpm run deploy:api
```

The deploy script already proves the latest API Worker deployment serves one version at `100%`, checks `/api/v1/health`, and samples `/api/v1/readyz` four times. A persistent degraded window fails the deploy; a transient recovered window prints a warning and should be copied into the tracker or incident notes.

Use repo-owned deployment evidence before rollback decisions:

```bash
pnpm ops:check --json
```

Rollback is a production mutation. Pick the last known-good API version from deploy output, `audit/README.md`, tracker notes, or the Wrangler deployment list, then use Cloudflare dashboard rollback or the current Wrangler rollback flow for that exact version. After rollback, repeat only the read-only smokes above and record the version id, readiness samples, and any `api.readyz.degraded` or `api.error` correlation ids.
