# Audit 02: Database Foundations, Schema, and Migrations

## Scope

This audit covers only the database foundation layer:

- `packages/database/src/schema/**`
- `packages/database/src/client.ts`
- `packages/database/src/batch-helper.ts`
- `packages/database/src/types.ts`
- `packages/database/drizzle.config.ts`
- `packages/database/migrations/**`
- migration snapshot integrity and drift risks
- DB typing patterns, indexes, constraints, and data-modeling concerns

I did not audit auth or business modules except where a runtime usage was needed to verify a DB-layer implication.

## How the DB Layer Works

- The repo uses Cloudflare D1 with Drizzle’s D1 adapter in [`packages/database/src/client.ts`](../packages/database/src/client.ts).
- `getDb(env)` caches a module-level `DrizzleD1Database<typeof schema>` singleton and returns it for later calls.
- The schema is declared in 10 domain files and re-exported through [`packages/database/src/schema/index.ts`](../packages/database/src/schema/index.ts).
- Migrations are generated/applied as SQLite SQL via [`packages/database/drizzle.config.ts`](../packages/database/drizzle.config.ts) and the `packages/database/migrations/` folder.
- Several important DB features are raw-SQL-only and live outside the typed schema model:
  - FTS5 virtual tables and triggers in [`packages/database/migrations/0016_fts5_search.sql`](../packages/database/migrations/0016_fts5_search.sql)
  - Bengali tokenizer rebuild in [`packages/database/migrations/0031_bengali_fts5_tokenizer.sql`](../packages/database/migrations/0031_bengali_fts5_tokenizer.sql)
  - partial unique indexes for payment idempotency in [`packages/database/migrations/0030_payment-idempotency-indexes.sql`](../packages/database/migrations/0030_payment-idempotency-indexes.sql)
  - partial unique index for invoice numbers in [`packages/database/migrations/0032_lyrical_adam_warlock.sql`](../packages/database/migrations/0032_lyrical_adam_warlock.sql)

## Verification Method

I used the `drizzle` skill explicitly for this review and validated the DB layer three ways:

1. Read every schema file, the client/config/types helpers, and the full migration chain.
2. Replayed all migrations into an in-memory SQLite database and inspected the resulting schema via `PRAGMA table_info`, `PRAGMA foreign_key_list`, and `PRAGMA index_list`.
3. Ran:
   - `pnpm --filter @scalius/database typecheck`
   - `pnpm exec drizzle-kit check --config packages/database/drizzle.config.ts`

The static checks passed, which is useful context: the current TypeScript/schema/snapshot setup can look healthy while the actual migrated SQLite schema still differs materially.

## Schema / Migration Observations

- The schema files describe the intended shape of the database as of today.
- The migration chain does not fully realize that intended shape for several older tables.
- `packages/database/migrations/meta/0033_snapshot.json` reflects the intended schema, not necessarily what the migration SQL leaves behind after replay.
- A few migrations are hand-written and not represented in the typed schema model, especially partial indexes and FTS objects.
- The package has a real split-brain risk between:
  - TypeScript schema and snapshot state
  - what a fresh database created by replaying `0000` through `0033` actually contains

## Findings

### 1. High: Many core tables still use `CURRENT_TIMESTAMP` text defaults even though the schema and Drizzle typing now assume integer Unix timestamps

**Why this matters**

The current schema standardizes timestamp columns as `integer(..., { mode: "timestamp" }).default(UNIX_NOW)`, which means the runtime expects epoch seconds in SQLite. But many older tables created in early migrations still use `DEFAULT CURRENT_TIMESTAMP`, which stores text timestamps, not integer epochs. That creates a real storage/type mismatch on fresh databases built from the migration chain.

**Evidence**

- The intended pattern is documented in [`packages/database/src/schema/shared.ts:7`](../packages/database/src/schema/shared.ts:7), which explicitly says the old `CURRENT_TIMESTAMP` default stored an ISO string into an integer column.
- Current schema examples now use `UNIX_NOW`:
  - [`packages/database/src/schema/products.ts:21`](../packages/database/src/schema/products.ts:21)
  - [`packages/database/src/schema/orders.ts:54`](../packages/database/src/schema/orders.ts:54)
  - [`packages/database/src/schema/system.ts:18`](../packages/database/src/schema/system.ts:18)
