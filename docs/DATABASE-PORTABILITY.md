# Database Portability and Cutover

Scalius exposes one provider-neutral commerce model through three operational
database tiers:

- Cloudflare D1 is the default starter. It has the lowest provisioning and
  operational complexity and remains suitable for most merchants for a long
  time.
- TursoDB is the supported concurrent-writer SQLite tier. A `turso://` endpoint
  selects concurrent atomic batches; legacy `libsql://`/HTTPS endpoints retain
  conservative immediate transactions. It uses the same domain schema and
  services, but provider selection alone is not a throughput guarantee.
- PostgreSQL/Neon is the proven high-throughput tier. Its adapter translates the
  canonical SQLite-shaped application surface, while its checkout commit uses
  native PostgreSQL transactions and conflict handling. Dialect differences do
  not leak into routes or commerce services.

The application does not provision databases or move data. A hosted Scalius
control plane owns provider accounts, database creation, migration state,
Worker secrets, deployments, health checks, rollback retention, and eventual
source retirement. Per-merchant Workers and resources remain isolated.

## Runtime contract

`@scalius/database` is the only runtime provider boundary. D1 is selected when
no external database credentials are present. A Turso deployment requires:

- `DATABASE_PROVIDER=turso`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

A PostgreSQL deployment requires:

- `DATABASE_PROVIDER=postgres`
- `POSTGRES_DATABASE_URL`

An incomplete configuration fails closed. When Turso and PostgreSQL credentials
are both installed, `DATABASE_PROVIDER` is mandatory; `DATABASE_PROVIDER=d1` is
an explicit source/rollback pin while target credentials are staged. A
connection string does not move data and must never trigger an implicit
request-path migration.

Database release compatibility is exact, not a connectivity probe. Migration
`0050_schema_release_contract` starts one ordered ledger shared by D1, TursoDB,
and PostgreSQL. Each release row includes the canonical source digest, and API
`/readyz` rejects missing, extra, renamed, future, or digest-mismatched rows.
`0051_orders_checkout_write_path` is the current release. Historical migrations
are an installed-system contract and must not be deleted or squashed after
release.

D1 continues to use Wrangler's normal migration application. Existing TursoDB
and PostgreSQL databases use the explicit `upgrade:schema` runner. Every
provider-neutral migration has canonical SQLite SQL plus a transaction-safe
PostgreSQL sidecar with the same identity and source digest. TursoDB proves the
semantic legacy baseline before its first ledger release and applies one
migration per immediate transaction. PostgreSQL reuses the initial import's
receipt and advisory-lock identity and applies one sidecar per serializable
transaction. Replays after a committed-but-lost response are safe.

Each D1 request uses one `first-primary` session. Its first operation observes
the primary and later reads may use a consistent replica; routes and services
do not carry provider-specific consistency branches.

Ordinary deploys never upgrade an external database. They run a read-only
`--dry-run --require-current` preflight; an external control-plane operation
must first activate `DATABASE_MIGRATION_FREEZE`, prove the freeze, run the
explicit mutation with that proof digest, and only then deploy the release.
This separation prevents an ordinary redeploy from racing checkout, queue, or
scheduled writes.

Provider capability differences stay behind shared helpers. D1 keeps FTS5,
recursive CTE, and `WITHOUT ROWID` support. TursoDB and PostgreSQL omit or
translate unsupported physical artifacts, while bounded provider-aware
search/navigation helpers preserve the public contract. Atomic domain writes
use the shared commit/transport boundary: TursoDB retries only explicit MVCC
conflicts, and PostgreSQL retries only serialization/deadlock conflicts.

