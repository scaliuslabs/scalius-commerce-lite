# @scalius/database

The Drizzle schema, the request-safe client and the migration tools for Cloudflare D1, TursoDB and PostgreSQL. D1 is the zero-configuration default. This page is for contributors who change the schema or provider support. To move a store between providers, follow [DATABASE-PORTABILITY.md](../../docs/DATABASE-PORTABILITY.md).

## Exports

Import by subpath only. The package has no root export, and a source policy rejects a root import.

| Import | File | Use |
|--------|------|-----|
| `@scalius/database/schema` | `src/schema/index.ts` | Tables, enums and row types |
| `@scalius/database/client` | `src/client.ts` | `getDb`, `schema`, `Database`, `safeBatch`, `buildBatchGuard`, chunk helpers, provider helpers |
| `@scalius/database/types` | `src/types.ts` | The `Database` type |
| `@scalius/database/postgres-adapter` | `src/postgres-adapter.ts` | The PostgreSQL compatibility adapter |
| `@scalius/database/read-observer` | `src/read-observer.ts` | Reports the tables each statement touches (used by DVC) |
| `@scalius/database/migration-artifacts` | `src/migration-artifacts.ts` | Compiles migrations and data exports per provider |
| `@scalius/database/migration-plan` | `src/migration-plan.ts` | The machine-readable D1 migration plan |
| `@scalius/database/schema-contract` | `src/schema-contract.ts` | The current release identity and ledger reader |
| `@scalius/database/portability` | `src/portability.ts` | Schema and data fingerprints for cutover checks |
| `@scalius/database/testing/sqlite-d1` | `src/testing/sqlite-d1.ts` | Test doubles over `node:sqlite` |

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
3. `postgres` needs `HYPERDRIVE` or `POSTGRES_DATABASE_URL`. `HYPERDRIVE` wins when both exist. The URL must use `postgres:` or `postgresql:` and name a database.
4. `d1` needs `env.DB` and ignores external credentials. Use it to roll back while target credentials stay installed.
5. Without `DATABASE_PROVIDER`: Turso and PostgreSQL credentials together throw. PostgreSQL credentials select PostgreSQL. Any Turso credential selects Turso and needs both. Otherwise `env.DB` selects D1.

Capabilities (`getDatabaseProviderCapabilities()`):

| Provider | Concurrent writes | FTS5 | Recursive CTE | `WITHOUT ROWID` |
|----------|-------------------|------|---------------|-----------------|
| D1 | No | Yes | Yes | Yes |
| TursoDB | Yes | No | No | No |
| PostgreSQL | Yes | No | Yes | No |

Provider-aware helpers supply bounded alternatives where a feature is missing (for example `@scalius/core/search`). Do not add provider checks to domain code. Migration, copy and cutover work never runs on a request path.

For a cutover, an operator sets the `DATABASE_MIGRATION_FREEZE` secret to `1`, `true` or `on`. The API Worker then answers ordinary requests with 503, retries queue messages and skips scheduled mutations. The health, readiness and meta probes stay available.

### Atomic batches

- `safeBatch(db, statements)` runs the statements as one atomic batch on every provider.
- `buildBatchGuard(db, condition, MARKER)` adds a guard statement. The batch fails with `MARKER` when the condition is false. `isBatchGuardError(error, MARKER)` recognizes the failure on every provider. A marker is an uppercase identifier.
- D1 allows 100 bound parameters per statement. `D1_ID_CHUNK_SIZE` is 90. Use `chunkForD1()` for id lists and `chunkRowsForD1()` for multi-row inserts.

## Conventions

- **Timestamps** are `integer(..., { mode: "timestamp" })` columns holding Unix epoch seconds. The default is `UNIX_NOW` (`src/schema/shared.ts`). Soft delete uses a nullable `deleted_at`. Orders use `archived_at` and are never hard-deleted.
- **Money** is an integer `*_minor` column in minor units. Rates are basis points (`discount_bps`, `rate_bps`).
- **Concurrency**: a `revision`, `version`, `aggregate_revision` or `stock_version` column is a compare-and-swap counter. Writers read it and update `WHERE` it still matches.
- **Entity ids** are text primary keys. Code generates `<prefix>_<nanoid>` for most tables. The Better Auth tables use Better Auth's own ids.
- **Order ids** come from `generateOrderId()` (`@scalius/shared/order-utils`): 16 Crockford base32 characters. Older six-character ids stay valid. `orders.order_number` is a separate unique sequence that starts at 1001.
- **JSON columns** are `text()` columns, some with a `json_valid` check. The owning domain's service layer validates their shape.

