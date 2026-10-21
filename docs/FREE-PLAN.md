# Running on Workers Free

This page covers how Scalius runs on the Cloudflare Workers Free plan and scales up on Workers Paid. It is for operators who pick a plan and for contributors who add queries or background work.

Free is the default: the committed Wrangler configs deploy there unchanged. A Paid deploy adds one flag. Cloudflare limits last checked: 2026-10-03.

## The plan profile

Every limit that Scalius adapts to the plan is a value in one typed profile: `PLAN_LIMITS` in `packages/shared/src/plan-limits.ts`. The deploy decides the plan once.

```sh
pnpm run deploy                    # Free (the default)
pnpm run deploy --plan paid        # Workers Paid (or SCALIUS_PLAN=paid)
pnpm run deploy --plugin-sandbox   # Worker Loader: needs Paid, implies --plan paid
```

`scripts/plan.mjs` picks the plan in this order: the `--plan` flag, the `SCALIUS_PLAN` variable of the deploy shell (no Worker reads it), Paid when the plugin sandbox is on, else Free. An explicit Free with the sandbox on fails. The sandbox is on with `--plugin-sandbox`, `SCALIUS_PLUGIN_SANDBOX=1` or `pnpm plugin sandbox on`.

A Paid deploy writes `apps/api/wrangler.deploy.gen.json` (git-ignored) beside the committed config. It adds `limits.cpu_ms` and `define: { __SCALIUS_PLAN__: "paid" }`, which `planLimits()` reads. It also adds `limits.cpu_ms` to the generated storefront config. `--plan paid` fails with a custom `--wrangler-config`: set the same values in that file.

`__SCALIUS_PLAN__` is a build constant, not an environment variable or a secret. Without it the deployment is Free. `pnpm check:env` fails when a committed Wrangler config declares `limits` or defines `__SCALIUS_PLAN__`. It also fails on any KV namespace or queue.

Code reads values from the profile and never branches on the plan name. Paid values keep at least the baseline the code had before the profile existed. `packages/shared/src/plan-limits.test.ts` fails when a Paid value drops below it.

| Limit | Free | Paid |
| --- | --- | --- |
| Worker CPU (`limits.cpu_ms`) | not set (fixed 10 ms) | 30,000 ms |
| New password hash | PBKDF2-SHA256, 30,000 iterations | scrypt N=16384, r=16, p=1 |
| Rows per drain: events, deliveries, notifications, payment events | 2, 2, 1, 1 | 50, 25, 20, 10 |
| Recommendation rotation per run | 4 products | 32 products |
| Maintenance jobs (the sweep rotation) | one a minute: each job every 23 minutes | every job every 15 minutes |
| Expired reservations released per run | 4 | 50 |
| Each sweep's row limit | 20% | 100% |
| List total counted up to (`countCap`) | 1,000 | 10,000 |
| Deepest numbered page (`maxOffset`) | 1,000 rows | 10,000 rows |
| Bulk-run and app-job chunks per drain (`bulkRunChunksPerDrain`) | 3 | 12 |
| Items per app batch create (`batchCreates`: products, categories, brands) | 4, 12, 19 | 20, 50, 50 |
| App jobs running at once (`plugins.runningJobs`) | 3 | 10 |

The profile also sets the bulk page, the products refreshed after a catalogue write, the nightly sold-products refresh, the catalogue rebuild chunk and the backfill image limit.

## The Cloudflare limits

The budget harness encodes the per-invocation limits (`apps/api/src/free-plan-budget.test.ts`) and the daily quotas (`scripts/free-plan-budget.mjs`). Figures marked (unverified) come from Cloudflare's pages only.

| Free limit | Value |
| --- | --- |
| CPU per HTTP request and cron run | 10 ms |
| Subrequests per invocation | 50 external, 1,000 to Cloudflare services |
| D1 queries per invocation (a `batch()` is one) | 50 |
| D1 per day | 5M rows read, 100,000 rows written |
| Requests per day | 100,000 |
| Worker script size | 64 MiB uncompressed, no compressed limit |
| Worker startup (global scope) | 1 s |

