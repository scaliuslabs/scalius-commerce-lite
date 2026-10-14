# Database portability and cutover

This page covers the three database providers Scalius runs on (Cloudflare D1, TursoDB and PostgreSQL), how the API Worker selects one, and the runbook that moves a live store between them. It is for operators who run a cutover and contributors who touch provider code. [packages/database/README.md](../packages/database/README.md) owns the per-command reference, the migration files and the `migration-plan` contract.

The Workers never provision a database or move data. The operator runs the scripts in `packages/database/scripts` and owns provider accounts, secrets, deploys, health checks and rollback retention.

## Provider tiers

D1 is the default and needs no provisioning. Provider differences stay in shared helpers (see "Rules for provider code").

| | D1 | TursoDB | PostgreSQL |
|---|---|---|---|
| Concurrent writes | no | yes | yes |
| Text search | FTS5 tables | search index (`search_fts_terms`) | search index (`search_fts_terms`) |
| Write retries | none | busy and conflict failures only (8 attempts) | serialization and deadlock failures only |
| Write isolation | D1 batch | `turso://`: concurrent batch. `libsql://` or `https://`: immediate transaction | every write `SERIALIZABLE` |

`getDatabaseProviderCapabilities` in `packages/database/src/provider.ts` holds the full capability rows. Text search gives the same results on every provider (see "Text search"). Each D1 request uses one `first-primary` session (`packages/database/src/client.ts`): the first operation reads the primary, and later reads may use a replica.

## Runtime contract

`resolveDatabaseConfiguration` (`packages/database/src/provider.ts`) picks the provider once per request from the API Worker's environment.

| Provider | Needs | Notes |
|---|---|---|
| D1 | the `DB` binding | Used when no external credential is set, or when `DATABASE_PROVIDER=d1`. |
| TursoDB | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | The URL is `turso://`, `libsql://` or `https://`, without credentials. |
| PostgreSQL | `POSTGRES_DATABASE_URL` or a `HYPERDRIVE` binding | `HYPERDRIVE` wins over the URL. `postgres://` or `postgresql://` only, and it names a database. |

- `DATABASE_PROVIDER` (`d1`, `turso` or `postgres`) pins the provider. Any other value is an error.
- Without a pin, complete Turso credentials select Turso and complete PostgreSQL credentials select PostgreSQL. Both sets together are an error: set `DATABASE_PROVIDER`.
- An incomplete configuration fails closed. A connection string never moves data and never starts a migration.
- A `*.neon.tech` host without Hyperdrive uses the Neon HTTP transport. Any other PostgreSQL host, and Hyperdrive, uses `pg`. Use Hyperdrive for generic PostgreSQL on a production Worker.
- A Hyperdrive configuration must have query caching disabled. By default Hyperdrive caches plain reads for 60 s plus 15 s stale-while-revalidate. Cache validation, idempotency rows and checkout authority are plain reads, so a cached read can serve a stale page for up to 75 s or replay a stale checkout decision. Create the configuration with `wrangler hyperdrive create <name> --connection-string <url> --caching-disabled`, or fix an existing one with `wrangler hyperdrive update <id> --caching-disabled`.
- `GET /api/v1/readyz` proves this for PostgreSQL. It reads a private probe row (`rate_limit`, key `__scalius:readyz:read-freshness`), writes a new random value, and sends the same read again. If the second read returns the old value, `checks.postgres` is `error` and readiness answers 503. During `DATABASE_MIGRATION_FREEZE` the probe does not write, and the detail says that freshness is unchecked (`packages/database/src/read-freshness.ts`).
- These names are API Worker secrets or bindings, not Wrangler `vars`. The storefront Worker has no database.

## Text search

Every search read (storefront and site search, listings, the dashboard lists of products, orders, customers, categories, pages, reviews, navigation and abandoned checkouts) goes through `@scalius/core/search`. A query word matches every token it starts, all words are required, and results rank by FTS5's bm25. The providers return the same rows in the same order (`packages/core/src/search/search-parity.test.ts`).

- D1 matches its FTS5 tables (`<source>_fts`, migrations 0000 to 0128). Nothing changed for D1.
- TursoDB and PostgreSQL match `search_fts_terms` (migration 0152, `packages/database/src/search-index.ts`): one row per distinct term of each indexed column with its count, and one row per source row with its token count. Generated triggers maintain it from the same columns as the FTS5 tables: a staged `replace()` chain on SQLite (TursoDB parses an expression at most 100 levels deep) and one `translate()` pass on PostgreSQL. A query word is one range of the `(source, term, col, doc_id, tf)` index; the bm25 formula runs over the same counts as FTS5, so scores are equal.
- TursoDB's own FTS index (`USING fts`) is not used: it needs an experimental flag, and it has no single-term prefix query (`shir*` finds nothing).
- An import that bypasses triggers rebuilds the index (`searchIndexRebuildStatements`): the TursoDB data-export envelope, the D1 export normalizer and PostgreSQL's post-data phase.

