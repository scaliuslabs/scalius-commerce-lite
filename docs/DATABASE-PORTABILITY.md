# Database Portability and Cutover

Scalius uses one canonical SQLite domain model with two operational tiers:

- Cloudflare D1 is the default starter. It has the lowest provisioning and
  operational complexity and remains suitable for most merchants for a long
  time.
- Turso is the supported concurrent-writer SQLite tier. It uses the same domain
  schema and application services through the `@scalius/database` adapter, but
  the provider choice alone is not an orders-per-second guarantee.
- PostgreSQL/Neon is a future provider adapter, not a collection of conditionals
  spread through commerce services. Its different dialect and transaction
  semantics require its own migration compiler and verification suite before it
  can become a selectable production provider.

The application does not provision databases or move data. A hosted Scalius
control plane owns provider accounts, database creation, migration state,
Worker secrets, deployments, health checks, rollback retention, and eventual
source retirement. Per-merchant Workers and resources remain isolated.

## Runtime contract

`@scalius/database` is the only runtime provider boundary. D1 is selected when
no Turso secrets are present. A Turso deployment requires all three secrets on
both API and admin Workers:

- `DATABASE_PROVIDER=turso`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

An incomplete pair fails closed. `DATABASE_PROVIDER=d1` is an explicit rollback
pin while Turso secrets are retained. Adding a connection string does not move
data and must never trigger an implicit request-path migration.

Provider capability differences stay behind shared helpers. D1 keeps FTS5,
recursive CTE, and `WITHOUT ROWID` support. The Turso migration compiler omits
unsupported physical artifacts, while bounded provider-aware search/navigation
helpers preserve the public contract. Atomic domain writes use `safeBatch()`;
the Turso adapter sends one `BEGIN CONCURRENT` batch and retries only explicit
MVCC conflict/busy failures.

## Deterministic D1 to Turso protocol

The control plane must persist a resumable migration record and evidence for
each transition:

1. Enable `DATABASE_MIGRATION_FREEZE` on every Worker that can write. API health
   and readiness remain available; ordinary API/admin traffic is rejected,
   queues retry, and cron mutation is skipped.
2. Wait for in-flight work to settle, persist the authoritative D1 Time Travel
   bookmark, and run `export:d1-portable` with `--expected-bookmark`. It exports
   only the canonical application tables and refuses the result unless the D1
   bookmark is unchanged before and after export. One bookmark-bound export is
   stronger and faster than two best-effort dumps with matching hashes.
3. Run `prepare:turso-upload` to normalize the trusted export onto the current
   canonical table/column set and create a native Turso MVCC upload artifact.
   Reject missing current tables/columns, unhandled nullability drift, row-count
   drift, foreign-key violations, or a failed integrity check. Record every
   discarded retired column and ignored retired table with its row count. The
   bundle and evidence are private, create-only files; the command refuses an
   existing destination and fsyncs the completed artifact.
4. Run `provision-upload:turso` from the external control plane. It checks the
   organization's current storage usage and plan quota before creating a
   database, refuses an over-quota upload when overages are disabled, and
   requires `--allow-storage-overage` before a billable upload. It then creates
   a native `database_upload` target, mints a temporary database token, streams
   the MVCC file, and verifies the remote journal mode, logical schema/data
   fingerprint, table/row counts, `foreign_key_check`, and `integrity_check`.
5. Rotate the temporary database tokens and persist provision, upload, and
   final receipts containing hashes and safe target identity only. A completed
   retry resolves locally from matching receipts; a partial retry resumes from
   the last verified phase instead of silently recreating the target.
6. Install provider secrets, deploy API and admin, and require repeated Turso
   readiness success before removing the freeze.
7. Exercise public reads, authenticated admin reads, one idempotent checkout,
   order transition, inventory release, queues, storefront rendering, and
   browser hydration. Re-run the production ops and release checks.
8. Retain the frozen D1 source for the configured rollback window. Destroy it
   only through a separate, explicit retention policy.

The normalizer and bundle builder stream through SQLite/files instead of holding
the SQL dump in JavaScript memory. The implemented disk preflight requires at
least `2 × export bytes + 2 GiB` free in addition to the retained input; actual
peak storage is approximately the input plus source and target copies. D1
export time, provider transfer time, remote verification time, database quota,
and the full freeze duration remain deployment-specific gates.

Adding the verified target URL/token and changing `DATABASE_PROVIDER` is only
the final traffic switch. A connection string alone cannot safely perform the
export, data movement, verification, token rotation, deployment, or rollback
retention.

## Rollback rule

Before the first target write, rollback is a provider pin and redeploy. After
Turso accepts writes, the retained D1 snapshot is stale. Switching back without
a reverse migration would lose orders, inventory movements, sessions, and other
merchant facts. The control plane must either migrate the Turso delta/full state
back into a verified D1 target or present rollback as a deliberate restore to
the cutover snapshot with an explicit data-loss decision.

## Verified live cutover — 2026-08-01

The production Scalius demo domains were migrated in place from D1 to Turso and
left live on Turso for merchant testing. The retained D1 database was not
modified or destroyed.