Paid raises these to 30 s of CPU as configured, 1,000 D1 queries and 10,000 subrequests per invocation. The Paid daily quotas are (unverified).

## Measuring

```sh
pnpm free-plan:budget                 # Node tier, both profiles: counter tables and the daily quota
pnpm free-plan:budget --workerd       # also real CPU in workerd (Miniflare)
pnpm free-plan:budget --record        # measure only; prints the budgets file source
pnpm free-plan:budget --orders 250    # orders per day in the quota model (default 100)
pnpm free-plan:budget --json out.json # keep the raw report
```

- **Node tier** (`apps/api/src/free-plan-budget.test.ts`) drives the real Worker entrypoints (`fetch`, `scheduled`) over an in-memory D1 and meters every binding. It asserts D1 calls and external subrequests against `apps/api/src/testing/free-plan-budgets.ts` and the plan's per-invocation limits. A new query or fan-out fails here first. CPU in this tier is a relative figure.
- **workerd tier** (`apps/api/src/free-plan-workerd.test.ts`) runs the bundled Worker in workerd, where CPU is wall time minus time waiting on the D1 proxy. Only this tier shows cold route graphs and real hashing cost. The Free password hash and verify must each stay below 5 ms (best of 15 runs).

The daily quota model charges each order with a 3-line checkout, its notifications, tax quotes, sign-in codes and 20 page views, and adds 1,440 cron ticks a day (the steady-state mean of an hour of ticks). D1 rows written count rows changed times 3, for index entries. In the 100-order run of 2026-10-14, D1 rows written ended a Free store first, at about 270 orders a day (unverified: rerun the command). The Images allowance also ends a Free store before any CPU limit does.

## Catalogue ceiling

Every deploy empties the public cache (each key carries the Worker version), so a crawler then misses every page. Free's 5M rows read a day must pay for at least 200 cold misses of each storefront read: a miss may read at most 25,000 D1 rows. `scripts/scale-proof.mjs` fails a run whose D1 read is over that (`FREE_MISS_ROWS_CEILING`) and prints the reads that are, with their misses a day.

At 50,000 products and 156,244 SKUs (SCALE.md, 2026-10-14) three reads are over it: product page without a stored recommendation list (118,253 rows, 42 misses a day; audit R2 B1), all products by newest (183,735, 27; A9) and search (52,134, 95; A9). Home (908), category page 1 (10,210) and a feed page (12,655) fit. Until those reads are bounded, Free supports a catalogue of up to 10,000 SKUs. That figure scales the 156k-SKU reads linearly and is unverified until a scale proof runs at that size; Paid has no such ceiling.

## Rules by area

### Password hashing

Better Auth's scrypt costs about 80 ms of CPU in workerd, so a staff sign-in cannot fit 10 ms. `packages/core/src/auth/password-hash.ts` writes self-describing, versioned hashes:

The format is `$sc1$pbkdf2-sha256$i=30000,k=1$<salt>$<hash>` on Free and `$sc1$scrypt$N=16384,r=16,p=1,k=1$<salt>$<hash>` on Paid. A Better Auth hash (`<32 hex>:<128 hex>`) still verifies.

- Free uses WebCrypto PBKDF2, which is native in workerd.
- `k=1` means the password was keyed with a pepper first: HMAC-SHA256 under a key that HKDF derives from `CREDENTIAL_ENCRYPTION_KEY`. A leaked D1 copy lacks that key and cannot test a guess, which is why 30,000 iterations are acceptable.
- A successful verify reports `needsRehash` when the hash differs from what this deployment writes: another plan's cost, no pepper, or Better Auth's format. The sign-in then rewrites the hash with the password it just checked (`upgradeStoredPasswordHash`, a compare-and-set on the old hash). A failed rewrite never fails the sign-in.
- After a Paid-to-Free move, the first sign-in of each account verifies a scrypt hash on Free, which can exceed the CPU limit (error 1102; unverified). The "forgot password" email writes a Free hash.
- Turn on staff 2FA (`twoFactor` in `packages/core/src/auth/auth.ts`).

