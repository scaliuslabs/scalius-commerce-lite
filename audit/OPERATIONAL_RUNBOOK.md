# Operational Runbook

This is the repo-owned operating guide for OPS-005/OPS-008. It names the signals, read-only checks, and deploy evidence future operators should use. External alert rules, notification routing, uptime checks, and dashboards still need to be configured in Cloudflare or the chosen monitoring provider; this repo does not currently create those resources.

## Alert Signals

| Area | Signal | Alert when | First action |
|---|---|---|---|
| Deep readiness | `[api-ops] {"event":"api.readyz.degraded", ...}` grouped by `degradedChecks` such as `d1:timeout`, `api_cache_kv:error`, `r2:timeout`, or `runtime_config:missing` | Same required check degrades 3 times in 5 minutes, or any deploy readiness sampler fails to recover | Run the read-only `/readyz` smoke below, then filter Worker logs by `requestId` and `cfRay` |
| API 5xx | `[api-ops] {"event":"api.error","status":500|503,...}` | Any burst of 5 or more 5xx ops logs in 5 minutes, or repeated 5xx on the same `method` + `path` | Inspect the matching request id, route, status, and code; keep buyer/provider payloads out of incident notes |
| Queue backlog/age | Cloudflare Queue metrics plus `[Queue] event=queue_batch_started` fields `queue`, `backlogCount`, `oldestMessageAgeMs`, `maxAttempts`; completion logs include `acked` and `retried` | Any `*-dlq` backlog is non-zero for 5 minutes; any normal queue has `oldestMessageAgeMs > 300000`; backlog grows for 15 minutes; repeated completions have `retried > 0` | Check the affected queue with `wrangler queues info`; DLQ replay/ignore is a production mutation and is not part of smoke testing |
| Scheduled maintenance | `[scheduled] event=scheduled_run_failed` or `scheduled_operation_failed`; normal cron is `*/15 * * * *` and should emit `scheduled_run_completed` | Any failed scheduled run/operation, or no completed run for 45 minutes | Use `runId` to group operation timings and find the failed operation |
| Post-deploy sampler | `pnpm run deploy:api` output from `scripts/deploy.mjs` | Deploy exits non-zero with `API /readyz did not recover during deploy verification`; warning-only transient recovery should still be recorded | Compare readiness samples and latest Worker version evidence before deciding rollback |

Queue names to monitor: `payment-events`, `payment-events-dlq`, `order-notifications`, `order-notifications-dlq`, `auth-otp`, `auth-otp-dlq`, `storefront-cache`, and `storefront-cache-dlq`.

## Correlation

For HTTP incidents, preserve or set a safe `X-Request-Id` during smokes. API responses echo it, and `[api-ops]` logs include `requestId` plus Cloudflare `cfRay` when available. Filter Cloudflare Worker logs by either value; use `CF-Ray` to cross-check Cloudflare-side request evidence.

Queue and cron work is not tied to an HTTP request id. Use `batchId` for `[Queue] event=queue_batch_*` logs and `runId` for `[scheduled] event=scheduled_*` logs.

## Read-Only Live Smokes

These commands are safe for production because they only use `GET`/read-only provider inspection. Do not use production smoke tests that create orders, send OTPs, create payment sessions, replay webhooks, purge caches, replay DLQs, issue refunds, or change shipments.

```bash
REQUEST_ID="ops-smoke-$(date -u +%Y%m%dT%H%M%SZ)"

curl -sS -D /tmp/scalius-api-health.headers -o /tmp/scalius-api-health.json \
  -H "X-Request-Id: ${REQUEST_ID}" \
  -w 'health HTTP %{http_code} time %{time_total}\n' \
  https://api.scalius.com/api/v1/health

grep -iE '^(x-request-id|cf-ray):' /tmp/scalius-api-health.headers
```

```bash
curl -sS -D /tmp/scalius-api-readyz.headers -o /tmp/scalius-api-readyz.json \
  -H "X-Request-Id: ${REQUEST_ID}" \
  -H "Cache-Control: no-cache" \
  -w 'readyz HTTP %{http_code} time %{time_total}\n' \
  https://api.scalius.com/api/v1/readyz

node -e 'const p=require("/tmp/scalius-api-readyz.json"); console.log(p.status, p.durationMs, Object.entries(p.checks||{}).map(([k,v])=>`${k}:${v.status}${typeof v.latencyMs==="number"?` ${v.latencyMs}ms`:""}`).join(", "))'
```

```bash
curl -fsS -o /tmp/scalius-openapi.json https://api.scalius.com/api/v1/openapi.json
node -e 'const p=require("/tmp/scalius-openapi.json"); console.log(Object.keys(p.paths||{}).length, "paths")'

curl -sS -o /tmp/scalius-checkout-config.json \
  -w 'checkout-config HTTP %{http_code} time %{time_total}\n' \
  https://api.scalius.com/api/v1/checkout/config

curl -sS -o /tmp/scalius-admin-orders-401.json \
  -w 'admin-orders-no-cookie HTTP %{http_code} time %{time_total}\n' \
  https://api.scalius.com/api/v1/admin/orders
```

```bash
for q in payment-events payment-events-dlq order-notifications order-notifications-dlq auth-otp auth-otp-dlq storefront-cache storefront-cache-dlq; do
  pnpm exec wrangler queues info "$q" --config apps/api/wrangler.jsonc
done
```

## Deploy And Rollback Investigation

Deploy through the repo script from the root:

```bash
pnpm run deploy:api
```

The deploy script already proves the latest API Worker deployment serves one version at `100%`, checks `/api/v1/health`, and samples `/api/v1/readyz` four times. A persistent degraded window fails the deploy; a transient recovered window prints a warning and should be copied into the tracker or incident notes.

Use Wrangler deployment evidence before rollback decisions:

```bash
pnpm exec wrangler deployments list --config apps/api/wrangler.jsonc --json > /tmp/scalius-api-deployments.json
node -e 'const ds=require("/tmp/scalius-api-deployments.json"); for (const d of ds.slice(0,5)) console.log(d.created_on, (d.versions||[]).map(v=>`${v.version_id}:${v.percentage}%`).join(", "))'
```

Rollback is a production mutation. Pick the last known-good API version from deploy output, `audit/README.md`, tracker notes, or the Wrangler deployment list, then use Cloudflare dashboard rollback or the current Wrangler rollback flow for that exact version. After rollback, repeat only the read-only smokes above and record the version id, readiness samples, and any `api.readyz.degraded` or `api.error` correlation ids.