- But the initial and still-effective SQL for many tables remains `CURRENT_TIMESTAMP`:
  - [`packages/database/migrations/0000_cultured_newton_destine.sql:31`](../packages/database/migrations/0000_cultured_newton_destine.sql:31) `analytics`
  - [`packages/database/migrations/0000_cultured_newton_destine.sql:43`](../packages/database/migrations/0000_cultured_newton_destine.sql:43) `categories`
  - [`packages/database/migrations/0000_cultured_newton_destine.sql:107`](../packages/database/migrations/0000_cultured_newton_destine.sql:107) `customers`
  - [`packages/database/migrations/0000_cultured_newton_destine.sql:323`](../packages/database/migrations/0000_cultured_newton_destine.sql:323) `pages`
  - [`packages/database/migrations/0000_cultured_newton_destine.sql:398`](../packages/database/migrations/0000_cultured_newton_destine.sql:398) `products`
  - [`packages/database/migrations/0000_cultured_newton_destine.sql:447`](../packages/database/migrations/0000_cultured_newton_destine.sql:447) `site_settings`
  - [`packages/database/migrations/0001_sticky_giant_man.sql:5`](../packages/database/migrations/0001_sticky_giant_man.sql:5) `media_folders`
- Migration [`packages/database/migrations/0027_clean_mole_man.sql:1`](../packages/database/migrations/0027_clean_mole_man.sql:1) treats the `UNIX_NOW` change as a no-op, which is not true for the already-created tables above.

**Confirmed impact**

Replaying the migrations into SQLite showed tables like `products`, `categories`, `customers`, `delivery_locations`, `media`, `media_folders`, `pages`, `product_attributes`, `product_images`, `product_rich_content`, `product_variants`, `settings`, `site_settings`, `analytics`, and `collections` still end with `CURRENT_TIMESTAMP` defaults in the final schema.

That means inserts relying on defaults can write text timestamps into columns that Drizzle models as integer timestamps, which can break sorting, comparisons, and date hydration.

### 2. High: The current schema declares foreign keys and `onDelete` behavior that the replayed migration chain does not actually enforce

**Why this matters**

This is the biggest structural integrity gap in the package. The codebase increasingly assumes proper foreign keys and delete semantics, but many of those constraints were added only in TypeScript or snapshot state, not through table rebuild migrations.

**Evidence**

- The migration commentary in [`packages/database/migrations/0019_add-fk-indexes.sql:3`](../packages/database/migrations/0019_add-fk-indexes.sql:3) explicitly says the migration only adds indexes and treats FK declarations as schema/ORM concerns.
- Current schema expects real FKs and delete behavior on many tables:
  - [`packages/database/src/schema/products.ts:16`](../packages/database/src/schema/products.ts:16) `products.categoryId -> categories.id (set null)`
  - [`packages/database/src/schema/products.ts:44`](../packages/database/src/schema/products.ts:44) `product_images.productId -> products.id (cascade)`
  - [`packages/database/src/schema/products.ts:61`](../packages/database/src/schema/products.ts:61) `product_variants.productId -> products.id (cascade)`
  - [`packages/database/src/schema/orders.ts:77`](../packages/database/src/schema/orders.ts:77) `order_items.productId -> products.id (set null)`
  - [`packages/database/src/schema/orders.ts:80`](../packages/database/src/schema/orders.ts:80) `order_items.variantId -> product_variants.id (set null)`
  - [`packages/database/src/schema/inventory.ts:18`](../packages/database/src/schema/inventory.ts:18) `inventory_movements.variantId -> product_variants.id`
  - [`packages/database/src/schema/inventory.ts:21`](../packages/database/src/schema/inventory.ts:21) `inventory_movements.orderId -> orders.id (set null)`
  - [`packages/database/src/schema/inventory.ts:39`](../packages/database/src/schema/inventory.ts:39) `product_low_stock_alerts.variantId -> product_variants.id (cascade)`
  - [`packages/database/src/schema/delivery.ts:15`](../packages/database/src/schema/delivery.ts:15) `delivery_locations.parentId -> delivery_locations.id (set null)`
  - [`packages/database/src/schema/products.ts:203`](../packages/database/src/schema/products.ts:203) `media_folders.parentId -> media_folders.id (set null)`
  - [`packages/database/src/schema/products.ts:224`](../packages/database/src/schema/products.ts:224) `media.folderId -> media_folders.id (set null)`
  - [`packages/database/src/schema/marketing.ts:64`](../packages/database/src/schema/marketing.ts:64) `discount_products.productId -> products.id (cascade)`
  - [`packages/database/src/schema/marketing.ts:81`](../packages/database/src/schema/marketing.ts:81) `discount_collections.collectionId -> collections.id (cascade)`