Differences from FTS5, by design:

- Case and accents fold for ASCII and Latin-1 letters only (FTS5 folds every script). The listed Unicode spaces, punctuation and joiners split words (`SEARCH_FOLD_MAP`); other symbols, such as emoji, stay inside a term, so a prefix still finds the word before them.
- A term keeps its first 100 characters.
- A query word that a separator splits (`ord_c`, `t’shirt`) is an FTS5 phrase. The index requires its terms in one column, without their adjacency, and scores each term as its own phrase.
- `product_variants_fts` and `abandoned_checkouts_fts` keep FTS5's default tokenizer, which splits Bangla words at their vowel signs. The index keeps those words whole.

## Release ledger and schema upgrades

Migration `0050_schema_release_contract` starts one ordered ledger, `scalius_schema_migrations`, shared by all providers. Every later migration ends with its own ledger row: version, name and the sha256 of its source file.

- `GET /api/v1/readyz` compares the whole ledger with `CURRENT_DATABASE_SCHEMA_MIGRATIONS` (`packages/database/src/schema-contract.ts`). It answers 503 for a missing, extra, renamed, future or digest-mismatched row.
- Never delete or squash a released migration. Every migration from 0050 onward has canonical SQLite SQL in `packages/database/migrations/` and a PostgreSQL sidecar with the same file name in `migrations/postgres/`. `pnpm --filter @scalius/database check:migrations` checks them.

| Provider | How the schema upgrades |
|---|---|
| D1 | `wrangler d1 migrations apply`. `pnpm run deploy` runs it. |
| TursoDB | `upgrade:schema --provider turso`. One immediate transaction per migration. |
| PostgreSQL | `upgrade:schema --provider postgres`. One serializable transaction per sidecar. A replay after a lost response is safe. |

`upgrade:schema` reads the target from `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, or from `POSTGRES_DATABASE_URL`. It prints a JSON receipt.

```bash
# Read-only check. Exits non-zero unless the schema is current.
pnpm --filter @scalius/database upgrade:schema --provider postgres \
  --acknowledge-target-host <host> --dry-run --require-current

# Mutation. Needs a 64-hex freeze proof, which the runner records in its receipt.
pnpm --filter @scalius/database upgrade:schema --provider postgres \
  --acknowledge-target-host <host> --freeze-proof-sha256 <digest>
```

- `--acknowledge-target-host` must equal the host of the connection URL.
- `--freeze-proof-sha256` is rejected with `--dry-run`. The runner checks the format only. The operator proves the freeze.
- An ordinary deploy never upgrades an external database. `pnpm run deploy` reads the provider from `vars.DATABASE_PROVIDER` of the Wrangler config. A config with a D1 binding and no such var means D1: the script runs `wrangler d1 migrations apply` against that D1 database, whatever the Worker secrets select.
- For Turso or PostgreSQL, deploy with `--only api --wrangler-config <path>` (that config sets `vars.DATABASE_PROVIDER`) and `--database-target-host <host>`. The script then runs the read-only check above before it deploys.

## Write freeze

`DATABASE_MIGRATION_FREEZE` on the API Worker (`1`, `true` or `on`) stops all writes while an operator copies the database. The API Worker is the only Worker that writes to the database.

- A request gets 503 `DATABASE_MIGRATION_IN_PROGRESS` with `Retry-After: 60`. Only `GET` and `HEAD` of `/api/v1/health`, `/api/v1/readyz` and `/api/v1/meta` pass.
- The cron run does nothing. Background rows that are due wait in the database and run after the freeze ends.

## Cutover: D1 to TursoDB

Persist a record of each step. Do not skip a gate.

1. Pin the source: set `DATABASE_PROVIDER=d1` on the API Worker before you install any Turso credential. Without the pin, Turso credentials switch the provider at once.
   Gate: `GET /api/v1/readyz` shows `checks.d1.status` as `ok`.
2. Set `DATABASE_MIGRATION_FREEZE=1` on the API Worker. Wait for in-flight requests to finish.
   Gate: an API write answers 503 `DATABASE_MIGRATION_IN_PROGRESS`, and `/api/v1/readyz` still answers.
3. Read the D1 Time Travel bookmark and persist it.
   ```bash
   pnpm --dir apps/api exec wrangler d1 time-travel info <d1-database> --json
   ```
4. Export the D1 database, fenced by that bookmark. The `--out` directory must not exist.
   ```bash
   pnpm --filter @scalius/database export:d1-portable \
     --database <d1-database> --out <export-dir> --expected-bookmark <bookmark>
   ```
   Gate: exit 0 (`source.sql` and `export-evidence.json` written). The command fails when the live bookmark differs before the export or changes during it.
5. Normalize the export into a Turso upload bundle. It needs the `sqlite3` binary (`SQLITE3_BIN` or `--sqlite-binary`) and free disk of 3 times the export plus 2 GiB.
   ```bash
   pnpm --filter @scalius/database prepare:turso-upload \
     --export-bundle <export-dir> --out <bundle-dir>
   ```
   Gate: the summary shows `integrity: "ok"`, `foreignKeyViolations: 0` and `journalMode: "mvcc"`.
6. Provision a Turso database and upload the bundle from a secured host. Set `TURSO_PLATFORM_API_TOKEN` first.
   ```bash
   pnpm --filter @scalius/database provision-upload:turso \
     --bundle <bundle-dir> --organization <org> --group <group> --database <name>
   ```
   Gate: the command checks the organization's storage quota first (it needs `--allow-storage-overage` for a billable upload), then verifies the remote journal mode, the schema and data fingerprint, the row counts, `foreign_key_check` and `integrity_check`. It rotates the temporary tokens and writes its receipts into the bundle directory. A repeat run resumes from the receipts.
7. Check the target schema. Use the provision receipt's hostname.
   ```bash
   TURSO_DATABASE_URL=turso://<host> TURSO_AUTH_TOKEN=<token> \
     pnpm --filter @scalius/database upgrade:schema --provider turso \
     --acknowledge-target-host <host> --dry-run --require-current
   ```
   Gate: exit code 0.
8. Install `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `DATABASE_PROVIDER=turso` on the API Worker. Use a `turso://` URL for concurrent batches.
9. Deploy the API Worker with the freeze still on (flags: "Release ledger and schema upgrades").
   Gate: the deploy script's schema check passes and its `/readyz` samples are ready.