Guarded compare-and-swap batches expose one API: a boolean success predicate
plus an uppercase semantic failure marker. The database package constructs the
SQLite invalid-path sentinel and the PostgreSQL compiler rewrites it to the
typed, volatile `scalius_compat.fail_bigint()` function. Feature code cannot
mix dialect-specific `CASE` result types, and one error classifier preserves
the same domain conflict across D1, TursoDB, and PostgreSQL transports. The
full database/core/API suites and a disposable native Neon branch proved both
the successful and rollback paths on 2026-08-03. Production API Worker version
`5a1be633-eed5-48b9-a2a5-4b170ee3a0b1` then passed four PostgreSQL readiness
samples and the complete read-only release check on the Neon-backed demo.

Administrative credential creation is also one provider-native commit. The
application hashes passwords with Better Auth's implementation, then inserts
the Better Auth user/account rows together with the setup claim or invitation
and optional RBAC role. It deliberately does not call the public Better Auth
sign-up route internally: that route creates an unused session and its
transaction callback falls back to sequential writes on the one-shot proxy
adapters. Local D1 proves end-to-end Better Auth sign-in; local D1 and stateful
TursoDB prove compatible password hashes, duplicate rollback, and setup-claim
rollback; equivalent credential and claim conformance passed on a disposable
native Neon branch on 2026-08-03. D1 batches, Turso atomic batches, and Neon
HTTP one-shot transactions remain the shared boundary.

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

## Deterministic D1 or TursoDB to PostgreSQL protocol

The control plane uses the same frozen canonical SQLite artifact for both
sources and persists every phase as machine-readable evidence:

1. Pin the current provider, activate `DATABASE_MIGRATION_FREEZE` on API and
   admin, and prove ordinary writes are unavailable while health/readiness stay
   observable.
2. For D1, run `export:d1-portable` against the exact unchanged Time Travel
   bookmark. For TursoDB, run `export:turso-portable`; it fences the remote
   revision, checkpoints a Sync copy, rejects sidecar residue, and verifies that
   the source revision did not move during export.
3. Normalize the snapshot to the current canonical application-table and column
   set. Reject schema/nullability drift, row-count drift, non-canonical source
   state, foreign-key violations, or integrity failures before target work.
4. Provision an empty PostgreSQL/Neon database and run
   `migrate:sqlite-to-postgres` with its create-only local checkpoint. The
   migrator takes a PostgreSQL advisory lock, installs the compatibility schema,
   streams each table through `COPY`, and atomically records per-table row/hash
   receipts in a locked control schema.
5. Re-running after termination reconciles the local checkpoint from the target
   receipts, verifies every completed table, and resumes at the first missing
   table. Completion requires exact per-table and whole-database content
   fingerprints, expected schema objects, clean constraints, and the completed
   target receipt.
6. Install `POSTGRES_DATABASE_URL`, keep `DATABASE_PROVIDER` explicit while old
   credentials remain, deploy the immutable release, require repeated
   `postgres` readiness, and run release, authenticated dashboard, storefront,
   checkout/idempotency, inventory-ledger, and cancellation smokes before
   unfreezing.
7. Retain the frozen source for the configured rollback window. After the first
   PostgreSQL write, switching credentials back is not rollback; it requires a
   verified reverse migration/reconciliation or an explicit restore-to-snapshot
   data-loss decision.

## Rollback rule

Before the first target write, rollback is a provider pin and redeploy. After
Turso accepts writes, the retained D1 snapshot is stale. Switching back without
a reverse migration would lose orders, inventory movements, sessions, and other
merchant facts. The control plane must either migrate the Turso delta/full state
back into a verified D1 target or present rollback as a deliberate restore to
the cutover snapshot with an explicit data-loss decision.

## Historical verified D1 to TursoDB cutover — 2026-08-01

The production Scalius demo domains were migrated in place from D1 to TursoDB
for merchant testing. That target later became the frozen source for the
PostgreSQL cutover below; the original D1 database was not modified or destroyed.

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

## Checkout coordinator v2 architecture — 2026-08-03