- But the earlier table creation SQL left many of those tables without the matching foreign keys:
  - [`packages/database/migrations/0000_cultured_newton_destine.sql:351`](../packages/database/migrations/0000_cultured_newton_destine.sql:351) `product_images` has no product FK
  - [`packages/database/migrations/0000_cultured_newton_destine.sql:372`](../packages/database/migrations/0000_cultured_newton_destine.sql:372) `product_variants` has no product FK
  - [`packages/database/migrations/0000_cultured_newton_destine.sql:389`](../packages/database/migrations/0000_cultured_newton_destine.sql:389) `products.category_id` has no category FK
  - [`packages/database/migrations/0001_sticky_giant_man.sql:1`](../packages/database/migrations/0001_sticky_giant_man.sql:1) `media_folders` has no self FK
  - [`packages/database/migrations/0001_sticky_giant_man.sql:10`](../packages/database/migrations/0001_sticky_giant_man.sql:10) `media.folder_id` is added without FK
  - [`packages/database/migrations/0012_productive_ink.sql:18`](../packages/database/migrations/0012_productive_ink.sql:18) `inventory_movements` has no FKs
  - [`packages/database/migrations/0012_productive_ink.sql:75`](../packages/database/migrations/0012_productive_ink.sql:75) `product_low_stock_alerts` has no FKs
  - [`packages/database/migrations/0023_missing-fk-indexes.sql:1`](../packages/database/migrations/0023_missing-fk-indexes.sql:1) adds indexes only, not constraints

**Confirmed impact**

The replayed database ended with no foreign keys at all for:

- `products`
- `product_images`
- `product_variants`
- `inventory_movements`
- `product_low_stock_alerts`
- `delivery_locations`
- `media`
- `media_folders`

`order_items` also ended without the intended product/variant FKs. Only `order_id` is enforced.

This means the runtime can accumulate orphans and the actual delete behavior of production databases differs from what the schema, snapshot, and service code imply.

### 3. High: `permissions.updated_at` is still nullable and default-less in the real DB, despite the schema requiring a non-null epoch timestamp

**Why this matters**

This is a precise migration integrity failure, not just a modeling preference.

**Evidence**

- The current schema requires a non-null defaulted timestamp at [`packages/database/src/schema/rbac.ts:21`](../packages/database/src/schema/rbac.ts:21).
- The only migration touching this field is [`packages/database/migrations/0024_singleton-and-enum-fixes.sql:17`](../packages/database/migrations/0024_singleton-and-enum-fixes.sql:17), which just does:
  - `ALTER TABLE permissions ADD COLUMN updated_at INTEGER;`

There is no backfill, no `NOT NULL`, no default, and no later table rebuild for `permissions`.

**Confirmed impact**

The replayed database leaves `permissions.updated_at` nullable with no default. That is a permanent mismatch against the schema and snapshot contract, and any code assuming `updatedAt` is always present can be wrong.

### 4. Medium: `order_items.product_id` is modeled with an impossible `NOT NULL` + `ON DELETE SET NULL` combination

**Why this matters**

This is an internal data-model conflict in the schema itself.

**Evidence**

