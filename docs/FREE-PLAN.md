# Running on Workers Free

This page covers how Scalius runs on the Cloudflare Workers Free plan and scales up on Workers Paid. It is for operators who pick a plan and for contributors who add queries or queue messages.

Free is the default: the committed Wrangler configs deploy there unchanged. A Paid deploy adds one flag. Cloudflare limits last checked: 2026-10-03.

## The plan profile

Every limit that Scalius adapts to the plan is a value in one typed profile: `PLAN_LIMITS` in `packages/shared/src/plan-limits.ts`. The deploy decides the plan once.

```sh
pnpm run deploy                    # Free (the default)
pnpm run deploy --plan paid        # Workers Paid (or SCALIUS_PLAN=paid)
pnpm run deploy --plugin-sandbox   # Worker Loader: needs Paid, implies --plan paid
```

`scripts/plan.mjs` picks the plan in this order: the `--plan` flag, the `SCALIUS_PLAN` variable of the deploy shell (no Worker reads it), Paid when the plugin sandbox is on, else Free. An explicit Free with the sandbox on fails. The sandbox is on with `--plugin-sandbox`, `SCALIUS_PLUGIN_SANDBOX=1` or `pnpm plugin sandbox on`.

A Paid deploy writes `apps/api/wrangler.deploy.gen.json` (git-ignored) beside the committed config. It adds `limits.cpu_ms`, the larger `max_batch_size` of the `jobs` and `jobs-dlq` consumers, and `define: { __SCALIUS_PLAN__: "paid" }`, which `planLimits()` reads. It also adds `limits.cpu_ms` to the generated storefront config. `--plan paid` fails with a custom `--wrangler-config`: set the same values in that file.

`__SCALIUS_PLAN__` is a build constant, not an environment variable or a secret. Without it the deployment is Free. `pnpm check:env` fails when a committed Wrangler config declares `limits`, defines `__SCALIUS_PLAN__`, or sets a queue batch size other than the Free value.

Code reads values from the profile and never branches on the plan name. Paid values keep at least the baseline the code had before the profile existed. `packages/shared/src/plan-limits.test.ts` fails when a Paid value drops below it.

| Limit | Free | Paid |
| --- | --- | --- |
| Worker CPU (`limits.cpu_ms`) | not set (fixed 10 ms) | 30,000 ms |
| New password hash | PBKDF2-SHA256, 30,000 iterations | scrypt N=16384, r=16, p=1 |
| Queue consumer `max_batch_size` (`jobs`; the dead-letter queue gets 10 on Paid) | 1 | 15 |
| Bulk backlog limit (no bulk fan-out at or above it) | 20 messages | 1,000 |
| Rendition queued from a public read | off | on |
| Cron slices (each sweep runs once per rotation) | 4 (hourly) | 1 (every 15 minutes) |
| Cron: each sweep's row limit | 20% | 100% |
| List total counted up to (`countCap`) | 1,000 | 10,000 |
| Deepest numbered page (`maxOffset`) | 1,000 rows | 10,000 rows |

The profile also sets the bulk page, the recommendation message size, the catalogue rebuild chunk and the cron inline image limit. `nightlyRecommendationRefreshLimit` is in the profile, but no code reads it: the nightly pass refreshes up to 3,000 products on both plans (`NIGHTLY_RECOMMENDATION_REFRESH_LIMIT` in `apps/api/src/scheduled/catalog-projections.ts`).

## The Cloudflare limits

The budget harness encodes the per-invocation limits (`apps/api/src/free-plan-budget.test.ts`) and the daily quotas (`scripts/free-plan-budget.mjs`). Figures marked (unverified) come from Cloudflare's pages only.

| Free limit | Value |
| --- | --- |
| CPU per HTTP request, queue invocation and cron run | 10 ms |
| Subrequests per invocation | 50 external, 1,000 to Cloudflare services |
| D1 queries per invocation (a `batch()` is one) | 50 |
| D1 per day | 5M rows read, 100,000 rows written |
| Queues operations per day (a delivered message is 3) | 10,000 |
| Requests per day | 100,000 |
| Images transformations per month | 5,000 (unverified) |
| Worker script size | 64 MiB uncompressed, no compressed limit |
| Worker startup (global scope) | 1 s |

