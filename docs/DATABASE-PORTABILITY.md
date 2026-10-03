# Database portability and cutover

This page covers the three database providers that Scalius runs on (Cloudflare D1, TursoDB and PostgreSQL), how the API Worker selects one, and the runbook that moves a live store between them. It is for operators who run a cutover and contributors who touch provider code. [packages/database/README.md](../packages/database/README.md) owns the per-command reference, the migration files and the `migration-plan` contract.

The Workers never provision a database or move data. The operator runs the scripts in `packages/database/scripts` and owns provider accounts, secrets, deploys, health checks, rollback retention and the retirement of the source database.

## Provider tiers

All three providers serve one commerce model. Provider differences stay in shared helpers (see "Rules for provider code").

| | D1 | TursoDB | PostgreSQL |
|---|---|---|---|
| Role | Default. No provisioning. | Concurrent-writer SQLite. | Native PostgreSQL transactions. |
| Concurrent writes | no | yes | yes |
| FTS5 | yes | no | no |
| Recursive CTE | yes | no | yes |
| `WITHOUT ROWID` | yes | no | no |
| Write retries | none | busy and conflict failures only (8 attempts) | serialization and deadlock failures only |
| Write isolation | D1 batch | `turso://`: concurrent batch. `libsql://` or `https://`: immediate transaction | every write `SERIALIZABLE` |

`getDatabaseProviderCapabilities` in `packages/database/src/provider.ts` holds the capability rows. Where a provider lacks FTS5, search takes a bounded `instr()` fallback (`packages/core/src/search/fts5.ts`).

Each D1 request uses one `first-primary` session (`packages/database/src/client.ts`): the first operation reads the primary, and later reads may use a replica.

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
- A `*.neon.tech` host without Hyperdrive uses the Neon HTTP transport. Any other PostgreSQL host, and Hyperdrive, uses `pg`. For generic PostgreSQL on a production Worker, use Hyperdrive.
- These names are API Worker secrets or bindings, not Wrangler `vars`. The committed configs carry no `vars`. The storefront Worker has no database.

## Release ledger and schema upgrades

Migration `0050_schema_release_contract` starts one ordered ledger, `scalius_schema_migrations`, shared by all providers. Every later migration ends with its own ledger row: version, name and the sha256 of its source file.

- `GET /api/v1/readyz` compares the whole ledger with `CURRENT_DATABASE_SCHEMA_MIGRATIONS` (`packages/database/src/schema-contract.ts`). It answers 503 for a missing, extra, renamed, future or digest-mismatched row. The database check is named after the provider and reports `schema <version>/<name>`.
- `CURRENT_DATABASE_SCHEMA` in the same file names the current release.
- Never delete or squash a released migration. Every migration from 0050 onward has canonical SQLite SQL in `packages/database/migrations/` and a PostgreSQL sidecar with the same file name in `migrations/postgres/`. `pnpm --filter @scalius/database check:migrations` checks the metadata.

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
- `--freeze-proof-sha256` is rejected with `--dry-run`. The runner checks the format only. The operator proves the freeze (see below).
- An ordinary deploy never upgrades an external database. `pnpm run deploy` reads the provider from `vars.DATABASE_PROVIDER` of the Wrangler config. A config with a D1 binding and no such var means D1, and the script then runs `wrangler d1 migrations apply` against that D1 database, whatever the Worker secrets select.
- For Turso or PostgreSQL, deploy with `--only api --wrangler-config <path>`, where that config sets `vars.DATABASE_PROVIDER`. Pass `--database-target-host <host>`. The script then runs the read-only check above before it deploys.

## Write freeze

`DATABASE_MIGRATION_FREEZE` on the API Worker (`1`, `true` or `on`) stops all writes while an operator copies the database.

- A request gets 503 `DATABASE_MIGRATION_IN_PROGRESS` with `Retry-After: 60`. Only `GET` and `HEAD` of `/api/v1/health`, `/api/v1/readyz` and `/api/v1/meta` pass.
- Queue batches retry with a 60 second delay. The cron run does nothing.
- The freeze applies to the API Worker only. It serves the dashboard and the API, and it is the only Worker that writes to the database.

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
   Gate: the command exits 0. It fails when the live bookmark differs before the export, or changes during it. It writes `source.sql` and `export-evidence.json`.
