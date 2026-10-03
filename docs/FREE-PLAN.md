# Running on Workers Free

This page covers how Scalius runs on the Cloudflare Workers Free plan and scales up on Workers Paid. It is for operators who pick a plan and for contributors who add queries, KV writes or queue messages.

Free is the default: the committed Wrangler configs deploy there unchanged. A Paid deploy adds one flag.

Last checked against Cloudflare's published limits: 2026-10-03.

## The plan profile

Every limit that Scalius adapts to the plan is a value in one typed profile: `PLAN_LIMITS` in `packages/shared/src/plan-limits.ts`. The deploy decides the plan once.

```sh
pnpm run deploy                    # Free (the default)
pnpm run deploy --plan paid        # Workers Paid (or SCALIUS_PLAN=paid)
pnpm run deploy --plugin-sandbox   # Worker Loader: needs Paid, implies --plan paid
```

`scripts/plan.mjs` picks the plan in this order: the `--plan` flag, the `SCALIUS_PLAN` variable of the deploy shell (no Worker reads it), Paid when the plugin sandbox is on, else Free. An explicit Free with the sandbox on fails. The sandbox is on with `--plugin-sandbox`, `SCALIUS_PLUGIN_SANDBOX=1` or `pnpm plugin sandbox on`.

A Paid deploy writes `apps/api/wrangler.deploy.gen.json` (git-ignored) beside the committed config. It adds `limits.cpu_ms`, the larger `max_batch_size` of the `jobs` and `jobs-dlq` consumers, and `define: { __SCALIUS_PLAN__: "paid" }`. `planLimits()` reads that build constant. It also adds `limits.cpu_ms` to the generated storefront config (`apps/storefront/dist/server/wrangler.json`). `--plan paid` fails with a custom `--wrangler-config`: set the same values in that file.

`__SCALIUS_PLAN__` is not an environment variable and not a secret. Without it the deployment is Free. `pnpm check:env` fails when a committed Wrangler config declares `limits`, defines `__SCALIUS_PLAN__`, or sets a queue batch size other than the Free value.

Code reads values from the profile and never branches on the plan name. Paid values keep at least the baseline the code had before the profile existed. `packages/shared/src/plan-limits.test.ts` fails when a Paid value drops below it.

| Limit | Free | Paid |
| --- | --- | --- |
| Worker CPU (`limits.cpu_ms`) | not set (fixed 10 ms) | 30,000 ms |
| New password hash | PBKDF2-SHA256, 30,000 iterations | scrypt N=16384, r=16, p=1 |
| `jobs` consumer `max_batch_size` | 1 | 15 |
| Dead-letter consumer `max_batch_size` | 1 | 10 |
| Bulk backlog limit (no bulk fan-out at or above it) | 20 messages | 1,000 |
| Bulk page (messages per producer call) | 10 | 1,000 |
| Products per recommendation message | 5 | 20 |
| Catalogue rebuild chunk | 90 products | 900 |
| Rendition queued from a public read | off | on |
| Checkout recovery KV hints | off (polls read D1) | on |
| Permission snapshot in KV | off (checks read D1) | on |
| Cron slices (each sweep runs once per rotation) | 4 (hourly) | 1 (every 15 minutes) |
| Cron: each sweep's row limit | 20% | 100% |
| Cron: images rendered inline when the queue cannot take them | 1 | 240 |
| List total counted up to (`countCap`) | 1,000 | 10,000 |
| Deepest numbered page (`maxOffset`) | 1,000 rows | 10,000 rows |

`nightlyRecommendationRefreshLimit` (150 Free, 3,000 Paid) is in the profile, but no code reads it. The nightly pass refreshes up to 3,000 products on both plans (`NIGHTLY_RECOMMENDATION_REFRESH_LIMIT` in `apps/api/src/scheduled/catalog-projections.ts`).

## The Cloudflare limits

The budget harness encodes the per-invocation limits (`apps/api/src/free-plan-budget.test.ts`) and the daily quotas (`scripts/free-plan-budget.mjs`). Figures marked (unverified) come from Cloudflare's pages only.

| Free limit | Value |
| --- | --- |
| CPU per HTTP request, queue invocation and cron run | 10 ms |
| Subrequests per invocation | 50 external, 1,000 to Cloudflare services |
| D1 queries per invocation (a `batch()` is one) | 50 |
| D1 per day | 5M rows read, 100,000 rows written |
| KV per day | 100,000 reads, 1,000 writes, 1,000 deletes |
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

- **Node tier** (`apps/api/src/free-plan-budget.test.ts`). It drives the real Worker entrypoints (`fetch`, `queue`, `scheduled`) over an in-memory D1 and meters every binding. It asserts D1 calls and statements, KV operations, queue messages and external subrequests against `apps/api/src/testing/free-plan-budgets.ts` and the plan's per-invocation limits. A new query, KV write or fan-out fails here first. CPU in this tier is a relative figure.
- **workerd tier** (`apps/api/src/free-plan-workerd.test.ts`). It runs the bundled Worker in workerd. CPU is wall time minus time waiting on the D1 proxy. Only this tier shows cold route graphs and real hashing cost. The Free password hash and verify must each stay below 5 ms (best of 15 runs).