10. Sample readiness again: `pnpm ops:check --api-base-url <api-origin>`.
    Gate: every sample is ready, and `GET /api/v1/readyz` shows `checks.turso.status` as `ok`.
11. Remove `DATABASE_MIGRATION_FREEZE`. Then smoke-test public reads, an authenticated admin read, one idempotent checkout, an order transition, an inventory release, a notification sent by the cron drain, storefront rendering and browser hydration.
    Gate: `pnpm ops:check --api-base-url <api-origin>` passes.
    Gate: `pnpm release:check --api-base-url <api-origin> --storefront-url <store-origin> --dashboard-url <dashboard-url>` passes. Both commands default to the Scalius demo hosts.
12. Keep the frozen D1 database for the rollback window. Destroy it only under a separate, explicit retention decision.

Never use `turso db create --from-file ... --tursodb` for a cutover: a 2026-08-05 rehearsal reported success but created a target that held only Turso's internal MVCC table. Use `prepare:turso-upload` and `provision-upload:turso`, and require the exact remote fingerprints.

## Cutover: D1 or TursoDB to PostgreSQL

Both sources feed `migrate:sqlite-to-postgres` with one standalone canonical SQLite file.

1. Pin the source provider (`DATABASE_PROVIDER=d1` or `turso`) before you install a PostgreSQL credential.
   Gate: `GET /api/v1/readyz` shows the source provider's check (`checks.d1` or `checks.turso`) as `ok`.
2. Freeze writes as in step 2 of the Turso cutover.
3. Export the frozen source.
   - D1: run steps 3 and 4 of the Turso cutover.
   - TursoDB, current engine: run `turso db export <database> --output-file <snapshot>` under the freeze. Then run the command below with `TURSO_DATABASE_URL` set.
   - TursoDB, legacy SQLite-backed: omit `--snapshot` and `--snapshot-revision`. The command then pulls through Turso Sync until two pulls match, and needs `TURSO_AUTH_TOKEN`.
   ```bash
   pnpm --filter @scalius/database export:turso-portable --out <export-dir> \
     --ack-source-host <host> --snapshot <snapshot> --snapshot-revision <freeze-proof>
   ```
   Gate: for a Turso source, the command writes `source.sqlite3` (ordinary SQLite, normalized) and `export-evidence.json`.
4. Get one standalone canonical SQLite file. For a Turso source, use `source.sqlite3` from step 3. For a D1 source, no package script writes this file (unverified: the migration orchestrator owns it). The function `normalizeD1ExportToTursoDatabase` in `packages/database/scripts/normalize-d1-export-core.ts` builds it.
   Gate: the file has no `-wal`, `-shm` or `-journal` sidecar, passes `integrity_check` and `foreign_key_check`, and holds exactly the canonical application tables.