The live results above measured the earlier one-request/one-checkout path and
must not be used to characterize coordinator v2. Cloudflare documents a soft
limit of 1,000 requests/second for one Durable Object and approximately
200–500 requests/second for complex work. A single per-merchant checkout object
therefore could not be the ingress for an honest thousands-of-orders/second
claim regardless of database capacity. Coordinator v2 removes that structural
ceiling without moving money, inventory, or idempotency authority out of the
selected relational database:

- D1 keeps one deterministic ingress object and one commit object. The commit
  engine remains single-writer and may use both reservation lanes serially.
- TursoDB and PostgreSQL use 16 deterministic ingress objects. The checkout
  request key selects the ingress object, so concurrent duplicates and changed
  payloads for one idempotency key still meet at the same coordinator.
- Each ingress object holds a bounded 25-ms microbatch window, performs one
  shared authority read for that batch, prepares immutable order commands, and
  groups them by the two existing reservation lanes.
- One commit object owns each concurrent-provider lane. It combines incoming
  microbatches, submits exactly one bounded atomic database transaction at a
  time for that lane, and relies on database authority revision, lane-version
  CAS, unique checkout identity, and durable aggregate/outbox rows for recovery.
- An overloaded Durable Object is not retried at the coordinator boundary;
  retry amplification would worsen overload. The API performs its existing
  database replay lookup before returning an uncertain failure.
- Sold-out availability transitions are assigned to exactly the order that
  crosses the inventory boundary, rather than copied to every order in its
  commit batch. Cache invalidation still runs when durable projection owns the
  notification/Meta side effects.

This topology has local end-to-end D1 authority/projection coverage and focused
routing, lane grouping, response-order, overload, replay, and sold-out
invalidation tests. It is an architectural prerequisite, not by itself a
capacity claim. The disposable D1 and full Worker-to-Neon evidence below cover
those provider shapes; current TursoDB concurrent-writer capacity still needs
the same sustainable arrival-rate, p95/p99 latency, overload, projection-lag,
exact order/idempotency, and inventory proof before publishing its throughput.
See Cloudflare's current
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and Turso's [concurrent-write contract](https://docs.turso.tech/tursodb/concurrent-writes/).

## Verified disposable D1 coordinator-v2 load — 2026-08-03

The sentinel-protected D1 target and Worker contained no production resources.
Migration `0051_orders_checkout_write_path` removed one stale legacy customer
index, removed two redundant single-column indexes, made three nullable indexes
partial, and stopped synchronously indexing a coordinated order in FTS before
its durable projection was complete. Projected orders remain searchable; local
behavioral coverage and a live 1,000-order oracle both proved exact FTS
visibility after projection.

- Before the write-path migration, a short 1,000-order run at 250 scheduled
  arrivals/second completed at 157.29 responses/second. The same short shape
  completed at 180.75 after removing the redundant initial FTS/index writes.
- A sustained 5,000-order untracked-SKU run at 250 scheduled arrivals/second
  returned 5,000/5,000 HTTP 201 responses with exact order, item, and checkout
  attempt counts. It completed at 235.32 responses/second with p95 service
  latency 1.506 seconds and projection catch-up in 1.537 seconds.
- After applying and recording release 0051 through normal Wrangler migration
  and deployment, a second 5,000-order run returned 5,000/5,000 HTTP 201,
  completed at 236.87 responses/second, had p95/p99 service latency of
  2.195/2.839 seconds, and projected in 1.767 seconds. Foreign keys remained
  clean and no legacy inventory movement was created.
- One tracked SKU with exactly 5,000 available units received 6,000 submissions
  at 250/second. Exactly 5,000 orders committed and 1,000 were rejected as
  unavailable. Accepted orders completed at 200.86/second; the two reservation
  lanes advanced by exactly 5,000 contiguous version/quantity edges, physical
  stock and `stockVersion` did not drift, and no oversell or duplicate ledger
  edge occurred.
- The final clean-name deployment `aac260ed-6fe1-4bda-910d-0768df2e89c3`
  served 100%, reported `schema 51/0051_orders_checkout_write_path`, and passed
  a fresh 100-way simultaneous replay burst with 100 HTTP 201 responses but
  exactly one order, one item, and one checkout attempt.