- Two settled 6,253,644-byte source snapshots matched at SHA-256
  `ee63f0344521c43c960a2c18fa92254bdaa81ee3ca7646fcf8ba8c1cca61484e`.
- Normalization projected 105 canonical tables and 15,189 rows, discarded eight
  retired columns, deterministically repaired 80 legacy null update timestamps,
  and passed integrity/foreign-key checks.
- The normalized data fingerprint matched on source and target:
  `0e1e8180c70787a5587a07995497abb3e6148856e6fac5a0fcc6c87e06f4552e`.
- The streaming compiler suspended/restored 64 triggers, cleared 105 target
  tables, and reproduced the proven import SHA-256
  `b505eeed25484b44bcf5d098214c715106cf6fb1892c1f430b6d95c6622ea861`.
- A real storefront COD checkout created order `XM7YH7W45WWN9C21`; the normal
  admin workflow cancelled it. The ledger recorded exactly one reserve and one
  release edge, every net stock/reserved/preorder delta was zero, the order
  reached `inventory_action=restored`, and target integrity remained `ok`.
- Production readiness, queue metadata, dashboard auth gates, storefront pages,
  discovery feeds/XML, UCP catalog discovery, product rendering, browser
  checkout/admin/search hydration, and browser console diagnostics passed.

An isolated conflict test also committed 512 atomic two-statement transactions
at concurrency 64 with exact event/counter totals. That proves adapter
correctness under conflict; it is not an orders-per-second benchmark. A capacity
claim requires a disposable fully migrated merchant, Worker-origin load,
realistic SKU contention, stubbed providers, queue drain measurements, regional
latency percentiles, and explicit error/oversell/duplicate-order SLOs.

## Verified migration and Worker-origin load — 2026-08-02

The current bookmark-bound/native-upload path was exercised separately from the
production demo so failures could not mutate merchant data:

- A real D1 export was pinned to bookmark
  `00007859-00000000-000050ba-c50b946f72a89c233d44ae33711fc439`.
  It contained 105 canonical tables and 15,189 rows. Two independent
  preparations produced the same 8,089,600-byte MVCC artifact at SHA-256
  `e068a90cebaacf116b6341483141f2d6af22a8828a34c2255003b972b8663cd1`.
- The one-command control-plane flow created a disposable native-upload target,
  uploaded and remotely verified all 105 tables/15,189 rows, matched logical
  fingerprint
  `4de71904216ca86e04e535ec57995b7bf7cedb30aea298827ac1398287a63c4b`,
  rotated temporary tokens, and then completed a second invocation entirely
  from local receipts. The disposable target was destroyed after verification.
- A synthetic 8.25-GiB source-storage rehearsal generated an 8,435,940,916-byte
  SQL export and an 8,858,222,592-byte MVCC artifact with 990,393 canonical
  rows. Exact preparation took 303,261 ms (about 5 minutes 3 seconds), peak Node
  RSS was 686,309,376 bytes, and integrity/foreign-key checks passed. This proves
  bounded-memory local preparation, not D1 network export or remote upload
  duration. The retained input plus working files occupied roughly 24 GB.
- The authenticated Turso organization was on Starter with a hard
  5,000,000,000-byte storage quota and overages disabled, so the real 8.86-GB
  provider upload was correctly refused before target creation. An 8-GB
  merchant therefore needs confirmed paid Turso headroom or a PostgreSQL/Neon
  target; migration automation must never assume that a Turso account can fit
  the database.

A disposable API Worker backed by a migrated Turso database then exercised real
cart validation, COD checkout, committed idempotency replay, receipt access,
support request, authenticated order cancellation, inventory reserve/release,
and ledger-v2 invariants. External payment/notification providers were disabled,
and KV rate limiting was intentionally absent, so these measurements isolate the
current Worker/database path rather than representing a complete production
capacity test.

- A 25-request simultaneous replay of one checkout ID produced exactly one
  order, item, and checkout attempt (18 committed responses and seven in-flight
  responses), with no duplicate order.
- Independent untracked-SKU orders were clean at 2 arrivals/second (20/20). At
  5 arrivals/second, one 20-order run passed, but a sustained 40-order run
  committed only 30; ten requests exhausted all eight adapter retries with
  `Write-write conflict`.
- Against one tracked SKU, a controlled 2 arrivals/second run accepted exactly
  the 16 remaining units and rejected nine out-of-stock attempts without
  overselling. A 30 arrivals/second burst caused conflict/retry failures and
  stale in-progress checkout leases; correctness held, but capacity did not.
- A real admin cancellation advanced the order version once, released exactly
  one reservation through the paired ledger edges, and left database integrity
  and foreign keys clean.
- Forced public product cache misses had roughly 13–15 second median/tail
  service latency in this disposable no-KV configuration. Edge-cached shopper
  traffic and database-bound misses must be capacity-tested and reported as
  different paths.

These results do not support a thousands-of-orders-per-second claim. Turso's
concurrent-writer engine preserves the adapter's atomicity and can remove D1's
single-writer ceiling, but the current checkout still performs enough
synchronous reads/writes and touches enough shared SQLite pages that conflicts
dominate far earlier. Raising retry counts would increase latency rather than
solve that architecture.
