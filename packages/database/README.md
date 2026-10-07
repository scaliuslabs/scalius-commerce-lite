# @scalius/database

The Drizzle schema, the request-safe client and the migration tools for Cloudflare D1, TursoDB and PostgreSQL. D1 is the zero-configuration default. This page is for contributors who change the schema or provider support. To move a store between providers, follow [DATABASE-PORTABILITY.md](../../docs/DATABASE-PORTABILITY.md).

## Exports

Import by subpath only. The package has no root export, and a source policy rejects a root import. The map is `exports` in `package.json`:

| Import | Use |
|--------|-----|
| `@scalius/database/schema` | Tables, enums and row types (`src/schema/index.ts`) |
| `@scalius/database/client` | `getDb`, `schema`, `safeBatch`, `buildBatchGuard`, chunk helpers, provider helpers |
| `@scalius/database/types` | The `Database` type |
| `@scalius/database/postgres-adapter` | The PostgreSQL compatibility adapter |
| `@scalius/database/read-observer` | Reports the tables each statement touches (used by DVC) |
| `@scalius/database/migration-artifacts`, `migration-plan`, `schema-contract`, `portability` | Provider migration bundles, the D1 migration plan, the release identity and ledger reader, schema and data fingerprints |
| `@scalius/database/testing/sqlite-d1` | Test doubles over `node:sqlite` |

```ts
import { products, orders } from "@scalius/database/schema";
import { getDb, safeBatch, type Database } from "@scalius/database/client";
```

## Client and providers

`getDb(env)` builds a new client for the current request or Worker event. It never stores the binding in module state. All providers return one `Database` type (`DrizzleD1Database<typeof schema>`).

| Provider | Transport |
|----------|-----------|
| D1 | `drizzle-orm/d1` over `env.DB`. When the binding offers sessions, each request uses one `first-primary` session: the first read observes the primary and later reads may use a replica. |
| TursoDB | Fetch-only `@tursodatabase/serverless`. A `turso://` URL selects concurrent atomic batches. `libsql://` and `https://` URLs keep immediate transactions. |
| PostgreSQL | A `*.neon.tech` URL uses Neon's one-shot HTTP transport. Other URLs and `HYPERDRIVE` use native `pg`. Native operations own and close their client. |

Selection (`resolveDatabaseConfiguration()` in `src/provider.ts`) fails closed:

