# Burst notes: audit R2 performance (B2, B7, B8, B10, B11, A-items except A6)

Base `5a2b7a6a5`. Time-boxed by the lead at 21:30 for new work, so two items landed and the rest are plans.

## Landed

| Commit | Item | Before | After |
| --- | --- | --- | --- |
| `15d8de656` | B2 Free quota against misses | The scale proof printed rows read and gated nothing. FREE-PLAN.md published no catalogue size. | `scripts/scale-proof.mjs` fails a run when a D1 read is over `FREE_MISS_ROWS_CEILING` = 5M / 200 = 25,000 rows. The JSON and doc are written first; the block names each read over the ceiling with its misses a day. FREE-PLAN.md "Catalogue ceiling": up to 10,000 SKUs on Free until the three heavy reads are bounded. |
| `4dc748ea4` | B7 frontier freshness (measurement gap) | `perf:storefront` timed consecutive hits only, so every hit reused a fresh frontier. | `--sparse` / `--sparse-ms <n>` (n > 1000) times a second set of hits, each after a 1.5 s wait, and holds their median to the 50 ms hit budget. The budget is unchanged; the sparse hit simply has to meet it too. A test pins `CACHE_FRONTIER_DELTA_MS` to the storefront's constant. Documented in STOREFRONT-PERFORMANCE.md. |

Gates run: `pnpm exec vitest run scripts/scale-proof.test.mjs` (4/4), `scripts/storefront-perf.test.mjs` (13/13). Neither commit touches dashboard or storefront source, so the source-policy check does not apply.

Measured against the 2026-10-14 scale proof (156,244 SKUs), the new ceiling fails three reads: product page with no stored list 118,253 rows (42 misses a day; B1, owned by the other worker), all products by newest 183,735 (27; A9) and search 52,134 (95; A9). Home 908, category page 1 10,210 and feed page 12,655 pass.

## Unverified

- The scale proof was not rerun. The ceiling verdicts come from the SCALE.md numbers.
- The 10,000-SKU Free figure scales the 156k-SKU reads linearly. At that rate all-products-newest crosses 25,000 rows at about 21k SKUs, so 10k is a margin, not a measurement. The product-page cost tracks orders (live ranking), not SKUs, so it only drops once B1 lands.
- No local stack ran (`pnpm dev` is outside this brief), so there is no sparse-hit TTFB yet. Next step: `pnpm perf:storefront --base http://localhost:4391 --d1-explorer http://localhost:8811 --sparse --no-browser`.
- Production logging of frontier calls per page view (the other half of B7) is not done.

## Not started: plans

- **A1/A2 (dependency write amplification, SQLite).** Today each trigger firing writes its keys at `clock.seq + 1` and raises the clock, so one batch rewrites shared keys once per row (90-product unpublish: 1,530 writes for 99 keys). The design I worked out keeps the gate safe:
  1. Migration 0167 adds `cache_clock.open` (0/1).
  2. A SQLite-only wrapper (`dependencyBatch()` in `@scalius/database`, never on PostgreSQL, whose clock row must stay unwritten) runs first `UPDATE cache_clock SET seq = seq + 1, open = 1` and last `UPDATE cache_clock SET open = 0`.
  3. Each trigger's seq becomes `clock.seq + 1 - clock.open`, which needs no CASE and so is D1-safe. Upserts gain `WHERE cache_dep.seq <> excluded.seq`.
  4. `advanceCacheDeps` uses the same expression.
  5. The backstop: every reader's `CLOCK` subquery returns a null S while `open = 1`. Then `authoritativeClock` throws and the cache fails closed. A batch that never closes cannot produce a reused-seq stale proof; it only disables caching until the next wrapped batch.

  Cost: 0167 must reinstall all ~420 SQLite `cdep_` triggers. The generator needs a "seq v2" render flag so 0100/0101/later migrations stay byte for byte. Then come the DVC harness (`testing/cache-dvc/*`) and the property/race gate at zero findings. Use the wrapper first in checkout commit, bulk chunks, product save and status change. Expected saving: about 15x on dependency rows for multi-row writes, plus 2 clock writes per wrapped batch. Turso's `BEGIN CONCURRENT` conflict on the clock row stays (inherent to one clock). On PostgreSQL (A2), take `cache_dep_next_seq()` only when a key actually changed. It already runs once per transaction.
- **A3 (checkout statements per line).** Move movements, counters and guards to set-based `INSERT ... SELECT FROM json_each(?)` and `UPDATE ... FROM json_each(?)`. Prove it with the 99-line budget rows in `free-plan-budgets.ts`, and lower that budget in the same commit.
- **A4 (event drain).** Claim N due `event_outbox` rows in one `UPDATE ... RETURNING` and settle them in one batch. Then raise Free `eventsPerDrain` through `planLimits()` and record the cron budget.
- **A5 (promotion caps).** Replace `count(*)`/`sum()` over every redemption with `LIMIT max_redemptions`-bounded counts. Keep a spend counter guarded in the checkout batch.
- **A7.** Add `apps/api/src/resources-read-plans.d1.test.ts` on the pattern of `checkout-read-plans.d1.test.ts`, with the `status`/`email` order filters at volume.
- **A8.** Do not require dimensions in the sanitizer (`packages/shared/src/plugins/html.ts`), because it would drop third-party images. Add it to the app-author check (warn on `<img>` without width/height). Let the host mark the lead section's first image `loading=eager fetchpriority=high`.
- **A9.** Precompute unscoped facet counts (an outbox projection) and cap relevance scoring at N matches before the count. These are the reads that fail the new B2 ceiling.
- **A10.** Generate a per-route manifest index (method + template → id) at build time and load full entries lazily. Measure parse CPU in `free-plan-workerd.test.ts` before and after.
- **A11.** Add `--providers turso` to `scale-proof.mjs` against a separate test organization only (AGENTS.md: never one that owns production databases).
- **A12.** Key variant page HTML on the featured photo id rather than the SKU id, or draw the variant client-side from the base entry.
- **B8.** Add a PostgreSQL `EXPLAIN` guard for the feed page (tuples bound), then rerun `scale-proof.mjs --providers postgres` for checkout after 0154.
- **B10.** Needs a dashboard build to measure. Plan: lazy-load the next product-editor addition, move route CSS out of the shared sheet (about 229 B of room) and lazy-load `app.ts` route modules on the API (8.03 of 9 MiB).
- **B11.** Add a warm per-page CPU gate in `free-plan-workerd.test.ts`: the median of N warm product/home batches must stay under 10 ms. Check Workers analytics for 1102 by route on a Free deploy.