### Daily quota model

Per order, the model is a 3-line checkout with every message it queues, two tax quotes, an emailed sign-in code for half the buyers, and 20 page views (5% cache misses). The cron adds 96 runs a day. D1 rows written are rows changed times 3, to count index entries. The command prints each resource against its Free quota.

In the 100-order run of 2026-10-03, D1 rows written (about 47,000 a day) ended a Free store first, at about 210 orders a day (unverified: rerun the command).

## Rules by area

### Password hashing

Better Auth's scrypt costs about 80 ms of CPU in workerd, so a staff sign-in cannot fit 10 ms. `packages/core/src/auth/password-hash.ts` writes self-describing, versioned hashes:

```text
$sc1$pbkdf2-sha256$i=30000,k=1$<salt>$<hash>      Free
$sc1$scrypt$N=16384,r=16,p=1,k=1$<salt>$<hash>    Paid
<32 hex>:<128 hex>                                Better Auth's own hash, still verified
```

- Free uses WebCrypto PBKDF2, which is native in workerd.
- `k=1` means the password was keyed with a pepper first: HMAC-SHA256 under a key that HKDF derives from `CREDENTIAL_ENCRYPTION_KEY`. A copy of D1 does not contain that key, so a leaked database alone cannot test a guess. This is why 30,000 iterations are acceptable.
- A successful verify reports `needsRehash` when the hash differs from what this deployment writes: another plan's cost, no pepper, or Better Auth's format. The sign-in then rewrites the hash with the password it just checked (`upgradeStoredPasswordHash`, a compare-and-set on the old hash). A failed rewrite never fails the sign-in.
- Verifying a scrypt hash on Free costs 53 ms or more (unverified). It happens once per account after a Paid-to-Free move and relies on Cloudflare's tolerance for an infrequent CPU overrun (unverified). If a sign-in fails with error 1102, the "forgot password" email writes a Free hash.
- Turn on staff 2FA (`twoFactor` in `packages/core/src/auth/auth.ts`). It protects an account more than the iteration count does.

### Queue lanes

A store has one `jobs` queue. `apps/api/src/utils/queue-lanes.ts` makes two lanes out of it:

- **urgent**: OTP, payments, notifications, fulfilment, events, webhooks, plugin deliveries, and any unknown message type.
- **bulk**: `media.render_variants`, `catalog.recommendations.refresh` and `catalog.projections.rebuild`.

Rules:

- A bulk producer reads `queue.metrics().backlogCount` and adds at most the room under the plan's bulk backlog limit, at most one page. An urgent message waits behind a bounded number of bulk jobs.
- The consumer starts urgent messages first.
- A cron that finds the bulk lane full waits. It never renders the queue's work inline.
- If the queue refuses an OTP (binding down, or the daily operations spent), `enqueueAuthOtp` delivers it from `waitUntil` (`apps/api/src/utils/otp-queue.ts`). It uses the consumer's receipt-guarded function, and the D1 delivery receipt is claimed once, so a message the queue took after all does nothing.

Free runs one message per consumer invocation. The recorded budgets are 27 D1 queries for a notification and 11 for a 5-product recommendation refresh, against 50 per invocation. On Paid the harness runs one batch of each job type at batch size 15 and holds it under 1,000 D1 queries. The heaviest recorded batch is 510 (`catalog.recommendations.refresh`).

### KV hints

D1 is the authority for every KV hint. A hint write never fails the request that wanted it (`putKvHint` and `deleteKvHint` in `packages/shared/src/kv-hints.ts`). A refusal that looks like a quota or key-rate limit opens a breaker in the isolate: 30 s, doubling up to 10 min. An exhausted day costs a few failing calls per isolate, not one per hint.

Free also skips the hints that only accelerate:

- Checkout status and receipt markers. A poll reads `checkout_attempts`.
- The permission snapshot. A check is one D1 batch.
- The "rendition requested" marker. A public read queues nothing, and the scheduled backfill renders.

### Maintenance cron

The cron runs every 15 minutes (`*/15 * * * *` in `apps/api/wrangler.jsonc`). `MAINTENANCE_SWEEPS` in `apps/api/src/scheduled-maintenance.ts` lists the sweeps as data. Each has a slice (`apps/api/src/scheduled/slices.ts`): 18 sweeps in slices 0 to 3, and 3 with the slice `"every"`.