| Prefix | Entity |
|--------|--------|
| `prod_`, `var_`, `cat_`, `brd_`, `cust_` | Product, SKU (`product_variants`), category, brand, customer |
| `pmed_`, `prc_`, `pcb_`, `pbd_` | Product media, rich content, content block, quantity bundle |
| `attr_`, `atg_`, `atv_`, `val_` | Attribute, attribute group, attribute value, product attribute value |
| `hist_`, `aor_`, `item_` | Customer history, OTP delivery receipt, checkout order item |
| `media_`, `folder_`, `page_`, `article_`, `analytics_` | Media, media folder, CMS page, article (a page with `content_type = 'article'`), analytics script |
| `rev_`, `dga_`, `gc_`, `gct_` | Review, digital asset, gift card, gift-card transaction |
| `wrp_`, `wrr_`, `wty_`, `wcl_` | Warranty policy, policy revision, line warranty, claim |
| `evt_` | Event outbox row (`evt_` + milliseconds + 12 hex characters) |

## Schema map

The schema has 171 tables in `src/schema/`. `index.ts` re-exports every file. The schema files are the source of truth for columns.

| File | Tables |
|------|--------|
| `auth.ts` | `user`, `session`, `account`, `verification`, `two_factor`, `rate_limit` (Better Auth); `admin_setup_claims`, `admin_setup_rate_limits`, `admin_invitations`, `scanner_token_claims`, `admin_identity_handoff_events` |
| `rbac.ts` | `permissions`, `roles`, `role_permissions`, `user_roles`, `user_permissions` |
| `products.ts` | `products`, `product_media`, `product_option_definitions`, `product_option_values`, `product_variants`, `product_variant_option_values`, `categories`, `collections`, `brands`, `attribute_groups`, `product_attributes`, `attribute_values`, `product_attribute_values`, `product_rich_content` |
| `catalog.ts` | `category_closure`, `category_attribute_sets`, `product_facet_values`, `product_buyer_state`, `product_recommendations`, `product_sales_stats`, `product_content_blocks`, `product_bundles` |
| `media.ts` | `media_folders`, `media`, `media_upload_sessions`, `media_upload_parts` |
| `custom-fields.ts` | `custom_field_definitions`, `custom_field_values` |
| `customers.ts` | `customers`, `customer_history`, `customer_auth_otp_challenges`, `customer_sessions`, `customer_auth_otp_rate_limits`, `auth_otp_delivery_receipts` |
| `customer-marketing.ts` | `customer_marketing_consents`, `customer_marketing_consent_events`, `customer_tag_links`, `customer_segments`, `customer_order_stats`, `promotion_customer_segments` |
| `orders.ts` | `orders`, `order_items`, `order_payments`, `payment_plans`, `cod_tracking`, `refund_attempts`, `payment_session_attempts`, `webhook_events`; idempotency and proof: `checkout_attempts`, `admin_order_create_attempts`, `order_receipts`, `order_payment_recovery_challenges`; `order_amendments`, `order_events`, `order_holds`, `order_support_requests`, `abandoned_checkouts`; invoices: `invoice_sequences`, `order_invoices`, `invoice_issue_commands`; returns: `order_returns`, `order_return_lines`, `order_return_commands`, `order_return_receipt_lines`; tax: `order_tax_snapshots`, `order_item_tax_snapshots` |
| `fulfilment.ts` | `order_fulfillments`, `order_fulfillment_lines` (the fulfilment ledger) |
| `conversations.ts` | `conversations`, `conversation_messages`, `conversation_attachments` |
| `notifications.ts` | `notification_outbox`, `notification_delivery_receipts` |
| `inventory.ts` | `inventory_locations`, `inventory_levels`, `inventory_movements` (ledger v2), `inventory_operations`, `inventory_commands`, `inventory_transfers`, `inventory_transfer_lines`, `inventory_transfer_movements`, `product_low_stock_alerts` |
| `purchasing.ts` | `suppliers`, `purchase_orders`, `purchase_order_lines`, `purchase_order_receipt_lines` |
| `delivery.ts` | `delivery_locations`, `delivery_zones`, `delivery_zone_locations`, `shipping_methods`, `delivery_providers`, `delivery_shipments` |
| `promotions.ts` | `promotions`, `promotion_codes`, `promotion_conditions`, `promotion_effects`, `order_discount_allocations`, `promotion_redemptions` |
| `tax.ts` | `tax_classes`, `tax_settings`, `tax_rates` |
| `reviews.ts` | `product_reviews`, `product_review_stats`, `order_review_requests` |
| `digital.ts` | `digital_assets`, `digital_asset_uploads`, `digital_entitlements`, `digital_licence_keys` |
| `gift-cards.ts` | `gift_cards`, `gift_card_transactions` |
| `warranty.ts` | `warranty_policies`, `warranty_policy_revisions`, `order_item_warranties`, `warranty_claims` |
| `content.ts` | `pages` (pages and articles) |
| `navigation.ts` | `navigation_menus`, `navigation_menu_items`, `navigation_menu_publications`, `navigation_menu_publication_items`, `navigation_placements` |
| `marketing.ts` | `meta_conversions_logs`, `meta_capi_purchase_outbox` |
| `events.ts` | `event_outbox`, `webhook_subscriptions`, `webhook_event_deliveries` |
| `plugins.ts` | `plugin_installations`, `plugin_registrations`, `plugin_records`, `plugin_kv`, `plugin_log_entries`, `plugin_event_deliveries`, `plugin_cron_runs` |
| `agent-access.ts` | `agent_grants`, `agent_credentials`, `agent_artifact_handles`, `agent_browser_handoffs`, `agent_authorization_requests`, `agent_device_authorizations`, `agent_audit_events`, `agent_storefront_contexts`, `agent_storefront_order_grants`, `agent_storefront_continuations` |
| `system.ts` | `scalius_schema_migrations` (release ledger); `settings`; `checkout_authority`; `cache_clock`, `cache_dep`, `cache_generation`; `theme_settings`, `theme_settings_drafts`, `theme_settings_versions`, `theme_preview_sessions`; `analytics`, `admin_fcm_tokens`, `checkout_languages` |