1. `DATABASE_PROVIDER` must be `d1`, `turso` or `postgres` when set. Any other value throws.
2. `turso` needs both `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. The URL must use `https:`, `libsql:` or `turso:` and carry no credentials.
3. `postgres` needs `HYPERDRIVE` or `POSTGRES_DATABASE_URL`. `HYPERDRIVE` wins when both exist. The URL must use `postgres:` or `postgresql:` and name a database. A Hyperdrive configuration must have query caching disabled (`--caching-disabled`); `/api/v1/readyz` fails when a read is cached (`src/read-freshness.ts`).
4. `d1` needs `env.DB` and ignores external credentials. Use it to roll back while target credentials stay installed.
5. Without `DATABASE_PROVIDER`: Turso and PostgreSQL credentials together throw. PostgreSQL credentials select PostgreSQL. Any Turso credential selects Turso and needs both. Otherwise `env.DB` selects D1.

Capabilities (`getDatabaseProviderCapabilities()`):

| Provider | Concurrent writes | FTS5 | Recursive CTE | `WITHOUT ROWID` |
|----------|-------------------|------|---------------|-----------------|
| D1 | No | Yes | Yes | Yes |
| TursoDB | Yes | No | No | No |
| PostgreSQL | Yes | No | Yes | No |

Provider-aware helpers supply bounded alternatives where a feature is missing (for example `@scalius/core/search`). Do not add provider checks to domain code. Migration and cutover work never runs on a request path.

For a cutover, an operator sets the `DATABASE_MIGRATION_FREEZE` secret to `1`, `true` or `on`. The API Worker then answers ordinary requests with 503, retries queue messages and skips scheduled mutations. The health, readiness and meta probes stay available.

### Atomic batches

- `safeBatch(db, statements)` runs the statements as one atomic batch on every provider.
- `buildBatchGuard(db, condition, MARKER)` adds a guard statement. The batch fails with `MARKER` when the condition is false. `isBatchGuardError(error, MARKER)` recognizes the failure on every provider. A marker is an uppercase identifier.
- D1 allows 100 bound parameters per statement. `D1_ID_CHUNK_SIZE` is 90. Use `chunkForD1()` for id lists and `chunkRowsForD1()` for multi-row inserts.

## Conventions

- **Timestamps** are `integer(..., { mode: "timestamp" })` columns holding Unix epoch seconds. The default is `UNIX_NOW` (`src/schema/shared.ts`). Soft delete uses a nullable `deleted_at`. Orders use `archived_at` and are never hard-deleted.
- **Money** is an integer `*_minor` column in minor units. Rates are basis points (`discount_bps`, `rate_bps`).
- **Concurrency**: a `revision`, `version`, `aggregate_revision` or `stock_version` column is a compare-and-swap counter. Writers read it and update `WHERE` it still matches.
- **Entity ids** are text primary keys. Code generates `<prefix>_<nanoid>` for most tables (`prod_`, `var_` for SKUs, `cat_`, `brd_`, `cust_`, `media_`, `page_`, `rev_`, `gc_` and so on). The Better Auth tables use Better Auth's own ids. An event outbox row is `evt_` + milliseconds + 12 hex characters. An article is a `page_` row with `content_type = 'article'`.
- **Order ids** come from `generateOrderId()` (`@scalius/shared/order-utils`): 16 Crockford base32 characters. Older six-character ids stay valid. `orders.order_number` is a separate unique sequence that starts at 1001.
- **JSON columns** are `text()` columns, some with a `json_valid` check. The owning domain validates their shape.
- **Enums** are `const` objects with derived union types in `src/schema/enums.ts`. `orders.payment_method` and `delivery_providers.type` are plain text because they can also hold an app provider id (`<plugin id>:<provider id>`).

## Schema map

The schema files in `src/schema/` are the source of truth for columns. There is one file per area (`orders.ts`, `inventory.ts`, `products.ts`, `system.ts` and so on), and `index.ts` re-exports them. Each domain README lists the tables its domain owns. `system.ts` holds the release ledger, `settings`, `checkout_authority`, the cache clock and dependency tables, the theme tables, analytics and checkout languages.

Single tables with rules:

- `settings` holds typed settings documents. `category` is the document key, `key` is `'document'`, `value` is JSON and `revision` is the compare-and-swap counter. Fraud-checker provider rows and `notification_provider_health` markers also live here. Each domain declares its documents (see [ARCHITECTURE.md](../../docs/ARCHITECTURE.md), "Settings documents").
- `theme_settings` holds the published storefront theme (the JSON document is in its `colors` column). `theme_settings_drafts` holds the one shared draft, `theme_settings_versions` the immutable publish snapshots, and `theme_preview_sessions` the hashed preview tokens.
- `checkout_authority` is a one-row fence. Triggers advance its `revision` on every change to a fact that affects checkout prices or eligibility. The checkout commit batch asserts the revision it priced against.
- `cache_generation` is a legacy singleton. Nothing in the application reads or writes it.
- `order_holds` holds one row per order and app: an app's `order.risk` answer can hold fulfilment until staff release it.

## Database-enforced invariants

Constraints, triggers and indexes protect these rules. Do not work around them in code.

| Area | Rule |
|------|------|
| SKU identity | SKU and barcode are unique on `lower(trim(...))` across all products. Active option identity is unique per product (`product_variants_active_option_identity_uidx`). A product has at most one live default SKU (`product_variants_one_default_per_product_idx`). |
| Variant image | `product_variants.image_id` is nullable and references `product_media.id` (`ON DELETE SET NULL`). `NULL` means the product's primary image. |
| Product media | A product has unique media ids and sort orders, and at most one primary image (`product_media_one_primary_uidx`). |
| Categories | Write only `parent_id`. Triggers keep `depth` (0-3), `path` and `category_closure` exact and refuse cycles, trashed parents and a fifth level. |
| Orders | `orders.version` is a CAS counter. `channel` never changes after insert (`orders_channel_immutable`). `order_payments` is unique on `(payment_method, provider_ref)` where `provider_ref` is not null. `orders.currency_code` is the presentment currency; `shop_currency`, `fx_rate` (decimal string), `fx_source`, `fx_as_of`, `fx_locked_until` and the `*_shop_minor` totals are the money chain, and `order_payments.settlement_*` plus `exchange_adjustment_minor` record settlement (`0111`). `orders.market_id` is the market the order was placed in (`ON DELETE RESTRICT`, `0112`). |
| Markets | One backup market (partial unique index on `is_backup`); triggers refuse to delete it or clear its flag. Only the backup market has `price_increment_minor` and holds the root presence (`''`). A country belongs to one market (`market_countries.country_code` is the primary key). A subfolder is `<locale>-<country>`. Rules: [MARKETS-DESIGN.md](../../docs/MARKETS-DESIGN.md), "Step 2 implemented". |
| Shipping zones | A region (`delivery_zone_regions`: country, admin area or postal prefix) and a Bangladesh place belong to at most one zone. A live delivery rate has a zone (`SHIPPING_RATE_ZONE_REQUIRED`); only local pickup is store-wide (`0114`). |
| Fulfilment | `order_items.fulfilled_quantity` is a trigger projection of active `order_fulfillment_lines`. A fulfilment only moves active to voided. Lines are otherwise immutable. |
| Inventory | Each `inventory_movements` row is unique per `(variant_id, stock_version_after)`. Triggers check the ledger-v2 edge shape and maintain `inventory_levels.on_hand`. In-transit transfer units are out of both levels and out of the SKU's stock, so the levels always sum to the SKU's `stock`. |
| Purchasing | Purchase-order lines lock once the order is placed, and received quantities only move up. Transfer lines are fixed once shipped. Receipt lines, transfer movements and `inventory_commands` are append-only. |
| Reviews, gift cards, warranty | Triggers keep `product_review_stats`, `gift_cards.balance_minor` and `order_item_warranties` as projections, and refuse an ineligible review, a gift-card overdraft and any edit of a warranty revision. Rules: the [reviews](../core/src/modules/reviews/README.md), [gift-cards](../core/src/modules/gift-cards/README.md) and [warranty](../core/src/modules/warranty/README.md) READMEs. |
| Promotions | Discount allocations and redemptions are immutable. Triggers enforce redemption limits and spend budgets. |
| Invoices and returns | Issued invoices, invoice commands and return receipt lines are immutable. |
| Customers | `customer_order_stats` is a trigger projection of orders. |
| Search | Listing indexes such as `products_public_newest_idx`, `products_public_category_newest_idx` and `product_attribute_values_attr_value_product_idx` are measured. Do not change them without `EXPLAIN QUERY PLAN` evidence on D1. |

D1 holds FTS5 virtual tables (with sync triggers and a `unicode61` tokenizer) for search. They are raw SQL in the migrations, queried through `@scalius/core/search`. The TursoDB and PostgreSQL targets skip them, and the portability tools ignore derived FTS objects.

### Generated triggers

Two trigger families come from generators, not from hand-written SQL:

- **DVC dependency triggers.** `packages/shared/src/cache-deps.ts` is the registry of buyer-visible tables. `scripts/cache-dep-triggers.ts` generates one trigger per registered rule (`cdep_*`) plus the clock triggers. Each table is registered or listed in `CACHE_DEP_EXEMPT_TABLES`. Migration `0100_cache_dependencies` is immutable. `pnpm --filter @scalius/database exec tsx scripts/cache-dep-triggers.ts --write` rewrites only `0101_cache_ordering_dependencies`. A table registered later has a hand-assembled migration that must contain the generated statements verbatim: `CACHE_DEP_LATER_TABLES` maps each table to its migration (`0104`, `0108`, `0110`, `0112`, `0114`, `0116`, `0120`, `0121`). A rule added later to a deployed table installs its trigger in a newer migration: `CACHE_DEP_LATER_TRIGGERS` maps the trigger name (`0115`, the `mk:selling` triggers; `0120`, the market pricing triggers; `0121`, the presence locale triggers). A later migration that changes a baseline table's columns reinstalls its triggers the same way, and `CACHE_DEP_BASELINE_COLUMNS` keeps the columns `0100` saw (`0116` rebuilt `tax_rates` and dropped `tax_settings.prices_include_tax`). `__tests__/cache-dep-triggers.test.ts` keeps the generator and the migrations equal. See the [cache-deps README](../core/src/cache-deps/README.md).
- **Event outbox triggers.** `scripts/event-outbox-triggers.ts` generates the `evt_*` triggers. Each writes one `event_outbox` row in the same transaction as the domain write. `0103_order_channel_event_outbox` installs them, and `EVENT_TRIGGER_MIGRATIONS` maps later triggers to `0108` and `0109`. `__tests__/event-outbox.test.ts` requires each migration to contain the generated statements verbatim. The event catalog is `@scalius/shared/events`.

Both generators emit a PostgreSQL form. Remote D1 rejects a trigger body that embeds `SELECT CASE WHEN`, so the guard goes in the trigger `WHEN` clause and the body is one statement.

## Migrations

`migrations/` holds 122 SQL files, `0000` to `0121`. The latest is `0121_translations`. `0000_blushing_jack_power.sql` is the baseline and holds the raw SQL Drizzle cannot express (FTS5, partial indexes, guard triggers). Never delete or squash a released migration. Installed D1 databases depend on Wrangler's history, and installed TursoDB and PostgreSQL databases depend on the release ledger.

| Path | Content |
|------|---------|
| `migrations/NNNN_<name>.sql` | The canonical SQLite SQL (D1 and TursoDB) |
| `migrations/postgres/NNNN_<name>.sql` | The transaction-safe PostgreSQL sidecar (`0050` to `0121`, 72 files) |
| `migrations/meta/` | Drizzle journal and snapshots |

### Release ledger

Migration `0050_schema_release_contract` starts the provider-neutral ledger `scalius_schema_migrations` (`version`, `name`, `source_sha256`, `applied_at`). Every migration from `0050` onward must:

- end, in both files, with the same `INSERT INTO scalius_schema_migrations` row. Its digest is defined by `sourcePayloadSha256()` in `scripts/check-migration-metadata.mjs`;
- have a sidecar of the same name in `migrations/postgres/`;
- contain no transaction-control statement, `PRAGMA`, `VACUUM`, `ATTACH` or `CREATE INDEX CONCURRENTLY`;
- be listed in `CURRENT_DATABASE_SCHEMA_MIGRATIONS` in `src/schema-contract.ts`. `CURRENT_DATABASE_SCHEMA` names the latest release.

The API `/readyz` route reads the whole ledger and fails closed on a missing, extra, renamed, future or digest-mismatched row. `0049` is the legacy baseline that the TursoDB runner proves before it applies its first release.

### Add a migration

1. Change the schema in `src/schema/<file>.ts`.
2. Run `pnpm db:generate`. Drizzle Kit writes the SQL file, the journal entry and a snapshot.
3. Add any SQL Drizzle cannot express (triggers, partial indexes, FTS5) by hand. A migration without a snapshot must be listed in `allowedMissingSnapshots` in `scripts/check-migration-metadata.mjs`.
4. Add the PostgreSQL sidecar and the ledger row to both files.
5. Update `CURRENT_DATABASE_SCHEMA` and `CURRENT_DATABASE_SCHEMA_MIGRATIONS` in `src/schema-contract.ts`.
6. If you register a new table for DVC or add an event trigger, put the generated statements in the new migration (see "Generated triggers").
7. Run `pnpm --filter @scalius/database check:migrations`.

### Apply migrations

| Command | Effect |
|---------|--------|
| `pnpm db:migrate:local` | Applies the D1 chain to the local database (`scripts/deploy.mjs --migrate-only --local`, which runs `wrangler d1 migrations apply`). |
| `pnpm db:migrate:remote` | Applies the D1 chain to the remote database. |
| `pnpm --filter @scalius/database upgrade:schema` | Applies or checks releases on an existing TursoDB or PostgreSQL target. |
| `pnpm --filter @scalius/database migration-plan` | Prints the D1 plan as JSON for an applier that does not use Wrangler (`--out <file>` writes it). |
| `pnpm --filter @scalius/database compile:migrations` | Compiles an immutable provider bundle (`--provider`, `--out`). |

An ordinary deploy never changes an external database. For TursoDB or PostgreSQL it runs a read-only preflight, which needs `--database-target-host`. The explicit upgrade needs a verified write freeze:

```bash
# Read-only preflight (PostgreSQL shown; TursoDB uses TURSO_DATABASE_URL and TURSO_AUTH_TOKEN)
POSTGRES_DATABASE_URL='<target-url>' pnpm --filter @scalius/database upgrade:schema \
  --provider postgres --acknowledge-target-host '<host>' --dry-run --require-current