- Free runs one slice per tick, so each sweep runs once an hour. The media rendition backlog runs in slice 3.
- Free runs the `"every"` sweeps on every tick: `notification_outbox_flush`, `event_outbox_maintenance` (event dispatch and webhook retries) and `plugin_maintenance`.
- Paid has one slice: every sweep runs every tick.
- A sweep's row limit is `floor(limit * limitScale)`, at least 1.
- The recorded budget of an idle tick is 38 D1 queries on Free (limit 50) and 62 on Paid (limit 1,000).

### Frontier cache refresh

The storefront validates cached pages against the DVC change clock ([packages/core/src/cache-deps/README.md](../packages/core/src/cache-deps/README.md)). One frontier refresh and one slow-path check run per isolate, and concurrent requests join them (`singleFlight` in `apps/storefront/src/lib/cache-frontier.ts`). A request whose merchant `_sv` link names a newer write than the refresh it joined asks for one more refresh, so it reads its own writes (`freshFrontier` in `apps/storefront/src/lib/public-worker-cache.ts`).

The slow check scans at most one frontier window (4,000 changes, `FRONTIER_CHECK_MAX_ROWS` in `apps/api/src/cache-frontier.ts`) of `cache_dep` after the page's `s0`. A page older than the window renders again, so a bulk write cannot turn into millions of rows read. An exact check would need an indexed hash column on `cache_dep`, because the storefront holds only key hashes. No such column exists.

### Large lists

`OFFSET` reads every row before the page, and an unfiltered `count(*)` reads every index row. These lists therefore walk by keyset cursor with a capped count:

- Admin orders, products (and `/api/v1/admin/products/summaries`) and customers.
- Public product listings sorted by `newest`, `price-asc` and `price-desc`.

The contract (`@scalius/shared/pagination`, `@scalius/core/utils/keyset`):

- `after` and `before` cursors, and `pageInfo` built from `limit + 1` rows.
- `total` is exact up to `planLimits().lists.countCap`. Above it, `total` is the cap and `totalIsCapped` is true.
- A numbered page works only below `maxOffset`. A deeper page is a typed 400 (`PAGE_TOO_DEEP`).
- Both plans use the same logic. Only the two numbers differ.

A cursor travels in a URL, so it never carries personal data. A sort on personal values (orders by customer name, customers by name) issues a reference cursor: sort, direction and row id, no value. `resolveReferencedBoundary` reads the boundary row's value by id when the cursor returns.

- A cursor for a row that no longer exists is a typed 400 (`INVALID_CURSOR`).
- A cursor that still carries a name for such a sort is refused.
- Other sorts (dates, totals, status, product names) carry their value.

No migration adds these indexes (not built). They would serve the default customer list, the default product list and the shop-all price total:

```sql
CREATE INDEX product_buyer_state_to_price_idx ON product_buyer_state (is_public, to_minor);
CREATE INDEX customers_admin_updated_idx ON customers (deleted_at, updated_at, id);
CREATE INDEX products_admin_updated_idx ON products (deleted_at, updated_at, id);
```

### Worker size

`scripts/check-api-bundle.mjs` (`pnpm check:api-bundle`, and every deploy) measures the uncompressed size of the API Worker. That is the number the 64 MiB limit counts. The budget is 64 MiB less 10% (57.6 MiB). The script prints the gzip size and does not gate on it. Bundled plugins compile into this Worker, so a plugin that pushes it over budget fails the deploy.

## What does not fit Free

These CPU figures are workerd-tier measurements on a quiet machine, not reproduced in the last review (unverified). Production CPUs differ.

- **Cold route graphs.** The first request of each route family in an isolate evaluates its modules inside the request: dashboard 18 ms, admin API 164 ms, public API 35-40 ms. Warm requests take 4-9 ms. Evaluating the route graphs at startup is the only fix, and it trades cold-start time.
- **A 20-line checkout commit** takes 12-15 ms warm (109 statements in one batch). Typical carts have 1-5 lines.
- **Storefront renders that miss every cache** take 22 ms (home) and 27 ms (product) in Node. Hits take 2-4 ms. The harness does not measure the storefront Worker's own Astro rendering.
- **The first sign-in after a Paid-to-Free move** relies on the overrun tolerance or the forgot-password email.
- **D1 rows written** and the **Images allowance** end a Free store before any CPU limit does.

## After deploying

Check these live:

- Workers Logs or the dashboard: CPU time per request, p50 and p99, for `/api/auth/sign-in/email`, `/api/v1/storefront/batch`, `POST /api/v1/orders`, the cron and the queue consumer.
- Workers Metrics: error 1102 ("Worker exceeded resource limits") by route.
- KV namespace metrics: writes and deletes per day. On Free they stay near zero.
- Queues: operations per day, and the `jobs` backlog (`backlogCount`) during a cron run.
- D1: rows written per day.
- `pnpm ops:check --queues` and `pnpm release:check`. Pass `--api-base-url`, and for the release check `--storefront-url` and `--dashboard-url`. The defaults are the Scalius demo hosts.