Notes on single tables:

- `settings` holds typed settings documents. `category` is the document key, `key` is `'document'`, `value` is JSON and `revision` is the compare-and-swap counter. Fraud-checker provider rows and `notification_provider_health` markers also live here. Each domain declares its documents. See [ARCHITECTURE.md](../../docs/ARCHITECTURE.md), "Settings documents".
- `theme_settings` holds the published storefront theme (the JSON document is in its `colors` column). `theme_settings_drafts` holds the one shared draft. `theme_settings_versions` holds immutable publish snapshots. `theme_preview_sessions` holds hashed preview tokens.
- `checkout_authority` is a one-row fence. Triggers advance its `revision` on every change to a fact that affects checkout prices or eligibility. The checkout commit batch asserts the revision it priced against.
- `product_buyer_state` and `product_facet_values` are projections that every product write refreshes in the same batch. A rebuild recomputes them.
- `cache_generation` is a legacy singleton. Nothing in the application reads or writes it.
- `order_holds` holds one row per order and app: an app's `order.risk` answer can hold fulfilment until staff release it.
- `product_variants` rows are SKUs. `cost_minor` is the SKU's staff-only unit cost. `order_items.unit_cost_minor` snapshots it when a line is created.

## Enums

`src/schema/enums.ts` holds `const` objects with derived union types.

| Enum | Values |
|------|--------|
| `OrderStatus` | `pending`, `processing`, `confirmed`, `shipped`, `delivered`, `completed`, `cancelled`, `refunded`, `returned`, `incomplete` |
| `PaymentStatus` | `unpaid`, `partial`, `paid`, `partially_refunded`, `refunded`, `failed` |
| `FulfillmentStatus` | `pending`, `partial`, `complete` |
| `PaymentMethod` | `stripe`, `sslcommerz`, `cod` |
| `PaymentRecordStatus` | `pending`, `confirmed`, `succeeded`, `failed`, `refunded`, `cancelled` |
| `PaymentPlanStatus` | `pending`, `deposit_paid`, `completed`, `cancelled` |
| `CodStatus` | `pending`, `collected`, `failed`, `returned` |
| `InventoryPool` | `regular`, `preorder`, `backorder` |
| `DeliveryProvider` | `pathao`, `steadfast` |
| `ShipmentStatus` | `creating`, `pending`, `pickup_assigned`, `picked_up`, `pickup_failed`, `in_transit`, `out_for_delivery`, `delivered`, `partial_delivered`, `delivery_failed`, `on_hold`, `failed`, `returned`, `cancelled`, `processing`, `reconcile_required`, `unknown` |
| `AlertStatus` | `active`, `acknowledged`, `resolved` |

`orders.payment_method` and `delivery_providers.type` also hold an app provider id (`<plugin id>:<provider id>`), so they are plain text columns. Other columns use inline enums, such as `products.discount_type` (`percentage`, `flat`) and `categories.status` (`draft`, `published`, `internal`).

