# OPS Monitoring Contract

This is the repo-owned contract for OPS-005 and the remaining OPS-008 monitoring scope. It defines the Cloudflare-native ops monitor and the evidence required to claim monitoring complete. It does not store secrets or add external alert SaaS providers.

Cloudflare remains the default continuous monitoring layer for this platform. The deployed monitor is a tiny scheduled Worker with no public route. It checks API `/readyz`, reads queue/DLQ backlog through `Queue.metrics()` on queue bindings, stores streak/cooldown state in KV, emits structured redacted logs, and can route alerts through Cloudflare Email Service when `ALERT_EMAIL_FROM` and `ALERT_EMAIL_TO` are configured for verified Email Service addresses. Until a live routed Email Service test is captured, OPS-005/OPS-008 monitoring must remain open as partially complete. The monitor avoids Cloudflare API tokens and dashboard scraping by using Worker bindings. `pnpm ops:check` stays the repo-owned read-only sampler for deploys and incidents; it does not replace continuous scheduled monitoring.

## Source Inputs

| Input | Current source |
| --- | --- |
| API Worker and bindings | `apps/api/wrangler.jsonc` (`scalius-api`, `observability.enabled`, queues, cron trigger) |
| Ops monitor Worker | Deployed `apps/ops-monitor` scheduled Worker with no public route, queue bindings, monitor KV, Cloudflare Email Service binding, and redacted logs |
| Deep readiness | `GET https://api.scalius.com/api/v1/readyz` |
| Shallow health | `GET https://api.scalius.com/api/v1/health` |
| Operator smoke | `pnpm ops:check`, plus `pnpm ops:check --queues` when queue metadata matters |
| HTTP correlation | `X-Request-Id`, `[api-ops]` logs, and Cloudflare `CF-Ray` |
| Queue correlation | `[Queue] event=queue_batch_started` / `queue_batch_completed` with `batchId` |
| Queue provider wiring | `pnpm ops:check --queues` parses `wrangler queues info` and verifies expected `worker:scalius-api` producer/consumer actors from `apps/api/wrangler.jsonc` |
| Scheduled correlation | `[scheduled] event=scheduled_run_*` with `runId` |
| Dashboard read evidence | `[dashboard-query]` timing events |

