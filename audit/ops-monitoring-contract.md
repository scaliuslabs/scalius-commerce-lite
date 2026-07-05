# OPS Monitoring Contract

This is the repo-owned contract for OPS-005 and the remaining OPS-008 monitoring scope. It defines the desired Cloudflare-native monitoring setup and the evidence required to claim it is configured. It does not create provider resources, store secrets, or add a runtime Worker.

Cloudflare remains the default continuous monitoring layer for this platform. `pnpm ops:check` is the repo-owned read-only sampler for deploys and incidents; it does not replace continuous provider-side monitoring.

## Source Inputs

| Input | Current source |
| --- | --- |
| API Worker and bindings | `apps/api/wrangler.jsonc` (`scalius-api`, `observability.enabled`, queues, cron trigger) |
| Deep readiness | `GET https://api.scalius.com/api/v1/readyz` |
| Shallow health | `GET https://api.scalius.com/api/v1/health` |
| Operator smoke | `pnpm ops:check`, plus `pnpm ops:check --queues` when queue metadata matters |
| HTTP correlation | `X-Request-Id`, `[api-ops]` logs, and Cloudflare `CF-Ray` |
| Queue correlation | `[Queue] event=queue_batch_started` / `queue_batch_completed` with `batchId` |
| Scheduled correlation | `[scheduled] event=scheduled_run_*` with `runId` |
| Dashboard read evidence | `[dashboard-query]` timing events |

Relevant Cloudflare references: [Health Checks](https://developers.cloudflare.com/health-checks/), [Health Check notifications](https://developers.cloudflare.com/health-checks/how-to/health-checks-notifications/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Workers metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), [Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), and [Notifications](https://developers.cloudflare.com/notifications/get-started/).

## Required Continuous Controls

| Control | Desired Cloudflare setup | Alert policy |
| --- | --- | --- |
| API deep readiness | Cloudflare-native synthetic monitor targeting `https://api.scalius.com/api/v1/readyz`. Use a Cloudflare Health Check only when the target is valid for Health Checks; if the Worker/custom-domain hostname resolves to Cloudflare IPs, use an independent scheduled monitor Worker or equivalent Cloudflare-native monitor instead. Prefer body-aware validation when available; at minimum non-`200` responses must fail. | Page when deep readiness is unhealthy for the same required check 3 times in 5 minutes, or when the deploy sampler fails to recover. |
| Worker errors and degraded dependencies | Workers Logs/Observability enabled for `scalius-api`, with saved filters for `[api-ops]`, `api.readyz.degraded`, `api.error`, `requestId`, and `cfRay`. | Page on 5 or more `[api-ops]` 5xx events in 5 minutes, repeated 5xx for the same `method` + `path`, or repeated `api.readyz.degraded` for a required dependency. |
| Queue backlog and DLQs | Cloudflare Queues metrics or GraphQL Analytics for all API queues and DLQs listed below. Include backlog count, oldest message age, lag/retry evidence, and consumer outcome where available. | Page when any `*-dlq` backlog is non-zero for 5 minutes, any normal queue has oldest message age above `300000ms`, backlog grows for 15 minutes, or completions repeatedly report retries. |
| Scheduled maintenance | Workers Logs/Observability filter for `[scheduled]` events from the `*/15 * * * *` API cron. | Page on any `scheduled_run_failed` / `scheduled_operation_failed`, or when no `scheduled_run_completed` appears for 45 minutes. |
| Deployment readiness variance | Preserve `pnpm run deploy:api` readiness sampler output and Worker deployment version evidence. | Treat transient dependency timeout recovery as warning evidence; persistent degraded readiness is rollback investigation input. |

Queues to monitor: `payment-events`, `payment-events-dlq`, `order-notifications`, `order-notifications-dlq`, `auth-otp`, `auth-otp-dlq`, `storefront-cache`, and `storefront-cache-dlq`.

## Dashboard Contract

The Cloudflare dashboard, saved views, or future IaC-managed equivalent should let an operator answer these questions without reading application code:

| Question | Required evidence |
| --- | --- |
| Is the API currently serving? | Synthetic monitor status for `/api/v1/readyz`, latest `pnpm ops:check` result, and latest `scalius-api` deployment version. |
| Which dependency is degraded? | `api.readyz.degraded` entries grouped by required check name and status, without raw provider payloads or buyer PII. |
| Are async jobs stuck? | Queue backlog count, oldest message timestamp or age, retry/lag signal, and DLQ backlog for each monitored queue. |
| Is scheduled cleanup running? | Latest `scheduled_run_completed` timestamp and failed operation logs grouped by `runId`. |
| Is D1/background pressure returning? | D1 readiness latency in `/readyz`, queue/scheduled timing logs, and dashboard query timing events. |

Do not use dashboards or alert payloads that expose OTPs, credentials, receipt tokens, provider payloads, buyer contact data, or raw request bodies. Incident notes should keep only masked identifiers, request ids, CF-Ray values, route names, dependency names, statuses, durations, and deployment versions.

## Verification Checklist

Use this checklist before marking the monitoring part of OPS-005 or OPS-008 complete.

| Check | Evidence to record |
| --- | --- |
| Synthetic monitor exists and is active | Monitor type (`Health Check`, scheduled monitor Worker, or equivalent), monitor name, target URL, enabled state, alert trigger, notification policy name, and last successful evaluation. If Health Checks are not valid for the Worker hostname, record that reason and the replacement monitor. |
| Notifications are routed | Notification policy name, destination alias or team channel, test notification timestamp, and mute state. Do not paste API tokens or personal inbox screenshots into repo docs. |
| Worker observability is enabled | `apps/api/wrangler.jsonc` still has `observability.enabled: true`, plus a current Cloudflare Workers Logs/Observability screenshot or exported note showing `scalius-api` filters for `api.readyz.degraded` and `api.error`. |
| Queue monitoring covers every queue | `pnpm ops:check --queues --samples 1 --timeout-ms 20000` output summary plus provider-side evidence for each normal queue and DLQ. |
| Scheduled monitoring covers cron | Latest `scheduled_run_completed` for the `*/15 * * * *` trigger and an alert policy for missing or failed runs. |
| Correlation works | A safe `X-Request-Id` from `pnpm ops:check --json` can be found in Workers Logs, and the log entry includes `cfRay` when Cloudflare supplies one. |
| Runbook is actionable | `audit/OPERATIONAL_RUNBOOK.md` first actions still match the provider setup and remain read-only until an explicit rollback or DLQ replay decision. |

Safe verification commands from the repo root:

```bash
pnpm ops:check --json
```

```bash
pnpm ops:check --queues --samples 1 --timeout-ms 20000
```

```bash
curl -fsS -H 'Cache-Control: no-cache' \
  -H 'X-Request-Id: ops-manual-readiness-check' \
  https://api.scalius.com/api/v1/readyz
```

## Future IaC Or Monitor Worker Handoff

Provider-side configuration may later move into Terraform, Pulumi, Cloudflare API automation, or a dedicated monitor Worker, but only when that slice owns verification and rollback scope. A future implementation must keep these constraints:

- No secrets, API tokens, notification credentials, raw provider payloads, OTPs, receipt tokens, or buyer PII in repo docs, config, logs, dashboards, or alert payload examples.
- Alert resource names and thresholds must remain traceable to this contract or its replacement.
- Continuous monitoring must stay independent of the app Worker being healthy enough to enqueue or send its own alert.
- `pnpm ops:check` remains the read-only repo smoke unless a future script replaces it with equal or better safety guarantees.
- Any runtime monitor Worker must come with explicit Cloudflare binding conventions, focused tests, deploy verification, and an update to this contract.