These are database/coordinator capacity results with external providers and the
production KV/rate-limit bindings intentionally absent. They prove that this D1
shape can absorb the measured 250-order arrival stream while preserving its
authority invariants; they do not prove thousands of orders/second or every
merchant cart/provider workload.

## Verified live TursoDB to PostgreSQL cutover — 2026-08-03

The production demo was frozen, revision-exported from TursoDB, migrated into a
permanent Neon/PostgreSQL database, redeployed, and left live on PostgreSQL with
the existing merchant data, login, dashboard, storefront, and API domains.

- The canonical snapshot contained 109 application tables and 20,258 rows.
- The source artifact SHA-256 was
  `19b4d1a92c7a9509cf2454832bbcc7e522783bc5dc7e46d8c619d7a183ff9e95`;
  the provider-neutral content fingerprint was
  `6f6c0040dd9c0246a1692eb60882ae099384bf89312847eaf7ee177197153b0a`.
- Migration id
  `a211eb3d0522b3bf5485f172dfece81c4cd1461a98efb9b9043ba2e597469835`
  completed with exact table receipts and an exact second invocation resolved
  from persisted target state.
- PostgreSQL readiness, the retained authenticated dashboard session, the
  storefront catalog, API release checks, and production checkout/inventory
  invariants passed after cutover.
- A disposable production-limit Worker committed 5,000 exact PostgreSQL
  checkout transactions at 1,161–1,426 orders/second in the measured runs with
  no duplicate order or oversell. This is backend-path evidence, not a promise
  that gateways, notifications, arbitrary carts, or every merchant workload
  sustain the same rate.

## Verified full Worker-to-Neon checkout load — 2026-08-03

A sentinel-protected Worker and disposable database on the demo project's
smallest fixed 0.25-CU Neon compute exercised the complete public checkout
route, coordinator, native PostgreSQL commit, durable projection, and direct
database oracle. External gateways and notification consumers remained outside
the measured path.

- Three independent migrations from the same immutable canonical SQLite source
  into three fresh PostgreSQL databases produced identical schema, source, and
  logical-content fingerprints across 110 application tables.
- Idempotency, receipt, support, exact projection, constraint, and tracked-SKU
  concurrency scenarios passed. A 60-request hot-SKU run accepted exactly the
  50 available units, rejected ten as unavailable, and preserved exact lane
  versions/quantities without oversell or legacy inventory movements.
- An initial 2,000-order run exposed a real recovery flaw: every authoritative
  order committed, but a failed oversized projection group could remain pending
  until the scheduled sweep. The live coordinator now shares the scheduled
  recovery policy, bounds groups to 500 orders, isolates failed groups by
  durable outbox, and retries transient single-outbox failures. The pre-fix
  backlog then recovered 35/35 outboxes with zero failed facts.
- After the fix, one 2,000-order spread run at 1,000 scheduled arrivals/second
  returned 2,000/2,000 HTTP 201 responses in 6.080 seconds: 328.95 accepted
  orders/second, p95/p99 service latency 4.784/5.353 seconds, and automatic
  projection catch-up in 5.601 seconds. The oracle found exactly 2,000 orders,
  2,000 items, and 2,000 attempts, no legacy movements, clean PostgreSQL
  constraints, and no violation.
- The database and API suites passed 244 tests (one skipped) and 998 tests
  respectively after the change. Commits `988f25044` and `6296b6843` contain
  the recovery policy and provider-neutral load tooling.

The native backend commit has crossed 1,000 orders/second, while the complete
0.25-CU Worker path has currently proved 329 orders/second. Therefore Scalius
must not publish “PostgreSQL supports 1,000+ complete orders/second” until the
same full-route oracle passes on sized compute or a proven horizontally scaled
merchant topology. Database-tier throughput is a tested deployment profile,
not a universal product adjective such as “enterprise-grade.”