## Database-enforced invariants

Constraints, triggers and indexes protect these rules. Do not work around them in code.

| Area | Rule |
|------|------|
| SKU identity | SKU and barcode are unique on `lower(trim(...))` across all products. Active option identity is unique per product (`product_variants_active_option_identity_uidx`). A product has at most one live default SKU (`product_variants_one_default_per_product_idx`). |
| Variant image | `product_variants.image_id` is nullable and references `product_media.id` (`ON DELETE SET NULL`). `NULL` means the product's primary image. |
| Product media | A product has unique media ids and sort orders, and at most one primary image (`product_media_one_primary_uidx`). |
| Categories | Write only `parent_id`. Triggers keep `depth` (0-3), `path` and `category_closure` exact and refuse cycles, trashed parents and a fifth level. |
| Orders | `orders.version` is a CAS counter. `channel` never changes after insert (`orders_channel_immutable`). `order_payments` is unique on `(payment_method, provider_ref)` where `provider_ref` is not null. |
| Fulfilment | `order_items.fulfilled_quantity` is a trigger projection of active `order_fulfillment_lines`. A fulfilment only moves active to voided. Lines are otherwise immutable. |
| Inventory | Each `inventory_movements` row is unique per `(variant_id, stock_version_after)`. Triggers check the ledger-v2 edge shape and maintain `inventory_levels.on_hand`. In-transit transfer units are out of both levels and out of the SKU's stock, so the levels always sum to the SKU's `stock`. |
| Purchasing | Purchase-order lines lock once the order is placed, and received quantities only move up. Transfer lines are fixed once shipped. Receipt lines, transfer movements and `inventory_commands` are append-only. |
| Reviews | A `BEFORE INSERT` trigger accepts a review only for a handed-over line of a delivered or completed order. `product_review_stats` is a trigger projection of published reviews. A trigger on `orders.status` writes one `order_review_requests` row when an order is delivered. |
| Gift cards | `gift_cards.balance_minor` is a trigger projection of the append-only `gift_card_transactions` ledger. Triggers refuse an overdraft and the redemption of a disabled or expired card. |
| Warranty | A trigger creates one `order_item_warranties` row per fulfilment line of a line that carries a policy revision, and voids it with the fulfilment. |
| Promotions | Discount allocations and redemptions are immutable. Triggers enforce redemption limits and spend budgets. |
| Invoices and returns | Issued invoices, invoice commands and return receipt lines are immutable. |
| Customers | `customer_order_stats` is a trigger projection of orders. |
| Search | Listing indexes such as `products_public_newest_idx`, `products_public_category_newest_idx` and `product_attribute_values_attr_value_product_idx` are measured. Do not change them without `EXPLAIN QUERY PLAN` evidence on D1. |

D1 holds FTS5 virtual tables (with sync triggers and a `unicode61` tokenizer) for search. They are raw SQL in the migrations, queried through `@scalius/core/search`. The TursoDB and PostgreSQL targets skip them, and the portability tools ignore derived FTS objects.

### Generated triggers

Two trigger families come from generators, not from hand-written SQL:

- **DVC dependency triggers.** `packages/shared/src/cache-deps.ts` is the registry of buyer-visible tables. `scripts/cache-dep-triggers.ts` generates one trigger per registered rule (`cdep_*`) plus the clock triggers. Each table is registered or listed in `CACHE_DEP_EXEMPT_TABLES`. Migration `0100_cache_dependencies` is immutable. `pnpm --filter @scalius/database exec tsx scripts/cache-dep-triggers.ts --write` rewrites only `0101_cache_ordering_dependencies`. A table registered later has a hand-assembled migration that must contain the generated statements verbatim: `CACHE_DEP_LATER_TABLES` maps each table to its migration (`0104`, `0108`, `0110`). `__tests__/cache-dep-triggers.test.ts` keeps the generator and the migrations equal. See the [cache-deps README](../core/src/cache-deps/README.md).
- **Event outbox triggers.** `scripts/event-outbox-triggers.ts` generates the `evt_*` triggers. Each writes one `event_outbox` row in the same transaction as the domain write. `0103_order_channel_event_outbox` installs them. `EVENT_TRIGGER_MIGRATIONS` maps later triggers to `0108` and `0109`. `__tests__/event-outbox.test.ts` requires each migration to contain the generated statements verbatim. The event catalog is `@scalius/shared/events`.

Both generators emit a PostgreSQL form. Remote D1 rejects a trigger body that embeds `SELECT CASE WHEN`, so the guard goes in the trigger `WHEN` clause and the body is one statement.

