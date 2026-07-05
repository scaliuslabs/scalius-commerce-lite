# Operational Runbook

This is the repo-owned operating guide for OPS-005/OPS-008. It names the signals, read-only checks, and deploy evidence future operators should use. The Cloudflare-native ops monitor and completion checklist live in [ops-monitoring-contract.md](ops-monitoring-contract.md). Do not claim monitoring complete until a routed external alert channel is verified; the current deployed monitor is logs-only.

Cloudflare-native monitoring is the default continuous layer. The deployed logs-only monitor is a tiny scheduled Worker with no public route: call API `/readyz`, read queue/DLQ backlog and oldest-message age through `Queue.metrics()` on queue bindings, store streak/cooldown state in KV, and emit structured redacted logs. Add an external alert destination only after the logs-only path is verified. Cloudflare Health Checks remain useful outside-in reachability checks for `/readyz`, but they do not cover queue/DLQ backlog by themselves and may not be valid for Cloudflare-proxied Worker hostnames. The repo-owned `pnpm ops:check` command is a read-only smoke/sampler for deploys and incidents; it validates the repo's monitoring-critical Wrangler config by default and, with `--queues`, proves provider-side queue producer/consumer wiring. It does not replace continuous Cloudflare monitoring.

## Alert Signals

| Area | Signal | Alert when | First action |
|---|---|---|---|
| Deep readiness | API `[api-ops] {"event":"api.readyz.degraded", ...}` plus ops monitor `ops_monitor.run_completed` / `ops_monitor.alert` logs grouped by failed checks such as `d1:timeout`, `api_cache_kv:error`, `r2:timeout`, or `runtime_config:missing` | Same required check degrades 3 times in 5 minutes, or any deploy readiness sampler fails to recover | Run `pnpm ops:check`, then filter API logs by `requestId`/`cfRay` and ops-monitor logs by monitor run id |
| API 5xx | `[api-ops] {"event":"api.error","status":500|503,...}` | Any burst of 5 or more 5xx ops logs in 5 minutes, or repeated 5xx on the same `method` + `path` | Inspect the matching request id, route, status, and code; keep buyer/provider payloads out of incident notes |
| Queue backlog/age | Ops monitor `Queue.metrics()` logs plus API `[Queue] event=queue_batch_started` fields `queue`, `backlogCount`, `oldestMessageAgeMs`, `maxAttempts`; completion logs include `acked` and `retried`; `pnpm ops:check --queues` verifies provider-side `worker:scalius-api` producer/consumer wiring | Any `*-dlq` backlog is non-zero for 5 minutes; any normal queue has `oldestMessageAgeMs > 300000`; backlog grows for 15 minutes; repeated completions have `retried > 0`; queue provider wiring is missing | Run `pnpm ops:check --queues`; if wiring is missing, fix the Cloudflare queue binding/deployment before any replay decision. DLQ replay/ignore is a production mutation and is not part of smoke testing |
| Scheduled maintenance | `[scheduled] event=scheduled_run_failed` or `scheduled_operation_failed`; normal cron is `*/15 * * * *` and should emit `scheduled_run_completed` | Any failed scheduled run/operation, or no completed run for 45 minutes | Use `runId` to group operation timings and find the failed operation |
| Post-deploy sampler | `pnpm run deploy:api` output from `scripts/deploy.mjs` | Deploy exits non-zero with `API /readyz did not recover during deploy verification`; warning-only transient recovery should still be recorded | Compare readiness samples and latest Worker version evidence before deciding rollback |

Queue names to monitor: `payment-events`, `payment-events-dlq`, `order-notifications`, `order-notifications-dlq`, `auth-otp`, `auth-otp-dlq`, `storefront-cache`, and `storefront-cache-dlq`.

## Correlation

For HTTP incidents, preserve or set a safe `X-Request-Id` during smokes. API responses echo it, and `[api-ops]` logs include `requestId` plus Cloudflare `cfRay` when available. Filter Cloudflare Worker logs by either value; use `CF-Ray` to cross-check Cloudflare-side request evidence.

Queue and cron work is not tied to an HTTP request id. Use `batchId` for `[Queue] event=queue_batch_*` logs, `runId` for `[scheduled] event=scheduled_*` logs, and the ops monitor run id for `ops_monitor.*` events.

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

Ops monitor deploy/incident verification should also include:

```bash
pnpm --filter @scalius/ops-monitor test
pnpm deploy:ops-monitor
pnpm ops:check --queues --samples 1 --timeout-ms 20000
```

Then capture Wrangler tail or Workers Logs evidence for the scheduled monitor run: `/readyz` result, queue/DLQ `Queue.metrics()` summary, KV streak/cooldown decisions, and redacted structured log fields. If an external alert channel is enabled, record the routed test alert timestamp and destination alias without tokens or webhook URLs.

`pnpm ops:check` sends a safe `X-Request-Id`, disables HTTP cache with `Cache-Control: no-cache`, checks `/health`, samples `/readyz` four times by default, prints only the OpenAPI path count, validates monitoring-critical Wrangler config (`observability.enabled`, the `*/15 * * * *` cron, and queue/DLQ topology), and proves the latest API Worker deployment via `pnpm --dir apps/api exec wrangler deployments list --json`. Pass `--samples`, `--timeout-ms`, `--api-base-url`, or `--skip-wrangler` when a bounded incident smoke needs a smaller scope. `--skip-wrangler` is for HTTP-only smoke when Cloudflare auth is unavailable; by default missing Cloudflare auth should fail with an action. `--queues` additionally runs `wrangler queues info` for each configured queue/DLQ and fails if the provider does not report the expected `worker:scalius-api` producer or consumer wiring; backlog count and oldest-message age still come from Cloudflare Queue metrics or GraphQL Analytics.

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