Paid raises these to 30 s of CPU as configured, 1,000 D1 queries and 10,000 subrequests per invocation. The Paid daily quotas are (unverified). One image needs up to 13 transformations (`apps/api/src/scheduled-maintenance.ts`), so the Images allowance covers about 380 images a month.

## Measuring

```sh
pnpm free-plan:budget                 # Node tier, both profiles: counter tables and the daily quota
pnpm free-plan:budget --workerd       # also real CPU in workerd (Miniflare)
pnpm free-plan:budget --record        # measure only; prints the budgets file source
pnpm free-plan:budget --orders 250    # orders per day in the quota model (default 100)
pnpm free-plan:budget --json out.json # keep the raw report
```

- **Node tier** (`apps/api/src/free-plan-budget.test.ts`) drives the real Worker entrypoints (`fetch`, `queue`, `scheduled`) over an in-memory D1 and meters every binding. It asserts D1 calls, queue messages and external subrequests against `apps/api/src/testing/free-plan-budgets.ts` and the plan's per-invocation limits. A new query or fan-out fails here first. CPU in this tier is a relative figure.
- **workerd tier** (`apps/api/src/free-plan-workerd.test.ts`) runs the bundled Worker in workerd, where CPU is wall time minus time waiting on the D1 proxy. Only this tier shows cold route graphs and real hashing cost. The Free password hash and verify must each stay below 5 ms (best of 15 runs).

The daily quota model charges each order with a 3-line checkout, its queued messages, tax quotes, sign-in codes and 20 page views, and adds 96 cron runs a day. D1 rows written count rows changed times 3, for index entries. In the 100-order run of 2026-10-03, D1 rows written ended a Free store first, at about 210 orders a day (unverified: rerun the command). The Images allowance also ends a Free store before any CPU limit does.

## Rules by area

### Password hashing

Better Auth's scrypt costs about 80 ms of CPU in workerd, so a staff sign-in cannot fit 10 ms. `packages/core/src/auth/password-hash.ts` writes self-describing, versioned hashes:

The format is `$sc1$pbkdf2-sha256$i=30000,k=1$<salt>$<hash>` on Free and `$sc1$scrypt$N=16384,r=16,p=1,k=1$<salt>$<hash>` on Paid. A Better Auth hash (`<32 hex>:<128 hex>`) still verifies.

- Free uses WebCrypto PBKDF2, which is native in workerd.
- `k=1` means the password was keyed with a pepper first: HMAC-SHA256 under a key that HKDF derives from `CREDENTIAL_ENCRYPTION_KEY`. A leaked D1 copy lacks that key and cannot test a guess, which is why 30,000 iterations are acceptable.
- A successful verify reports `needsRehash` when the hash differs from what this deployment writes: another plan's cost, no pepper, or Better Auth's format. The sign-in then rewrites the hash with the password it just checked (`upgradeStoredPasswordHash`, a compare-and-set on the old hash). A failed rewrite never fails the sign-in.
- After a Paid-to-Free move, the first sign-in of each account verifies a scrypt hash on Free, which can exceed the CPU limit (error 1102; unverified). The "forgot password" email writes a Free hash.
- Turn on staff 2FA (`twoFactor` in `packages/core/src/auth/auth.ts`).

### Queue lanes

A store has one `jobs` queue. `apps/api/src/utils/queue-lanes.ts` makes two lanes out of it:

- **urgent**: OTP, payments, notifications, fulfilment, events, webhooks, plugin deliveries, and any unknown message type.
- **bulk**: `media.render_variants`, `catalog.recommendations.refresh` and `catalog.projections.rebuild`.

Rules:

- A bulk producer reads `queue.metrics().backlogCount` and adds at most the room under the plan's bulk backlog limit, at most one page. An urgent message waits behind a bounded number of bulk jobs, and the consumer starts urgent messages first.
- A cron that finds the bulk lane full waits. It never renders the queue's work inline.
- If the queue refuses an OTP (binding down, or the daily operations spent), `enqueueAuthOtp` delivers it from `waitUntil` (`apps/api/src/utils/otp-queue.ts`) through the consumer's receipt-guarded function. The D1 delivery receipt is claimed once, so a message the queue took after all does nothing.