# Mutation, after the freeze is active and proven
POSTGRES_DATABASE_URL='<target-url>' pnpm --filter @scalius/database upgrade:schema \
  --provider postgres --acknowledge-target-host '<host>' --freeze-proof-sha256 '<proof>'
```

`--require-current` is valid only with `--dry-run`. A dry run refuses `--freeze-proof-sha256`. A mutation requires it (64 hex characters). The TursoDB runner applies each release in one transaction. The PostgreSQL runner applies each sidecar in one serializable transaction under an advisory lock. A replay after a lost response is a safe no-op.

### The D1 migration plan

`migration-plan` reads only `migrations/*.sql`, requires contiguous numbers from `0000`, and fails when the last file is not `CURRENT_DATABASE_SCHEMA`. The plan (`contract: scalius-d1-migration-plan/v1`) lists each file with its statements, its `d1_migrations` ledger insert and its release-ledger row. The `d1_migrations` DDL and inserts are byte-identical to Wrangler's, so a later `wrangler d1 migrations apply` finds nothing to apply. An external applier follows these rules:

1. Run `ledgerDdl`, then read the applied names with `ledgerListSql`. The names must be an exact ordered prefix of the plan, or the database has diverged and the deploy stops.
2. For each pending file, in order, run its `statements` and then its `ledgerInsert`, preferably as one D1 batch. Never re-split a statement on `;` (trigger bodies contain semicolons).
3. Never reorder, skip or edit a statement.

## Cutover and portability tools

[DATABASE-PORTABILITY.md](../../docs/DATABASE-PORTABILITY.md) owns the procedure, the freeze rules and the rollback rule. The scripts run as `pnpm --filter @scalius/database <script>` (`export:*`, `normalize:d1-export`, `compile:data-export`, `prepare:turso-upload`, `provision-upload:turso`, `upload:turso-bundle`, `migrate:sqlite-to-postgres`, `verify:portability-export`, the probes and the checkout load-test helpers; see `package.json`). `normalize:d1-export` needs `sqlite3` (override with `SQLITE3_BIN`). `migrate:sqlite-to-postgres` resumes from receipts and requires exact row and content fingerprints.

Do not use `turso db create --from-file --tursodb` for a cutover. It can report success and create an empty target. Use `prepare:turso-upload` and `provision-upload:turso`, and require exact remote fingerprints.

The portability manifest (`@scalius/database/portability`) walks every application table in primary-key chunks of 250 rows. It records schema, row, chunk and whole-database digests, ignores vendor internals and derived FTS objects, and refuses a table without a primary key.