Relevant Cloudflare references: [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Workers metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), [Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Cloudflare Email Service Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [Email send binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/), [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/), [Health Checks](https://developers.cloudflare.com/health-checks/), [Health Check notifications](https://developers.cloudflare.com/health-checks/how-to/health-checks-notifications/), and [Notifications](https://developers.cloudflare.com/notifications/get-started/).

## Architecture Decision

Use a Cloudflare-native scheduled Worker as the primary continuous monitor:

- Schedule: the ops monitor runs every two minutes through Cron Triggers (`*/2 * * * *`); no `fetch` route should be exposed. This is separate from the API Worker's scheduled maintenance cron (`*/15 * * * *`).
- Readiness: call `https://api.scalius.com/api/v1/readyz` with `Cache-Control: no-cache` and a safe monitor request id.
- Queues: bind every normal queue and DLQ, then read backlog count and oldest-message age through `Queue.metrics()`; do not require Cloudflare API tokens for queue checks.
- State: store only alert streaks, last status, last notification time, and cooldown timestamps in KV. Do not store raw response bodies, queue payloads, request bodies, provider payloads, OTPs, receipt tokens, or buyer PII.
- Logs: emit compact structured `ops_monitor.run_completed` events every scheduled run and `ops_monitor.alert` events after configured streak/cooldown thresholds, with dependency names, queue names, statuses, durations, counts, ages, request ids, alert counts, routed alert counts, delivery failure counts, and deployment/version hints only.
- Alert channel: Cloudflare Email Service is the default routed channel. The Worker has an `ALERT_EMAIL` `send_email` binding and empty source defaults for `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO`; configure those only with verified sender and destination addresses. Missing config is intentionally logs-only. Delivery failures emit redacted `ops_monitor.alert_delivery_failed` logs and do not fail the scheduled monitor.

Alternative considered: Cloudflare Health Checks are useful outside-in reachability monitors for `/readyz`, but they do not cover queue/DLQ backlog by themselves and may not be valid for Cloudflare-proxied Worker hostnames. The scheduled Worker is the intended repo-owned path because it can use queue bindings directly and avoids long-lived Cloudflare API tokens.

## Required Continuous Controls

| Control | Desired Cloudflare setup | Alert policy |
| --- | --- | --- |
| API deep readiness | Scheduled ops monitor Worker calls `https://api.scalius.com/api/v1/readyz` and records consecutive failures/degraded checks in KV. Health Checks may be added as outside-in reachability, but they are not the primary completion evidence. | Alert/log when deep readiness is unhealthy for the same required check 3 times in 5 minutes, or when the deploy sampler fails to recover. |
| Worker errors and degraded dependencies | Workers Logs/Observability enabled for `scalius-api`, with saved filters for `[api-ops]`, `api.readyz.degraded`, `api.error`, `requestId`, and `cfRay`. | Page on 5 or more `[api-ops]` 5xx events in 5 minutes, repeated 5xx for the same `method` + `path`, or repeated `api.readyz.degraded` for a required dependency. |
| Queue backlog and DLQs | Ops monitor Worker binds all API queues and DLQs listed below and reads `Queue.metrics()` for backlog count and oldest-message age. The repo smoke must also prove provider-side producer/consumer wiring with `pnpm ops:check --queues` so missing queue consumers are not hidden behind monitor logs. | Alert/log when any `*-dlq` backlog is non-zero for 5 minutes, any normal queue has oldest message age above `300000ms`, backlog grows for 15 minutes, completions repeatedly report retries, or `pnpm ops:check --queues` reports missing expected `worker:scalius-api` wiring. |
| API scheduled maintenance | Workers Logs/Observability filter for `[scheduled]` events from the `*/15 * * * *` API cron. | Page on any `scheduled_run_failed` / `scheduled_operation_failed`, or when no `scheduled_run_completed` appears for 45 minutes. |
| Deployment readiness variance | Preserve `pnpm run deploy:api` readiness sampler output and Worker deployment version evidence. | Treat transient dependency timeout recovery as warning evidence; persistent degraded readiness is rollback investigation input. |

Queues to monitor: `payment-events`, `payment-events-dlq`, `order-notifications`, `order-notifications-dlq`, `auth-otp`, `auth-otp-dlq`, `storefront-cache`, and `storefront-cache-dlq`.

## Dashboard Contract

The Cloudflare dashboard, saved views, or future IaC-managed equivalent should let an operator answer these questions without reading application code:

| Question | Required evidence |
| --- | --- |
| Is the API currently serving? | Ops monitor `/readyz` events, latest `pnpm ops:check` result, and latest `scalius-api` deployment version. |
| Which dependency is degraded? | `api.readyz.degraded` entries grouped by required check name and status, without raw provider payloads or buyer PII. |
| Are async jobs stuck? | Queue backlog count, oldest message timestamp or age, retry/lag signal, and DLQ backlog for each monitored queue. |
| Is scheduled cleanup running? | Latest `scheduled_run_completed` timestamp and failed operation logs grouped by `runId`. |
| Is D1/background pressure returning? | D1 readiness latency in `/readyz`, queue/scheduled timing logs, and dashboard query timing events. |

Do not use dashboards or alert payloads that expose OTPs, credentials, receipt tokens, provider payloads, buyer contact data, or raw request bodies. Incident notes should keep only masked identifiers, request ids, CF-Ray values, route names, dependency names, statuses, durations, and deployment versions.

## Verification Checklist

Use this checklist before marking the monitoring part of OPS-005 or OPS-008 complete. Do not close either item from logs-only deployment alone.

| Check | Evidence to record |
| --- | --- |
| Ops monitor tests pass | `pnpm --filter @scalius/ops-monitor test` output summary. |
| Ops monitor typecheck/build pass | Exact typecheck/build commands and output summary for the ops-monitor package. |
| Ops monitor deploys | `pnpm deploy:ops-monitor` deployment id/version, cron schedule, KV namespace binding name, queue binding list, and confirmation that no public route is exposed. |
| Readiness check is active | Wrangler tail or Workers Logs evidence showing scheduled `/readyz` checks, safe request ids, healthy and degraded event shapes, and cooldown/streak behavior without raw response bodies. |
| Queue metrics are active | Wrangler tail or Workers Logs evidence showing `Queue.metrics()` results for every queue/DLQ, plus `pnpm ops:check --queues --samples 1 --timeout-ms 20000` output summary proving API provider wiring still matches expectations. |
| Notifications are routed | Cloudflare Email Service channel alias, verified sender/destination alias, test notification timestamp, cooldown state, and mute state. Do not paste API tokens, webhook URLs, raw email inbox screenshots, or personal email addresses into repo docs. If `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` are empty or unverified, record logs-only monitoring as remaining scope. |
| Worker observability is enabled | `apps/api/wrangler.jsonc` still has `observability.enabled: true`, plus a current Cloudflare Workers Logs/Observability screenshot or exported note showing `scalius-api` filters for `api.readyz.degraded` and `api.error`. |
| Ops monitor scheduled run is active | Latest `ops_monitor.run_completed` for the `*/2 * * * *` ops-monitor trigger. |
| API scheduled maintenance covers cron | Latest `scheduled_run_completed` for the API `*/15 * * * *` trigger and an alert policy for missing or failed runs. |
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
pnpm --filter @scalius/ops-monitor test
```

```bash
pnpm deploy:ops-monitor
```

```bash
curl -fsS -H 'Cache-Control: no-cache' \
  -H 'X-Request-Id: ops-manual-readiness-check' \
  https://api.scalius.com/api/v1/readyz
```

## Cloudflare Email Alert Configuration

The source `apps/ops-monitor/wrangler.jsonc` declares the `ALERT_EMAIL` binding and keeps `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` empty so deploys stay safe before Email Service is onboarded. To finish routed monitoring, configure the Worker with a verified sender on an onboarded Cloudflare Email Service domain and one or more verified destination addresses, then deploy and trigger a controlled alert. The installed Wrangler `4.104.0` config schema and current Cloudflare Email Service docs support tightening `send_email` bindings with `destination_address`, `allowed_destination_addresses`, or `allowed_sender_addresses`; apply those restrictions in the same slice once the verified ops aliases are known.

Current 2026-07-05T09:46Z evidence: the repo code path is deployed but routed proof is externally blocked. Live version metadata for ops-monitor version `cc15af3e-23b5-4033-b9cb-1fbc3709ce41` shows `ALERT_EMAIL_FROM` and `ALERT_EMAIL_TO` deployed as empty strings, so the Worker cannot construct an alert email config or send a routed notification. The `ALERT_EMAIL` binding exists but has no sender or destination restriction. The active Wrangler OAuth token can list the `scalius.com` Email Routing zone, but `email routing settings scalius.com`, `email routing addresses list`, `email sending list scalius.com`, and `email sending settings scalius.com` fail with Cloudflare auth error `10000` because the token is missing `email_routing:write` and `email_sending:write`. No test notification was sent.

Owner unblock sequence: run `pnpm --dir apps/ops-monitor exec wrangler login` to refresh Email scopes; create or confirm the destination with `pnpm --dir apps/ops-monitor exec wrangler email routing addresses create <ops-destination-address>` and complete the human email verification; verify sender/domain readiness with `pnpm --dir apps/ops-monitor exec wrangler email sending settings scalius.com`; configure `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` and restrict the `ALERT_EMAIL` binding to the verified aliases without committing personal addresses; deploy with `pnpm deploy:ops-monitor`; then trigger one controlled monitor alert and record the version id, timestamp, safe alias names, `routedAlertCount:1`, `deliveryFailureCount:0`, cooldown state, and matching tail/log run id. A direct `wrangler email sending send` may be used only as an account preflight; it is not sufficient by itself to close the ops-monitor routed-alert requirement.

Cloudflare Email Service requires Cloudflare DNS for domain setup. Official pricing notes that sends to verified destination addresses are free on all plans, while arbitrary-recipient Email Sending requires Workers Paid. Keep the alert email plain text and compact; it must not contain raw response bodies, queue payloads, request bodies, OTPs, receipt tokens, provider payloads, credentials, or buyer contact data.

## Future Alert Channel Or IaC Handoff

Notification routing, Terraform, Pulumi, or Cloudflare API automation may be added later, but only when that slice owns verification and rollback scope. Any follow-up must keep these constraints:

- No secrets, API tokens, notification credentials, raw provider payloads, OTPs, receipt tokens, or buyer PII in repo docs, config, logs, dashboards, or alert payload examples.
- Alert resource names and thresholds must remain traceable to this contract or its replacement.
- Continuous monitoring must stay independent of the app Worker being healthy enough to enqueue or send its own alert.
- `pnpm ops:check` remains the read-only repo smoke unless a future script replaces it with equal or better safety guarantees.
- Any alert-channel integration must come with focused tests, deploy verification, a redacted test notification, and an update to this contract.