- [`packages/database/src/schema/orders.ts:77`](../packages/database/src/schema/orders.ts:77) marks `productId` as `.notNull()`
- [`packages/database/src/schema/orders.ts:79`](../packages/database/src/schema/orders.ts:79) also declares `onDelete: "set null"`

If the table is ever rebuilt to match the current Drizzle schema, deleting a referenced product would force SQLite to set `product_id = NULL`, which conflicts with the `NOT NULL` column definition.

**Confirmed impact**

Right now the migration-replayed DB does not have that FK at all, so the contradiction is latent. But it becomes a migration trap the moment the team tries to “fix” the foreign key drift and rebuild the table.

### 5. Medium: Enum/status integrity exists in TypeScript but not in SQLite

**Why this matters**

Large parts of the business logic rely on closed sets of states: order lifecycle, payment lifecycle, inventory pool, shipment status, alert status, etc. Today those are only TypeScript hints and route-level validation rules. SQLite itself accepts arbitrary strings.

**Evidence**

- Examples of enum-like schema definitions:
  - [`packages/database/src/schema/orders.ts:37`](../packages/database/src/schema/orders.ts:37) `orders.status`
  - [`packages/database/src/schema/orders.ts:41`](../packages/database/src/schema/orders.ts:41) `orders.paymentStatus`
  - [`packages/database/src/schema/orders.ts:46`](../packages/database/src/schema/orders.ts:46) `orders.fulfillmentStatus`
  - [`packages/database/src/schema/marketing.ts:17`](../packages/database/src/schema/marketing.ts:17) `discounts.type`
  - [`packages/database/src/schema/delivery.ts:60`](../packages/database/src/schema/delivery.ts:60) `delivery_shipments.status`
- The migration SQL creates these as plain `TEXT` columns without `CHECK` constraints:
  - [`packages/database/migrations/0000_cultured_newton_destine.sql:291`](../packages/database/migrations/0000_cultured_newton_destine.sql:291) `orders.status`
  - [`packages/database/migrations/0012_productive_ink.sql:135`](../packages/database/migrations/0012_productive_ink.sql:135) `orders.payment_method`
  - [`packages/database/migrations/0012_productive_ink.sql:136`](../packages/database/migrations/0012_productive_ink.sql:136) `orders.payment_status`
  - [`packages/database/migrations/0012_productive_ink.sql:140`](../packages/database/migrations/0012_productive_ink.sql:140) `orders.fulfillment_status`
  - [`packages/database/migrations/0012_productive_ink.sql:141`](../packages/database/migrations/0012_productive_ink.sql:141) `orders.inventory_pool`

**Confirmed impact**

Invalid states can be written by raw SQL, one-off scripts, future migrations, or any accidental bypass of Zod/route validation. This is especially risky in a codebase that treats status values as control-flow inputs across orders, payments, notifications, and inventory.

### 6. Medium: The migration metadata is drifting from the real database, and `meta_conversions_settings` ends up with duplicate unique indexes

**Why this matters**

This is both an efficiency problem and a migration-safety problem.

**Evidence**

- `meta_conversions_settings` declares a single unique index in schema at [`packages/database/src/schema/marketing.ts:126`](../packages/database/src/schema/marketing.ts:126).
- But the SQL chain creates two different unique indexes on the same column:
  - [`packages/database/migrations/0024_singleton-and-enum-fixes.sql:11`](../packages/database/migrations/0024_singleton-and-enum-fixes.sql:11) `meta_conversions_singleton_idx`
  - [`packages/database/migrations/0029_large_weapon_omega.sql:5`](../packages/database/migrations/0029_large_weapon_omega.sql:5) `meta_conversions_settings_singleton_idx`
- The replayed DB confirms both indexes exist.

There is a second drift class too:

- Partial unique indexes for payment idempotency live only in SQL:
  - [`packages/database/migrations/0030_payment-idempotency-indexes.sql:29`](../packages/database/migrations/0030_payment-idempotency-indexes.sql:29)
  - [`packages/database/src/schema/orders.ts:127`](../packages/database/src/schema/orders.ts:127) only comments about them