5. Provision an empty PostgreSQL or Neon database. It must have no public tables or triggers.
6. Run the migrator.
   ```bash
   POSTGRES_DATABASE_URL=<target-url> pnpm --filter @scalius/database \
     migrate:sqlite-to-postgres --sqlite <canonical.sqlite> \
     --checkpoint <checkpoint.json> --ack-target-host <host>
   ```
   Gate: the migrator copies each table with `COPY` under an advisory lock and records per-table receipts in the `_scalius_migration` schema. It completes only when the per-table and whole-database content fingerprints match and the schema objects and constraints are clean. After a crash, run the same command again: it resumes at the first missing table.
7. Install `POSTGRES_DATABASE_URL`, or bind `HYPERDRIVE`, on the API Worker. A Hyperdrive configuration must use `--caching-disabled` (see "Runtime contract"). Then set `DATABASE_PROVIDER=postgres`.
8. Finish as in steps 9 to 12 of the Turso cutover: deploy with the freeze on, sample readiness (`GET /api/v1/readyz` shows `checks.postgres.status` as `ok`), remove the freeze, sample readiness again (the detail must end with `reads uncached`), run the smoke tests (add an inventory-ledger check and an order cancellation) and keep the frozen source for the rollback window.

## Rollback

Before the target accepts its first write, roll back by setting `DATABASE_PROVIDER` back to the source provider and redeploying. The frozen source is still current.

After the target accepts a write, the retained source is stale. Switching credentials back loses orders, inventory movements, sessions and other merchant facts. Do one of these:

- Migrate the target's data back into a verified source database, with the same freeze and fingerprint gates.
- Restore the cutover snapshot as a deliberate decision to lose the later data.

## Tools for rehearsal and load

These scripts run through `pnpm --filter @scalius/database <name>` against disposable databases. The README documents their options: `rehearse:near-limit` (a synthetic D1-shaped export of a given size, prepared into a Turso bundle; local only), `verify:portability-export`, `prepare:checkout-load-target`, `seed:checkout-load-target`, `add:checkout-load-hot-fixture`, `load:checkout-live` (the full checkout route against a disposable API Worker) and `probe:turso-concurrency`.

Rules for a capacity claim:

- A conflict test proves adapter correctness. It is not a throughput figure.
- A claim needs a disposable, fully migrated store, load through the Worker origin, realistic SKU contention, stubbed providers, background drain times, latency percentiles, and explicit error, oversell and duplicate-order targets.
- Do not publish "supports N orders per second" for a provider tier until `load:checkout-live` passes on that tier. In 2026-08 rehearsals (unverified here) only PostgreSQL passed a sustained full-route load.
- Hosted Turso load spends organization-wide row quotas. Use a separate test organization.

## Rules for provider code

- Keep provider differences in the shared helpers of `@scalius/database`. Do not add provider branches to routes or domains.
- Write a guarded compare-and-swap batch with `buildBatchGuard` and `isBatchGuardError` (`packages/database/src/batch-helper.ts`): a boolean predicate and an uppercase failure marker. Never write a dialect-specific `CASE` result type.
- The portable SQLite fingerprint (`packages/database/src/portability.ts`) reads tables one at a time and runs at most three metadata PRAGMAs for one table at once. Do not restore an all-table `Promise.all`: it can exceed D1's six simultaneous connections.
- Create an administrator only through the guarded batch in `packages/core/src/auth/credential-account.ts`, never the Better Auth sign-up route (see [the auth README](../packages/core/src/auth/README.md)).
- Use `json_valid()` and `EXISTS` as predicates. SQLite answers 0 or 1; PostgreSQL answers boolean, and it has no `boolean = integer` operator and cannot type a `CASE` that returns `EXISTS (...)` beside a number. Write `WHEN json_valid(x) THEN`, `WHEN NOT json_valid(x)` and `THEN CASE WHEN EXISTS (...) THEN 1 ELSE 0 END`. `packages/core/src/sql-portability.test.ts` fails on a compared `json_valid()` and on an `EXISTS` CASE result in the core, API, database and shared sources.
- Write an upsert's conflict target as the Drizzle column (`onConflictDoUpdate({ target: table.column })`). Drizzle renders it as `"table"."column"`, SQLite accepts that, and the PostgreSQL statement compiler (`compileSqliteConflictTargets()` in `packages/database/src/postgres-sqlite-profile.ts`) strips the qualifier, which PostgreSQL refuses. Do not write an `sql.identifier()` target for it.
- A native PostgreSQL test (`*.postgres-native.test.ts`) gets its database from `createNativePostgres()` in `@scalius/database/testing/postgres-native`: a fresh database from the canonical schema plus the rows migrations seed (the clock row, the default inventory location, the backup market and the rest, read from a pristine migrated SQLite database). Never create a schema or insert a migration seed row in the test, and call `closeNativePostgres()` from `afterAll`.
