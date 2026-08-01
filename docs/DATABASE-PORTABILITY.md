# Database Portability and Cutover

Scalius uses one canonical SQLite domain model with two operational tiers:

- Cloudflare D1 is the default starter. It has the lowest provisioning and
  operational complexity and remains suitable for most merchants for a long
  time.
- Turso is the supported concurrent-writer scale tier. It uses the same domain
  schema and application services through the `@scalius/database` adapter.
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

1. Create an isolated target and apply the provider-compiled canonical
   migration chain.
2. Enable `DATABASE_MIGRATION_FREEZE` on every Worker that can write. API health
   and readiness remain available; ordinary API/admin traffic is rejected,
   queues retry, and cron mutation is skipped.
3. Export two complete source snapshots after the freeze has settled. Continue
   only when their SHA-256 digests match.
4. Normalize the trusted export onto the current canonical table/column set.
   Reject missing current tables/columns, unhandled nullability drift, row-count
   drift, foreign-key violations, or a failed integrity check. Record every
   discarded retired column and ignored retired table with its row count.
5. Compile a streaming, mode-0600 Turso import. The import runs in one
   transaction, suspends the exact final trigger set, clears all current tables
   (including migration seed rows), loads the snapshot, and restores triggers
   before commit.
6. Compare deterministic logical schema and table fingerprints between the
   normalized source and target. Require exact table counts, row counts, and
   whole-database fingerprints plus clean `foreign_key_check` and
   `integrity_check` results.
7. Install provider secrets, deploy API and admin, and require repeated Turso
   readiness success before removing the freeze.
8. Exercise public reads, authenticated admin reads, one idempotent checkout,
   order transition, inventory release, queues, storefront rendering, and
   browser hydration. Re-run the production ops and release checks.
9. Retain the frozen D1 source for the configured rollback window. Destroy it
   only through a separate, explicit retention policy.

The normalizer and compiler stream the database through SQLite/files instead of
holding the SQL dump in JavaScript memory. The process is therefore suitable for
a near-limit D1 export; available disk, migration duration, and provider import
limits still need preflight checks.

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