- The invoice unique partial index also lives only in SQL:
  - [`packages/database/migrations/0032_lyrical_adam_warlock.sql:2`](../packages/database/migrations/0032_lyrical_adam_warlock.sql:2)
  - there is no corresponding index declaration in [`packages/database/src/schema/orders.ts`](../packages/database/src/schema/orders.ts)

**Confirmed impact**

- `meta_conversions_settings` pays duplicate index maintenance cost on every write.
- The physical DB contains important indexes that the typed schema and snapshot do not fully model, which makes future migration generation/review less trustworthy.

### 7. Low: `getDb()` correctness depends on initialization order, and there is still zero-arg usage outside the DB package

**Why this matters**

This is more of an architectural sharp edge than a pure schema bug, but it affects DB correctness.

**Evidence**

- The DB client caches the first singleton instance at [`packages/database/src/client.ts:11`](../packages/database/src/client.ts:11).
- The proxy export throws if initialization has not happened yet at [`packages/database/src/client.ts:43`](../packages/database/src/client.ts:43).
- There is still a zero-arg `getDb()` call in [`packages/core/src/integrations/email/resend.ts:27`](../packages/core/src/integrations/email/resend.ts:27).

**Impact**

This creates hidden coupling to request/bootstrap order and makes it easier for non-request code paths to fail unexpectedly or to bind to the wrong DB handle in tests or alternative execution contexts.

## Odd Complexity / Inefficiency Notes

- The repo is carrying two DB truths at once:
  - Drizzle schema + snapshots
  - replayed migration SQL
- `drizzle-kit check` passing is not enough for this package. It did not catch the timestamp-default drift, missing FK enforcement, or the nullable `permissions.updated_at` mismatch.
- The package relies heavily on raw SQL for important behavior, which is fine in itself, but those objects are not uniformly re-modeled in the schema/snapshot layer.
- `safeBatch()` in [`packages/database/src/batch-helper.ts`](../packages/database/src/batch-helper.ts) intentionally collapses typing to `Promise<any[]>`, and many call sites still invoke `db.batch()` with `as any`. That is pragmatic, but it weakens confidence in atomic multi-statement flows that are foundational to orders/inventory.

## Prioritized Follow-Ups

1. Build corrective table-rebuild migrations for the timestamp-default drift.
   Rebuild the affected `CURRENT_TIMESTAMP` tables so their defaults match `UNIX_NOW`, and backfill any text timestamps to integer epoch seconds before swapping tables.

2. Decide the canonical FK/nullability contract, then make the SQL match it.
   Start with:
   - `products.categoryId`
   - `product_images.productId`
   - `product_variants.productId`
   - `order_items.productId`
   - `order_items.variantId`
   - `inventory_movements.variantId/orderId`
   - `product_low_stock_alerts.variantId/productId`
   - `delivery_locations.parentId`
   - `media_folders.parentId`
   - `media.folderId`
   - `discount_products.productId`
   - `discount_collections.collectionId`

3. Fix `permissions.updated_at` with a real migration.
   Backfill existing nulls, add a non-null default, and rebuild if needed so the DB matches the schema.

4. Resolve the `order_items.productId` contradiction before rebuilding FKs.
   Either make the column nullable if `SET NULL` is the intended delete behavior, or change the FK action to `RESTRICT`/`CASCADE`.

5. Add DB-level `CHECK` constraints for the highest-value state columns.
   The first candidates should be:
   - `orders.status`
   - `orders.payment_status`
   - `orders.fulfillment_status`
   - `orders.inventory_pool`
   - `order_payments.status`
   - `delivery_shipments.status`
   - `product_low_stock_alerts.alert_status`

6. Bring the schema/snapshot layer back in sync with manual SQL.
   Either model partial indexes in Drizzle if the current version supports it, or maintain a deliberate raw-SQL manifest plus a CI verification step that introspects a migrated SQLite schema and compares required indexes/FKs/defaults.

7. Remove the duplicate `meta_conversions_settings` singleton index.

8. Tighten DB bootstrap rules.
   Prefer explicit `getDb(env)` in request/execution entrypoints and eliminate zero-arg usage outside already-initialized contexts.