Free runs one message per consumer invocation, within 50 D1 queries. On Paid the harness runs one batch of each job type at batch size 15 and holds it under 1,000 D1 queries.

### No KV

A store has no KV namespace (an account allows 1,000, and KV was only ever a hint or, worse, a sole copy). The relational provider holds what must persist: OAuth grants and tokens and small markers in `system_kv`, scanner sessions on their `scanner_token_claims` row. Per-colo hints that only spare a database read use the Cache API, keyed by the Worker version (`workerCacheHint` in `packages/shared/src/worker-cache-hint.ts`): the settings mirror, the RBAC seed marker, the Meta CAPI circuit and the "rendition requested" marker. Permission checks always read the database (one batch). Free skips the rendition marker: the scheduled backfill renders.

### Maintenance cron

The cron runs every 15 minutes (`*/15 * * * *` in `apps/api/wrangler.jsonc`). `MAINTENANCE_SWEEPS` in `apps/api/src/scheduled-maintenance.ts` lists the sweeps as data. Each has a slice (`apps/api/src/scheduled/slices.ts`): 18 sweeps in slices 0 to 3, and 3 with the slice `"every"`.

- Free runs one slice per tick, so each sweep runs once an hour. The media rendition backlog runs in slice 3. The `"every"` sweeps (`notification_outbox_flush`, `event_outbox_maintenance`, `plugin_maintenance`) run on every tick.
- Paid has one slice: every sweep runs every tick.
- A sweep's row limit is `floor(limit * limitScale)`, at least 1.

### Frontier cache refresh

The storefront validates cached pages against the DVC change clock ([packages/core/src/cache-deps/README.md](../packages/core/src/cache-deps/README.md)). The slow check scans at most one frontier window (4,000 changes, `FRONTIER_CHECK_MAX_ROWS` in `apps/api/src/cache-frontier.ts`) of `cache_dep` after the page's `s0`. A page older than the window renders again, so a bulk write cannot turn into millions of rows read.

### Large lists

`OFFSET` reads every row before the page, and an unfiltered `count(*)` reads every index row. These lists therefore walk by keyset cursor with a capped count: admin orders, products (and `/api/v1/admin/products/summaries`) and customers, and public product listings sorted by `newest`, `price-asc` and `price-desc`.

The contract (`@scalius/shared/pagination`, `@scalius/core/utils/keyset`):

- `after` and `before` cursors, and `pageInfo` built from `limit + 1` rows.
- `total` is exact up to `planLimits().lists.countCap`. Above it, `total` is the cap and `totalIsCapped` is true.
- A numbered page works only below `maxOffset`. A deeper page is a typed 400 (`PAGE_TOO_DEEP`).
- Both plans use the same logic. Only the two numbers differ.

A cursor travels in a URL, so it never carries personal data. A sort on personal values (orders by customer name, customers by name) issues a reference cursor: sort, direction and row id, no value. `resolveReferencedBoundary` reads the boundary row's value by id when the cursor returns. A cursor for a row that no longer exists is a typed 400 (`INVALID_CURSOR`), and a cursor that carries a name for such a sort is refused. Other sorts carry their value.

### Worker size

`scripts/check-api-bundle.mjs` (`pnpm check:api-bundle`, and every deploy) measures the uncompressed size of the API Worker. That is the number the 64 MiB limit counts. The budget is 64 MiB less 10% (57.6 MiB). The script prints the gzip size and does not gate on it. Bundled plugins compile into this Worker, so a plugin that pushes it over budget fails the deploy.

## After deploying

Check these live:

- CPU time per request (p50 and p99) for `/api/auth/sign-in/email`, `/api/v1/storefront/batch`, `POST /api/v1/orders`, the cron and the queue consumer, and error 1102 ("Worker exceeded resource limits") by route.
- Queues operations per day, the `jobs` backlog (`backlogCount`) during a cron run, and D1 rows written per day.
- `pnpm ops:check --queues` and `pnpm release:check`. Pass `--api-base-url`, and for the release check `--storefront-url` and `--dashboard-url`. The defaults are the Scalius demo hosts.