## Migrations

`migrations/` holds 111 SQL files, `0000` to `0110`. The latest is `0110_plugin_providers`. `0000_blushing_jack_power.sql` is the baseline and holds the raw SQL Drizzle cannot express (FTS5, partial indexes, guard triggers). Never delete or squash a released migration. Installed D1 databases depend on Wrangler's history, and installed TursoDB and PostgreSQL databases depend on the release ledger.

| Path | Content |
|------|---------|
| `migrations/NNNN_<name>.sql` | The canonical SQLite SQL (D1 and TursoDB) |
| `migrations/postgres/NNNN_<name>.sql` | The transaction-safe PostgreSQL sidecar (`0050` to `0110`, 61 files) |
| `migrations/meta/` | Drizzle journal and snapshots |

### Release ledger

Migration `0050_schema_release_contract` starts the provider-neutral ledger `scalius_schema_migrations` (`version`, `name`, `source_sha256`, `applied_at`). Every migration from `0050` onward must:

- end, in both files, with the same `INSERT INTO scalius_schema_migrations` row. Its digest is defined by `sourcePayloadSha256()` in `scripts/check-migration-metadata.mjs`;
- have a sidecar of the same name in `migrations/postgres/`;
- contain no transaction-control statement, `PRAGMA`, `VACUUM`, `ATTACH` or `CREATE INDEX CONCURRENTLY`;
- be listed in `CURRENT_DATABASE_SCHEMA_MIGRATIONS` in `src/schema-contract.ts`. `CURRENT_DATABASE_SCHEMA` names the latest release.

The API `/readyz` route reads the whole ledger. It fails closed on a missing, extra, renamed, future or digest-mismatched row. `0049` is the legacy baseline that the TursoDB runner proves before it applies its first release.

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

`__tests__/migration-plan.test.ts` pins the DDL against the installed Wrangler and replays the whole plan into SQLite.

## Cutover and portability tools

These scripts run as `pnpm --filter @scalius/database <script>`. [DATABASE-PORTABILITY.md](../../docs/DATABASE-PORTABILITY.md) owns the procedure, the freeze rules and the rollback rule.

| Script | Purpose |
|--------|---------|
| `export:d1-portable` | Exports a frozen D1 database bound to an unchanged Time Travel bookmark |
| `export:turso-portable` | Converts a frozen TursoDB snapshot to a canonical SQLite file |
| `normalize:d1-export` | Projects a D1 SQL export onto the current canonical schema. Needs `sqlite3` (override with `SQLITE3_BIN`). |
| `compile:data-export` | Compiles a normalized data-only artifact for a provider |
| `prepare:turso-upload` | Builds the native TursoDB upload artifact and its evidence |
| `provision-upload:turso` | Provisions a TursoDB target, uploads the artifact and verifies fingerprints |
| `upload:turso-bundle` | Uploads a prepared bundle to an existing TursoDB database |
| `migrate:sqlite-to-postgres` | Copies a canonical SQLite file into an empty PostgreSQL database. It resumes from receipts and requires exact row and content fingerprints. |
| `verify:portability-export` | Verifies a source export against its portability manifest |
| `probe:turso-concurrency`, `rehearse:near-limit` | TursoDB concurrency probe and a near-limit migration rehearsal |
| `prepare:checkout-load-target`, `seed:checkout-load-target`, `add:checkout-load-hot-fixture`, `load:checkout-live` | Checkout load-test helpers |

Do not use `turso db create --from-file --tursodb` for a cutover. It can report success and create an empty target. Use `prepare:turso-upload` and `provision-upload:turso`, and require exact remote fingerprints.

The portability manifest (`@scalius/database/portability`) walks every application table in primary-key chunks of 250 rows. It records schema, row, chunk and whole-database digests, ignores vendor internals and derived FTS objects, and refuses a table without a primary key.

## Dependencies

| Package | Purpose |
|---------|---------|
| `drizzle-orm`, `drizzle-kit` (dev) | Schema, queries, migration generation |
| `@neondatabase/serverless` | Fetch-only PostgreSQL transport |
| `pg` | Native PostgreSQL and Hyperdrive transport |
| `@tursodatabase/serverless` | Fetch-only TursoDB transport and concurrent atomic batches |
| `@tursodatabase/database`, `@tursodatabase/sync` | Local TursoDB artifact handling and revision-fenced source snapshots |
| `@cloudflare/workers-types` (dev) | `D1Database` type |

Versions are in `package.json`.
