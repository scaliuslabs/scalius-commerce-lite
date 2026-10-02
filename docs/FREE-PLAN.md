# Running on Workers Free

Scalius deploys and runs on the Cloudflare Workers **Free** plan and scales up on **Paid**. Free is
the default: the committed Wrangler configs deploy there unchanged. A Paid deploy is one flag.

Last checked against Cloudflare's published limits: 2026-10-03.

## The plan profile

Every limit Scalius adapts to the plan is a value in one typed profile,
`packages/shared/src/plan-limits.ts` (`PLAN_LIMITS`). The plan is decided once, at deploy time:

```sh
pnpm run deploy                 # Free (the default)
pnpm run deploy --plan paid     # Workers Paid (or SCALIUS_PLAN=paid)
pnpm run deploy --plugin-sandbox  # the Worker Loader needs Paid: implies --plan paid
```

`--plan paid` generates `apps/api/wrangler.deploy.gen.json` beside the committed config (git-ignored) with
`limits.cpu_ms`, the larger queue batch sizes and `define: { __SCALIUS_PLAN__ }`, a build constant that
`planLimits()` reads. It is not an environment variable and not a secret; nothing at request time reads it
except through `planLimits()`. Without the flag nothing is defined and the deployment is Free.
`pnpm check:env` keeps the committed configs at the Free profile (no `limits`, Free batch sizes).

Code reads values; it never branches on the plan's name. The Paid values are what the code did before
the profile existed, or stronger, and `packages/shared/src/plan-limits.test.ts` pins them: lowering one
fails the test.

| Limit | Free | Paid |
| --- | --- | --- |
| Worker CPU (`limits.cpu_ms`) | not set (fixed 10 ms) | 30,000 ms (unchanged) |
| New password hash | PBKDF2-SHA256, 30,000 iterations (2-3 ms) | scrypt N=16384, r=16, p=1 (as before) |
| `jobs` consumer `max_batch_size` | 1 | 15 (was 10) |
| Dead-letter consumer `max_batch_size` | 1 | 10 |
| Bulk backlog limit (no fan-out at or above it) | 20 messages | 1,000 |
| Bulk page (messages per producer call) | 10 | 1,000 |
| Nightly recommendation refreshes | 150 products | 3,000 |
| Products per recommendation message | 5 | 20 |
| Catalogue rebuild chunk | 90 products | 900 |
| Rendition queued from a public read | off | on |
| Checkout recovery KV hints | off (polls read D1) | on |
| Permission snapshot in KV | off (checks read D1) | on |
| Cron: sweeps rotate through | 4 slices (each once an hour) | 1 (every sweep every 15 min) |
| Cron: each sweep's row limit | 20% | 100% |
| Cron: images rendered inline when the queue cannot take them | 1 | 240 |
| List total counted up to | 1,000 | 10,000 |
| Deepest `OFFSET` page | 1,000 rows | 10,000 rows |

## The limits

| | Free | Paid |
| --- | --- | --- |
| CPU per HTTP request, queue invocation, cron run | 10 ms | 30 s default, up to 5 min |
| Subrequests per invocation | 50 external, 1,000 to Cloudflare services | 10,000 |
| D1 queries per invocation (a `batch()` is one) | 50 | 1,000 |
| D1 | 500 MB, 5M rows read and 100k rows written a day | 10 GB |
| KV | 100k reads, 1,000 writes, 1,000 deletes a day | unlimited |
| Queues | 10,000 operations a day (a delivered message is 3) | metered |
| Worker script | 64 MiB uncompressed on both plans, no compressed limit | same |
| Worker startup (global scope) | 1 s | 1 s |

Cloudflare says an isolate gets "some built-in flexibility" for an infrequent overrun of the CPU limit;
consistent overruns end in error 1102.

## Measuring it

```sh
pnpm free-plan:budget             # the Node tier, both profiles: tables + daily quota
pnpm free-plan:budget --workerd   # plus real CPU in workerd (Miniflare)
pnpm free-plan:budget --record    # measure only; prints the budgets file source
```