5. Normalize the export into a Turso upload bundle. The command needs the `sqlite3` binary (`SQLITE3_BIN` or `--sqlite-binary`) and free disk of 3 times the export plus 2 GiB.
   ```bash
   pnpm --filter @scalius/database prepare:turso-upload \
     --export-bundle <export-dir> --out <bundle-dir>
   ```
   Gate: the summary shows `integrity: "ok"`, `foreignKeyViolations: 0` and `journalMode: "mvcc"`. The evidence lists every discarded retired column and archived retired table.
6. Provision a Turso database and upload the bundle from a secured host. Set `TURSO_PLATFORM_API_TOKEN` first.
   ```bash
   pnpm --filter @scalius/database provision-upload:turso \
     --bundle <bundle-dir> --organization <org> --group <group> --database <name>
   ```
   Gate: the command checks the organization's storage quota before it creates anything. It refuses an upload that exceeds the quota when overages are off. It needs `--allow-storage-overage` for a billable upload.
   Gate: it verifies the remote journal mode, the schema and data fingerprint, the table and row counts, `foreign_key_check` and `integrity_check`.
   Gate: it rotates the temporary tokens. It writes `provision-receipt.json`, `upload-receipt.json` and `platform-upload-receipt.json` into the bundle directory.
   A repeat run resumes from the receipts.
7. Check the target schema. Use the provision receipt's hostname.
   ```bash
   TURSO_DATABASE_URL=turso://<host> TURSO_AUTH_TOKEN=<token> \
     pnpm --filter @scalius/database upgrade:schema --provider turso \
     --acknowledge-target-host <host> --dry-run --require-current
   ```
   Gate: exit code 0.
8. Install `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `DATABASE_PROVIDER=turso` on the API Worker. Use a `turso://` URL for concurrent batches.
9. Deploy the API Worker with the freeze still on (see "Release ledger and schema upgrades" for the flags).
   Gate: the deploy script's schema check passes and its `/readyz` samples are ready.
10. Sample readiness again: `pnpm ops:check --api-base-url <api-origin>`.
    Gate: every sample is ready, and `GET /api/v1/readyz` shows `checks.turso.status` as `ok`.
11. Remove `DATABASE_MIGRATION_FREEZE`. Then smoke-test public reads, an authenticated admin read, one idempotent checkout, an order transition, an inventory release, queues, storefront rendering and browser hydration.
    Gate: `pnpm ops:check --queues --api-base-url <api-origin>` passes.
    Gate: `pnpm release:check --api-base-url <api-origin> --storefront-url <store-origin> --dashboard-url <dashboard-url>` passes. Both commands default to the Scalius demo hosts.
12. Keep the frozen D1 database for the rollback window. Destroy it only under a separate, explicit retention decision.

Rule (recorded from a 2026-08-05 rehearsal; not testable in this repository): do not use `turso db create --from-file ... --tursodb` for a cutover. It reported success but created a target that held only Turso's internal MVCC table. Use `prepare:turso-upload` and `provision-upload:turso`, and require the exact remote fingerprints.

## Cutover: D1 or TursoDB to PostgreSQL

Both sources feed `migrate:sqlite-to-postgres` with one standalone canonical SQLite file.

1. Pin the source provider (`DATABASE_PROVIDER=d1` or `turso`). Do this before you install a PostgreSQL credential.
   Gate: `GET /api/v1/readyz` shows the source provider's check (`checks.d1` or `checks.turso`) as `ok`.
2. Set `DATABASE_MIGRATION_FREEZE=1` on the API Worker. Meet the same gate as step 2 of the Turso cutover.
3. Export the frozen source.
   - D1: run steps 3 and 4 of the Turso cutover.
   - TursoDB, current engine: run `turso db export <database> --output-file <snapshot>` under the freeze. Then run the command below with `TURSO_DATABASE_URL` set.
   - TursoDB, legacy SQLite-backed: omit `--snapshot` and `--snapshot-revision`. The command then pulls through Turso Sync until two pulls match, and needs `TURSO_AUTH_TOKEN`.
   ```bash
   pnpm --filter @scalius/database export:turso-portable --out <export-dir> \
     --ack-source-host <host> --snapshot <snapshot> --snapshot-revision <freeze-proof>
   ```
   Gate: for a Turso source, the command writes `source.sqlite3` (ordinary SQLite, normalized) and `export-evidence.json`, and the evidence records the acquisition mode.
4. Get one standalone canonical SQLite file. For a Turso source, use `source.sqlite3` from step 3. For a D1 source, no package script writes this file (unverified: the migration orchestrator owns it). The function `normalizeD1ExportToTursoDatabase` in `packages/database/scripts/normalize-d1-export-core.ts` builds it.
   Gate: the file has no `-wal`, `-shm` or `-journal` sidecar, passes `integrity_check` and `foreign_key_check`, and holds exactly the canonical application tables.