### Background work

A store has no queue: a queue is one more resource per store, and Free allows 10,000 queue operations a day. Work that must survive a failure is a database row first. The request that commits the row starts the work right after the response (`ctx.waitUntil`, `apps/api/src/background/after-response.ts`). The cron runs every minute and drains what is still due (`BACKGROUND_DRAINS` in `apps/api/src/scheduled-maintenance.ts`).

| Work | Durable row | After the write | Retry and terminal state |
| --- | --- | --- | --- |
| Notifications | `notification_outbox` | sends the committed rows | backoff in `next_attempt_at`; `dead_lettered` after 8 attempts |
| Domain events, webhooks, app deliveries | `event_outbox`, `webhook_event_deliveries`, `plugin_event_deliveries` | `flushEventsAfterWrite` | backoff; `dead_lettered` or `exhausted` after 8 attempts, retried from the dashboard |
| Payment events | `webhook_events` (`payload`, `attempts`, `next_attempt_at`) | applied after the provider gets its 200 | 6 attempts, 1 to 16 minutes apart; then `failed`, a dead-letter issue on the order page |
| Sign-in codes | `auth_otp_delivery_receipts` | up to 3 attempts, 2 s and 6 s apart | none after that: a code lives 5 minutes, so the buyer asks for a new one |
| Bulk runs and app jobs | `bulk_runs` (kind `app.job` for an app's job) | `bulkRunChunksPerDrain` chunks right after the response | the minute cron continues from the run's cursor; a job step is tried 3 times, then the job fails |
| Automatic fulfilment | the settled order | `runOrderAutoFulfil` | `auto_fulfil_sweep` |
| Projection rebuild | `system_kv` `catalog:projections:rebuild-cursor` | the first chunks | each drain continues from the cursor |
| Recommendations | `system_kv` `catalog:recommendations:rotation-cursor` | the written products and their peers | a daily lap visits every public product once (up to the per-run size times the runs in a day); the nightly tick refreshes products sold that day |
| Image renditions | media rows with `variant_width` NULL (pending) | none: no Worker renders images | an open dashboard tab renders them in the background |

Rules:

- A drain takes at most its plan batch (`planLimits().background`) and leaves the rest due for the next tick. The drains and the tick's maintenance job share one cron invocation, so on Free the batches keep a tick within 50 D1 queries.
- A claim with a lease guards each row, and the handlers are idempotent. An after-response run and a tick never deliver the same row twice, and a crashed run is reclaimed when its lease ends.
- After-response work shares the request's invocation budget. On Free a request sends at most `notificationsPerDrain` committed notifications; the next tick sends the rest.

### No KV

A store has no KV namespace (an account allows 1,000, and KV was only ever a hint or, worse, a sole copy). The relational provider holds what must persist: OAuth grants and tokens and small markers in `system_kv`, scanner sessions on their `scanner_token_claims` row. Per-colo hints that only spare a database read use the Cache API, keyed by the Worker version (`workerCacheHint` in `packages/shared/src/worker-cache-hint.ts`): the settings mirror, the RBAC seed marker, and the Meta CAPI circuit. Permission checks always read the database (one batch).

### Maintenance cron

The cron runs every minute (`* * * * *` in `apps/api/wrangler.jsonc`). Every tick first asks, in one statement, which background drains have due rows (`apps/api/src/scheduled/due-work.ts`: each drain's index probes, with the conditions its own list query uses) and runs only those. `MAINTENANCE_SWEEPS` in `apps/api/src/scheduled-maintenance.ts` lists the maintenance jobs as data, in rotation order (23 jobs, including agent-access housekeeping). `apps/api/src/scheduled/slices.ts` picks the jobs of a tick from two plan values, `sweepEveryMinutes` and `sweepsPerTick`:

- Free runs the next job of the rotation on every tick, beside the drains. Each job runs every 23 minutes, and every tick of a whole rotation stays within 50 D1 queries with work due (`apps/api/src/maintenance-budget.test.ts`).
- Paid runs every job on every fifteenth minute.
- The 02:00 store-time minute runs only the nightly pass: sales stats, a projection rebuild request, the recommendations of products sold that day, app storage sizes and a sampled drift check.
- Hourly work inside a job (app exchange rates) runs on the job's first run of each hour (`firstSweepRunOfHour`).
- A sweep's row limit is `floor(limit * limitScale)`, at least 1.

The 2026-10-15 ordered budget run measures at most 23 D1 calls on Free and 62 on Paid during the initial cron rotation, including first registration of the bundled apps' three Object types. Each new type checks the store's 100-type capacity; its insert returns the created row without another read. After warm-up, both profiles write zero rows per idle tick. Since the 2026-10-21 due-work probe an idle tick pays one D1 query for all the drains (mean D1 calls: 2.78 Free, 3.73 Paid, from 8.78 and 9.73). The Free invocation ceiling stays at 50.

### Frontier cache refresh

The storefront validates cached pages against the DVC change clock ([packages/core/src/cache-deps/README.md](../packages/core/src/cache-deps/README.md)). The slow check scans at most one frontier window (4,000 changes, `FRONTIER_CHECK_MAX_ROWS` in `apps/api/src/cache-frontier.ts`) of `cache_dep` after the page's `s0`. A page older than the window renders again, so a bulk write cannot turn into millions of rows read.

### Large lists

`OFFSET` reads every row before the page, and an unfiltered `count(*)` reads every index row. These lists therefore walk by keyset cursor with a capped count: admin orders, products (and `/api/v1/admin/products/summaries`) and customers, and public product listings sorted by `newest`, `price-asc` and `price-desc`.

The contract (`@scalius/shared/pagination`, `@scalius/core/utils/keyset`):

- `after` and `before` cursors, and `pageInfo` built from `limit + 1` rows.
- `total` is exact up to `planLimits().lists.countCap`. Above it, `total` is the cap and `totalIsCapped` is true.
- A numbered page works only below `maxOffset`. A deeper page is a typed 400 (`page_too_deep`).
- Both plans use the same logic. Only the two numbers differ.

A cursor travels in a URL, so it never carries personal data. A sort on personal values (orders by customer name, customers by name) issues a reference cursor: sort, direction and row id, no value. `resolveReferencedBoundary` reads the boundary row's value by id when the cursor returns. A cursor for a row that no longer exists is a typed 400 (`invalid_cursor`), and a cursor that carries a name for such a sort is refused. Other sorts carry their value.

### Worker size

`scripts/check-api-bundle.mjs` (`pnpm check:api-bundle`, and every deploy) measures the uncompressed size of the API Worker. That is the number the 64 MiB limit counts. The budget is 64 MiB less 10% (57.6 MiB). The script prints the gzip size and does not gate on it. Bundled plugins compile into this Worker, so a plugin that pushes it over budget fails the deploy.

## After deploying

Check these live:

- CPU time per request (p50 and p99) for `/api/auth/sign-in/email`, `/api/v1/storefront/batch`, `POST /api/v1/orders` and the cron, and error 1102 ("Worker exceeded resource limits") by route.
- D1 rows written per day, and rows still due after a tick (`notification_outbox`, `event_outbox`, `webhook_events` with `next_attempt_at` in the past).
- `pnpm ops:check` and `pnpm release:check`. Pass `--api-base-url`, and for the release check `--storefront-url` and `--dashboard-url`. The defaults are the Scalius demo hosts.