The Node tier (`apps/api/src/free-plan-budget.test.ts`) drives the real Worker entrypoints (`fetch`,
`queue`, `scheduled`) over an in-memory D1 with every binding metered, and asserts each deterministic counter
(D1 calls and statements, KV reads/writes/deletes, queue messages, external subrequests) against
`apps/api/src/testing/free-plan-budgets.ts` and the plan's per-invocation limits. A new query, a new KV write
or a bigger fan-out fails there first. CPU there is V8 CPU minus the SQLite engine's: a relative figure.
The workerd tier (`free-plan-workerd.test.ts`) runs the bundled Worker in workerd; local workerd's clock
advances while JavaScript runs, so CPU is wall time minus time waiting on the D1 proxy. It is the only place
cold route graphs, and the real hashing cost, show up.

### What a day costs on Free (100 orders a day)

Model: a 3-line checkout and every message it queues, two tax quotes, half the buyers signing in by
emailed code, 20 page views (5% cache misses) per order, 96 cron runs a day.

| Resource | Before | Free profile now | Free limit |
| --- | --- | --- | --- |
| KV writes | 200+ (two checkout hints per order, permission snapshots, an OTP delete per code) | **0** | 1,000 |
| KV reads | about 2,800 (one platform read per request) | about 2,800 | 100,000 |
| Queue operations | up to 3,000 per cron run while images were missing renditions (1,000 jobs, the same ones again every 15 minutes) | **550** | 10,000 |
| D1 rows written (estimate) | about 47,000 | about 47,000 | 100,000 |

D1 rows written is the quota that ends a Free store first: about 210 orders a day. A sign-in by code
creates a customer and a session (62 rows changed), a 3-line checkout about 110.

## Decisions

### Password hashing

Better Auth's scrypt costs 53-80 ms of CPU in workerd (measured: hash and verify both): a staff sign-in
could never fit 10 ms. Hashes are now self-describing and versioned
(`packages/core/src/auth/password-hash.ts`):

```
$sc1$pbkdf2-sha256$i=30000,k=1$<salt>$<hash>      Free
$sc1$scrypt$N=16384,r=16,p=1,k=1$<salt>$<hash>    Paid
<32 hex>:<128 hex>                                Better Auth's own, still verified
```

- Free uses WebCrypto PBKDF2 (native in workerd): 2-3 ms per hash or verify, leaving about 7 ms for the rest
  of a sign-in (9 ms warm in workerd, measured). Paid keeps today's scrypt.
- `k=1` means the password was keyed with a pepper first: HMAC-SHA256 under a key derived (HKDF) from
  `CREDENTIAL_ENCRYPTION_KEY`, which a copy of D1 does not contain. A leaked database alone cannot
  test a single guess whatever the iteration count, which is what makes 30,000 iterations acceptable.
  The pepper source is the key that survives a `SCALIUS_SECRET` rotation; losing it already costs every
  stored provider credential.
- A password that verifies against a hash this deployment would not write now (another plan's cost, no
  key, Better Auth's format) is rewritten with the password just checked, by compare-and-set on the old
  hash. Free to Paid: the next sign-in upgrades to scrypt. Paid to Free: the next sign-in rewrites to PBKDF2.
  A failed rewrite never fails the sign-in.
- Verifying a scrypt hash costs 53 ms or more, which Free cannot afford every time; it happens once per
  account after a Paid-to-Free move or for an account that was created before this change. Cloudflare's
  tolerance for an infrequent overrun normally lets it through. If a sign-in fails with error 1102, the
  "forgot password" email writes a Free hash.
- Staff 2FA (TOTP, email code) is HMAC: cheap on both plans. Turn it on: it is the control that matters
  more than the iteration count.

### Queue lanes

One `jobs` queue per store (a Wrangler resource rule), two lanes made out of it
(`apps/api/src/utils/queue-lanes.ts`):

- **urgent**: OTP, payments, notifications, fulfilment, events, webhooks, plugin deliveries.
- **bulk**: renditions and catalogue refreshes (`media.render_variants`, `catalog.recommendations.refresh`,
  `catalog.projections.rebuild`).

Bulk producers read `queue.metrics().backlogCount` and add only what fits under the plan's bulk backlog limit,
at most one page, starting behind the jobs already queued, so an urgent message waits behind at most a
bounded handful of bulk jobs. The consumer starts urgent messages first. A cron that finds the queue full
waits; it never renders the queue's work inline. An OTP whose queue handoff fails (binding down, or the 10,000
daily operations spent) is delivered directly from `waitUntil` by the same receipt-guarded function the
consumer runs (`apps/api/src/utils/otp-queue.ts`); the delivery receipt is claimed once, so a message the
queue did take after all does nothing.