5. Provision an empty PostgreSQL or Neon database. It must have no public tables or triggers.
6. Run the migrator.
   ```bash
   POSTGRES_DATABASE_URL=<target-url> pnpm --filter @scalius/database \
     migrate:sqlite-to-postgres --sqlite <canonical.sqlite> \
     --checkpoint <checkpoint.json> --ack-target-host <host>
   ```
   Gate: the migrator takes an advisory lock and copies each table with `COPY`. It records per-table row and hash receipts in the `_scalius_migration` schema.
   Gate: it completes only when the per-table and whole-database content fingerprints match, and the schema objects and constraints are clean.
   Gate: after a crash, run the same command again. It reconciles the checkpoint with the target receipts and resumes at the first missing table.
7. Install `POSTGRES_DATABASE_URL`, or bind `HYPERDRIVE`, on the API Worker. Then set `DATABASE_PROVIDER=postgres`. Turso and PostgreSQL credentials together are an error without a pin.
8. Deploy the API Worker with the freeze still on.
   Gate: the deploy script's schema check passes and its `/readyz` samples are ready.
9. Sample readiness again: `pnpm ops:check --api-base-url <api-origin>`.
   Gate: every sample is ready, and `GET /api/v1/readyz` shows `checks.postgres.status` as `ok`.
10. Remove the freeze. Run the smoke tests of step 11 of the Turso cutover, plus an inventory-ledger check and an order cancellation.
11. Keep the frozen source for the rollback window.

## Rollback

Before the target accepts its first write, roll back by setting `DATABASE_PROVIDER` back to the source provider and redeploying. The frozen source is still current.

After the target accepts a write, the retained source is stale. Switching credentials back loses orders, inventory movements, sessions and other merchant facts. Do one of these:

- Migrate the target's data back into a verified source database, with the same freeze and fingerprint gates.
- Restore the cutover snapshot as a deliberate decision to lose the later data.

## Tools for rehearsal and load

All tools run from `packages/database/scripts` through `pnpm --filter @scalius/database <name>`. The README documents their options.

| Script | Purpose |
|---|---|
| `rehearse:near-limit --out <dir> --target <size>` | Builds a synthetic D1-shaped export of the given size and prepares a Turso bundle from it. Local only. |
| `verify:portability-export --source-export <sql>` | Compares an export with a disposable Turso database (`SCALIUS_TEST_DATABASE_NAME`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`). |
| `prepare:checkout-load-target`, `seed:checkout-load-target`, `add:checkout-load-hot-fixture` | Prepare a disposable load-test database. |
| `load:checkout-live` | Runs the full checkout route against a disposable API Worker and database. |
| `probe:turso-concurrency` | Writes concurrent transactions to a disposable Turso database. |

Rules for a capacity claim:

- A conflict test proves adapter correctness. It is not a throughput figure.
- A claim needs a disposable, fully migrated store, load through the Worker origin, realistic SKU contention, stubbed providers, queue drain times, latency percentiles, and explicit error, oversell and duplicate-order targets.
- Do not publish "supports N orders per second" for a provider tier until `load:checkout-live` passes on that tier.
- Hosted Turso load spends organization-wide row quotas. Use a separate test organization.

Recorded position (2026-08 rehearsals; unverified here, and measured before the single checkout commit): D1 is the default, PostgreSQL is the only tier that passed a sustained full-route load, and a hosted TursoDB database measured between 1.3 and 4.4 transactions per second. Turso stays a supported adapter and is not offered as a scale tier until it passes the same load.

## Rules for provider code

- Keep provider differences in the shared helpers of `@scalius/database`. Do not add provider branches to routes or domains.
- Write a guarded compare-and-swap batch with `buildBatchGuard` and `isBatchGuardError` (`packages/database/src/batch-helper.ts`). It takes a boolean predicate and an uppercase failure marker. The PostgreSQL compiler rewrites the SQLite sentinel to `scalius_compat.fail_bigint()`. Never write a dialect-specific `CASE` result type.
- The portable SQLite fingerprint (`packages/database/src/portability.ts`) reads tables one at a time and runs at most three metadata PRAGMAs for one table at once. Do not restore an all-table `Promise.all`: it can exceed D1's six simultaneous connections.
- Create an administrator with the guarded provider batch in `packages/core/src/auth/credential-account.ts`. Do not call the Better Auth sign-up route: its transaction falls back to sequential writes on the one-shot proxy adapters.