Free runs one message per consumer invocation: a notification uses 27 D1 queries and a 5-product
recommendation refresh 11, against 50 per invocation. Paid batches 15: the heaviest message (20 products,
36 queries) keeps a batch under 600 of Paid's 1,000.

Queue operations per order: a delivered message is 3 operations; a checkout queues 1 (the order
notification), so 100 orders a day use 550 of Free's 10,000 including sign-in codes.

### KV hints

D1 is the authority for every KV hint. A hint write never fails the request that wanted it
(`packages/shared/src/kv-hints.ts`: `putKvHint`/`deleteKvHint`), and a refusal that looks like a quota or
per-key rate limit opens an in-isolate breaker (30 s, doubling to 10 min): an exhausted day costs a few
failing calls per isolate, not one per hint. Free also stops writing the hints that are an accelerator only:
checkout status and receipt markers (a poll reads `checkout_attempts` instead), the permission snapshot (a
check is one D1 batch), and the "rendition requested" marker (a public read queues nothing; the scheduled
backfill renders). An OTP delivery costs no KV call on its first attempt.

### Maintenance cron

The 25 sweeps are data (`MAINTENANCE_SWEEPS` in `apps/api/src/scheduled-maintenance.ts`) in four slices.
Free runs one slice a tick (each sweep once an hour, at 20% of its row limit) plus the sweeps nobody should
wait on every tick: the notification outbox, the event outbox (dispatch and webhook retries) and the plugin
tick. Paid has one slice: every sweep every tick, as before. Idle, a Free tick makes 14-29 D1 queries (the
limit is 50) against 38-53 for everything at once.

### Frontier cache refresh

One frontier refresh and one slow-path check run per isolate; concurrent requests join them
(`apps/storefront/src/lib/cache-frontier.ts`, `singleFlight`). A request whose merchant `_sv` link names a
newer write than the refresh it joined asks for one more, so it reads its own writes. The slow check scans
one frontier window (4,000 changes) of `cache_dep`; an older page is re-rendered (it was 20,001 rows per
stale page, which a bulk write could turn into millions of rows read). Making the check exact would need it
to look the page's keys up by hash instead of scanning the changes since its `s0`: an indexed `dep_hash`
column on `cache_dep`. The triggers that write `cache_dep` run in SQLite, so that needs a hash SQLite can
compute (or the storefront holding keys in a form the API can index): a migration, which this round did
not allow.

### Worker size

The size gate budgets the uncompressed size, the number the 64 MiB limit counts (`scripts/check-api-bundle.mjs`):
the API Worker is 11 MiB (2 MiB gzip).

## What cannot fit Free

Measured in workerd with a quiet machine; production CPUs differ.

- **Cold route graphs.** The first request of each route family in an isolate (dashboard 18 ms, admin API
  164 ms, public API 35-40 ms) evaluates its modules inside the request. Free has 10 ms. Warm requests are
  4-9 ms. A busy store keeps isolates warm; a quiet one pays it on the first request after idle. Evaluating
  the route graphs at startup (free of request CPU, 1 s limit) is the only fix and trades cold-start time.
- **A 20-line checkout commit** is 12-15 ms warm (109 statements in one batch); a 99-line one about
  100 ms in Node. Typical carts are 1-5 lines.
- **Storefront page renders** that miss every cache (home 22 ms, product 27 ms in Node) exceed 10 ms; hits
  are 2-4 ms. The storefront Worker's own Astro rendering is not measured here.
- **A first sign-in after a Paid-to-Free move** (scrypt verify, 53 ms) relies on the isolate's overrun
  tolerance, or the forgot-password email.
- **D1 rows written** (about 210 orders a day) and the **Images transformation allowance** (5,000 a month,
  13 per image: about 380 images a month) end a Free store before any CPU limit does.

## After deploying: what to check live

- Workers Logs / the dashboard's CPU time per request, p50 and p99, for `/api/auth/sign-in/email`,
  `/api/v1/storefront/batch`, `POST /api/v1/orders`, the cron and the queue consumer.
- Errors: 1102 ("Worker exceeded resource limits") counts by route in Workers Metrics.
- KV: writes and deletes per day in the KV namespace's metrics (Free: should be near zero).
- Queues: operations per day, and the backlog (`backlogCount`) of `jobs` during a cron run.
- D1: rows written per day.
- `pnpm ops:check --queues` and `pnpm release:check`.
