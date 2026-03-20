# Database Schema & Migrations Audit

## Summary

The `@scalius/database` package is a well-structured, JIT (no-build) Drizzle ORM layer targeting Cloudflare D1 (SQLite). It contains 13 schema files defining ~40 tables across 11 domain areas, a singleton client factory with Proxy-based lazy access, and 28 sequential migrations. The overall quality is high -- naming is consistent, indexes are thorough, and the domain decomposition is clean. The main issues are: inconsistent nullability/notNull on boolean columns, several text columns storing JSON without validation, `slug` columns lacking UNIQUE constraints, and a data migration (0014) that hardcodes a production domain URL.

## Strengths

1. **Clean domain decomposition**: Schema files are split by bounded context (auth, rbac, products, customers, orders, inventory, delivery, marketing, content, system) with a barrel `index.ts`. This makes it easy to find and modify tables.

2. **Consistent timestamp pattern**: Nearly all tables use `integer("...", { mode: "timestamp" })` with `.default(UNIX_NOW)` -- a well-documented shared helper in `shared.ts` that correctly produces Unix epoch seconds for Drizzle's timestamp mode. This was standardized across the codebase (migration 0027 synced the snapshot).

3. **Comprehensive indexing**: FK columns, lookup columns, soft-delete columns, and composite query patterns all have explicit indexes. Migrations 0019, 0023, and 0025 systematically backfilled missing indexes. The `products_active_idx` composite index on `(isActive, deletedAt)` is a good example of query-aware indexing.

4. **FTS5 integration**: Migration 0016 sets up external-content FTS5 virtual tables with proper BEFORE DELETE / BEFORE UPDATE / AFTER INSERT / AFTER UPDATE triggers for 8 entities. The external-content pattern avoids data duplication. The trigger-based sync is correct and idempotent (DROP IF EXISTS before CREATE).

5. **Optimistic locking**: Both `orders.version` and `productVariants.version` + `productVariants.stockVersion` support CAS-based concurrency control. The separation of `version` (general) from `stockVersion` (stock-specific) is a smart design that reduces false conflicts.

6. **Singleton guards**: `siteSettings` and `metaConversionsSettings` use `singletonKey` columns with UNIQUE indexes to enforce at-most-one-row semantics (migration 0024). This prevents a common class of bugs.

7. **Enum constants**: All status/type enums are defined as `const` objects in `enums.ts` with derived TypeScript types. Schema columns reference these constants directly (e.g., `default(OrderStatus.PENDING)`), keeping the source of truth in one place.

8. **Type exports**: Every schema file exports `InferSelectModel` types alongside table definitions. The `Database` type in `types.ts` is cleanly derived from `DrizzleD1Database<typeof schema>`.

9. **Client factory**: `getDb()` is a simple singleton with clear error messages. The `Proxy`-based `db` export provides backward-compatible lazy access with an informative error if middleware hasn't initialized it.

10. **Package exports**: The `exports` field in `package.json` cleanly exposes `./schema`, `./client`, and `./types` as separate entry points, enabling tree-shaking-friendly imports like `import { products } from "@scalius/database/schema"`.

## Issues Found

### Critical

None.

### Major

**M1. Inconsistent `notNull()` on boolean columns**

Some boolean columns have `.notNull().default(false)` while others have just `.default(false)` without `notNull()`. In SQLite, an integer column without NOT NULL can store NULL, which is a third state beyond true/false that most application code does not expect.

Affected columns (nullable booleans -- missing `notNull()`):
- `user.banned` -- `.default(false)` without notNull
- `user.twoFactorEnabled` -- `.default(false)` without notNull
- `session.twoFactorVerified` -- `.default(false)` without notNull
- `discounts.limitOnePerCustomer` -- `.default(false)` without notNull
- `discounts.combineWithProductDiscounts` -- `.default(false)` without notNull
- `discounts.combineWithOrderDiscounts` -- `.default(false)` without notNull
- `discounts.combineWithShippingDiscounts` -- `.default(false)` without notNull
- `deliveryShipments.isFinalShipment` -- `.default(false)` without notNull

**Impact**: These columns can be NULL in the database even though defaults exist. Code checking `if (!row.banned)` would treat NULL as falsy (correct by accident), but `row.banned === false` would miss NULL rows. The Drizzle-inferred TypeScript types will include `| null`, which means consumers must handle the null case or risk type errors.

**Fix**: Add `.notNull()` to all boolean columns. Requires a migration with `ALTER TABLE ... SET DEFAULT` + `UPDATE ... SET col = 0 WHERE col IS NULL` for existing data.

---

**M2. `products.slug` and `pages.slug` lack UNIQUE constraints**

Both `products.slug` and `pages.slug` have indexes for lookup performance but no UNIQUE constraint. Slugs are used as URL path segments, so duplicates would cause routing collisions or unpredictable content resolution.

- `products`: has `index("products_slug_idx")` but no `.unique()`
- `pages`: has `index("pages_slug_idx")` but no `.unique()`
- `categories`: same pattern -- `index("categories_slug_idx")` without `.unique()`

**Contrast**: `productAttributes` correctly has both `.unique()` on the column AND a slug index.

**Fix**: Add unique indexes on `products(slug)`, `pages(slug)`, and `categories(slug)`. Verify no existing duplicates first.

---

**M3. Denormalized address fields on customers and orders**

Both `customers` and `orders` have 6 address-related columns: `city`, `zone`, `area`, `cityName`, `zoneName`, `areaName`. The `deliveryLocations` table exists with the canonical location data, but these columns store free-text copies rather than FK references.

- `orders` stores `city` and `zone` as bare text (IDs? names?) alongside `cityName`/`zoneName` display names
- `customers` duplicates the same pattern
- `customerHistory` duplicates it again

**Impact**: Address data can become stale if delivery locations are renamed. There is no referential integrity between the stored city/zone/area values and `deliveryLocations`. This is a conscious denormalization (orders should snapshot addresses at order time), but it is worth noting that neither table documents this intent in comments.

---

**M4. JSON-in-text columns without schema documentation**

Several columns store JSON as `text` without any inline documentation of the expected shape:

| Table | Column | JSON? |
|-------|--------|-------|
| `collections` | `config` | Yes -- dynamic collection rules |
| `heroSections` | `config` | Yes -- section layout config |
| `heroSliders` | `images` | Yes -- array of image objects |
| `pageTemplates` | `config` | Yes -- template layout config |
| `deliveryLocations` | `externalIds` | Yes -- provider-specific IDs |
| `deliveryLocations` | `metadata` | Yes -- provider-specific metadata |
| `deliveryProviders` | `credentials` | Yes -- encrypted provider credentials |
| `deliveryProviders` | `config` | Yes -- provider config |
| `deliveryShipments` | `metadata` | Yes -- shipment metadata |
| `deliveryShipments` | `shipmentItems` | Yes -- item IDs/quantities |
| `siteSettings` | `headerConfig` | Yes -- header layout |
| `siteSettings` | `footerConfig` | Yes -- footer layout |
| `siteSettings` | `socialLinks` | Yes -- social media links |
| `siteSettings` | `contactInfo` | Yes -- contact details |
| `checkoutLanguages` | `languageData` | Yes -- i18n strings |
| `checkoutLanguages` | `fieldVisibility` | Yes -- field visibility map |
| `abandonedCheckouts` | `checkoutData` | Yes -- full checkout snapshot |
| `orderPayments` | `metadata` | Yes -- payment provider metadata |

Only `productAttributes.options` uses Drizzle's `{ mode: "json" }` with a `$type<string[]>()` annotation. All others are bare `text()` columns that happen to store JSON.

**Impact**: No type safety at the schema level for these columns. Consumers must know the expected shape from context or separate validation files. An LLM working with this schema cannot infer what these JSON blobs contain.

**Recommendation**: At minimum, add JSDoc comments documenting the expected JSON shape for each column. For frequently-accessed configs, consider using `{ mode: "json" }.$type<T>()` so Drizzle infers the correct TypeScript type.

### Minor

**m1. Hardcoded production URL in data migration 0014**

Migration `0014_fix_media_urls.sql` hardcodes `https://cloud.wrygo.com/` as the CDN domain prefix. This migration is not idempotent and is tightly coupled to a specific production deployment.

**Impact**: If the codebase is deployed to a different environment with a different R2 domain, this migration would produce incorrect URLs. Since it only runs once and is already applied, the risk is low -- but it sets a precedent for environment-specific migrations.

---

**m2. `permissions.updatedAt` is nullable (lacks `notNull()`)**

In `rbac.ts`, `permissions.updatedAt` is defined as:
```typescript
updatedAt: integer("updated_at", { mode: "timestamp" }).default(UNIX_NOW),
```

This lacks `.notNull()`, unlike every other `updatedAt` column in the schema. Since this column was added retroactively in migration 0024 (`ALTER TABLE permissions ADD COLUMN updated_at INTEGER`), existing rows have NULL. But new rows should have it set.

---

**m3. `order_items.productId` has `onDelete: "set null"` but column is `.notNull()`**

```typescript
productId: text("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "set null" }),
```

If a product is deleted, the FK action would try to SET NULL on a NOT NULL column, which would fail at the database level. This is a constraint conflict.

**Note**: The same pattern exists for `inventoryMovements.variantId` -- `.notNull()` with `onDelete: "set null"`.

**Impact**: In practice, products are soft-deleted (not hard-deleted), so the CASCADE/SET NULL never fires. But if a hard delete ever occurs, it would produce a constraint violation error instead of the expected set-null behavior.

---

**m4. `discounts.code` is not UNIQUE**

The `discounts.code` column has an index for lookup performance but no UNIQUE constraint. Discount codes are typically expected to be unique identifiers for customers to enter at checkout.

**Note**: The application layer may enforce uniqueness, but the database does not guarantee it.

---

**m5. No `updatedAt` on several tables**

The following tables lack an `updatedAt` column:
- `orderItems` -- only has `createdAt`
- `inventoryMovements` -- append-only audit log, intentionally no update
- `customerHistory` -- append-only audit log, intentionally no update
- `discountProducts` -- junction table, intentionally no update
- `discountCollections` -- junction table, intentionally no update
- `discountUsage` -- append-only, intentionally no update
- `metaConversionsLogs` -- append-only, intentionally no update
- `webhookEvents` -- append-only, intentionally no update

Most of these are append-only or junction tables where the absence is justified. `orderItems` is the one that could reasonably need `updatedAt` since items have a mutable `fulfillmentStatus`.

---

**m6. `settings.type` column purpose is unclear**

The `settings` table has a `type` column that is `.notNull()` but its purpose is not documented. It sits alongside `key`, `value`, and `category`. Is it a data type hint (e.g., "string", "boolean", "json")? A setting type classification? Without documentation, consumers must guess.

---

**m7. Missing `InferInsertModel` exports**

All schema files export `InferSelectModel` types (read types) but none export `InferInsertModel` types (write types). Insert types would make it easier for service code to type-check insert payloads without manually computing which columns are optional.

---

**m8. `deliveryShipments` schema vs. migration drift**

The original migration 0000 creates `delivery_shipments.provider_id` as `NOT NULL`, but the current Drizzle schema defines it as nullable (no `.notNull()`). The `providerType` column was also added with `.default("manual")` but the migration has it as `NOT NULL` without a default. Later migrations may have adjusted this, but the drift between the original CREATE TABLE and the current schema definition means the Drizzle snapshot and actual DB could diverge on new environments.

---

**m9. Journal timestamp ordering anomaly**

Migration 0027 has `"when": 1773855484605` which is *before* migrations 0025 (`1773964800000`) and 0026 (`1774051200000`). The journal entries should be monotonically increasing. While Drizzle processes them by `idx` (which is correct), the out-of-order timestamps could cause confusion.

## Pattern Analysis

### Naming Conventions

**Table names**: Consistently `snake_case`, plural for entity tables (`products`, `orders`, `customers`), singular for singleton-like tables (`settings`, `site_settings`). Junction tables use domain prefixes (`role_permissions`, `discount_products`). This is clean and predictable.

**Column names**: Consistently `snake_case` in the database, `camelCase` in Drizzle schema definitions. The mapping is handled by Drizzle's column name parameter: `columnName: text("column_name")`. This is the standard Drizzle convention.

**Index names**: Follow `{table}_{column(s)}_idx` pattern consistently. Multi-column indexes concatenate column names: `products_active_idx`, `delivery_shipments_provider_status_idx`. A few use abbreviated prefixes: `pls_alerts_product_idx` (product low stock alerts).

**ID generation**: All primary keys are `text("id")` -- UUIDs or nanoids generated at the application layer. No auto-increment integers. This is appropriate for a distributed system (Cloudflare Workers) where auto-increment coordination would be costly.

### Type Patterns

- **Timestamps**: `integer("...", { mode: "timestamp" })` with `UNIX_NOW` default -- stored as epoch seconds
- **Booleans**: `integer("...", { mode: "boolean" })` -- SQLite integer 0/1
- **Money**: `real("price")` / `real("total_amount")` -- SQLite REAL (64-bit float). Acceptable for the BDT currency context but would need integer-cents for multi-currency precision
- **Enums**: `text("...", { enum: [...] })` -- SQLite TEXT with Drizzle enum validation
- **JSON**: Mostly bare `text()`, one instance of `text("...", { mode: "json" }).$type<T>()`
- **Soft delete**: `integer("deleted_at", { mode: "timestamp" })` nullable -- present on ~15 tables

### Relationship Patterns

- **1:N with cascade**: Parent deletion cascades to children (order -> orderItems, product -> productImages)
- **1:N with set null**: Reference preservation (order -> customer, product -> category)
- **Self-referential**: `deliveryLocations.parentId` and `mediaFolders.parentId` both use self-references with `set null`
- **M:N junction**: `discountProducts`, `discountCollections`, `rolePermissions`, `userRoles`, `userPermissions` -- all have composite unique constraints where appropriate

### Consistency Score

| Pattern | Tables Following | Tables Deviating | Score |
|---------|-----------------|-----------------|-------|
| `createdAt` present | 39/39 | 0 | 100% |
| `createdAt` notNull | 39/39 | 0 | 100% |
| `updatedAt` present | 31/39 | 8 (intentional) | 100% |
| Boolean notNull | 18/26 | 8 | 69% |
| Text PK (id) | 39/39 | 0 | 100% |
| UNIX_NOW default | 39/39 | 0 | 100% |
| FK indexes present | ~35/37 | ~2 | 95% |
| InferSelectModel export | 13/13 files | 0 | 100% |

## Migration Health

### Overview

- **28 migrations** (0000-0027), sequential with no gaps
- **Journal version**: 7, all entries version 6 dialect sqlite
- **Snapshots**: Present for all Drizzle-generated migrations (0000-0013, 0015, 0017, 0027)
- **Hand-written migrations**: 0014, 0016, 0019-0026 are manually authored SQL
- **No-op migration**: 0027 (`SELECT 1`) exists only to sync Drizzle's snapshot state

### Migration Categories

| Type | Migrations | Notes |
|------|-----------|-------|
| Schema creation | 0000 | Full initial schema |
| Feature additions | 0001-0013, 0015, 0017-0018 | Standard ALTER TABLE ADD COLUMN |
| Data fixes | 0014, 0026 | URL prefix fix, phone normalization |
| Index backfills | 0019, 0023, 0025 | Systematic index additions |
| Constraint additions | 0024 | Singleton keys, enum fixes |
| Optimistic locking | 0020, 0022 | Version columns |
| FTS5 setup | 0016 | Virtual tables + triggers |
| Snapshot sync | 0027 | No-op SELECT 1 |

### Destructive Operations

- **0016**: Drops and recreates all FTS5 tables and triggers (safe -- FTS tables are derived)
- **0014**: Data mutation (URL prefix) -- not reversible without backup
- **0026**: Data mutation (phone normalization) -- not reversible without backup
- **0024**: Data mutation (collection type rename) -- not reversible

All destructive operations are documented with comments and are appropriate for their purpose.

## Recommendations

### Priority 1 (Should fix)

1. **Add `notNull()` to all boolean columns** (M1): Write a migration that adds NOT NULL constraints and backfills NULLs to 0 for the 8 affected columns. SQLite requires table recreation for NOT NULL changes on existing columns, so this needs careful planning.

2. **Add UNIQUE constraints to slug columns** (M2): `products(slug)`, `categories(slug)`, `pages(slug)` should have unique indexes. Verify no duplicates exist in production first.

3. **Fix `notNull()` + `onDelete: "set null"` conflicts** (m3): Either remove `notNull()` from `orderItems.productId` and `inventoryMovements.variantId`, or change the FK action to `"cascade"` or `"restrict"`. Since products are soft-deleted, `"restrict"` may be most appropriate.

### Priority 2 (Should improve)

4. **Document JSON column shapes** (M4): Add JSDoc comments to all 18 JSON-in-text columns documenting the expected structure. Upgrade high-use columns to `{ mode: "json" }.$type<T>()`.

5. **Add `InferInsertModel` exports** (m7): Export insert types alongside select types to improve type safety for write operations.

6. **Make `discounts.code` UNIQUE** (m4): Add a unique constraint unless the business specifically allows duplicate codes.

7. **Add `notNull()` to `permissions.updatedAt`** (m2): Backfill existing NULL values with `createdAt` values, then add the constraint.

### Priority 3 (Nice to have)

8. **Document `settings.type` column** (m6): Add a comment explaining what values this column holds.

9. **Add `updatedAt` to `orderItems`** (m5): Since `fulfillmentStatus` is mutable, tracking when it changed is useful for auditing.

10. **Fix journal timestamp ordering** (m9): Future migrations should ensure `when` timestamps are monotonically increasing.

11. **Consider integer-cents for money columns**: The current `real()` type works for BDT but would need migration to `integer` (cents) for multi-currency support with currencies that require exact decimal arithmetic.

## File Inventory

| File | Purpose | Tables Defined |
|------|---------|---------------|
| `src/schema/shared.ts` | `UNIX_NOW` SQL helper | 0 |
| `src/schema/enums.ts` | Const enum objects + types | 0 |
| `src/schema/auth.ts` | Better Auth tables | 5 (user, session, account, verification, twoFactor) |
| `src/schema/rbac.ts` | RBAC tables | 5 (permissions, roles, rolePermissions, userRoles, userPermissions) |
| `src/schema/products.ts` | Product catalog | 9 (products, productImages, productVariants, categories, collections, productAttributes, productAttributeValues, productRichContent, mediaFolders, media) |
| `src/schema/customers.ts` | Customer domain | 2 (customers, customerHistory) |
| `src/schema/orders.ts` | Order domain | 7 (orders, orderItems, orderPayments, paymentPlans, codTracking, webhookEvents, abandonedCheckouts) |
| `src/schema/inventory.ts` | Inventory tracking | 2 (inventoryMovements, productLowStockAlerts) |
| `src/schema/delivery.ts` | Delivery/shipping | 3 (deliveryLocations, deliveryProviders, deliveryShipments) |
| `src/schema/marketing.ts` | Discounts + Meta CAPI | 6 (discounts, discountProducts, discountCollections, discountUsage, metaConversionsSettings, metaConversionsLogs) |
| `src/schema/content.ts` | CMS content | 6 (pages, widgets, widgetHistory, heroSections, heroSliders, pageTemplates) |
| `src/schema/system.ts` | Platform config | 6 (settings, siteSettings, analytics, adminFcmTokens, shippingMethods, checkoutLanguages) |
| `src/schema/index.ts` | Barrel re-export | -- |
| `src/client.ts` | Drizzle D1 client factory | -- |
| `src/types.ts` | Database type alias | -- |
| `drizzle.config.ts` | Drizzle Kit config | -- |
| `package.json` | Package manifest | -- |
| `tsconfig.json` | TypeScript config | -- |

**Total tables**: ~51 (39 regular + 8 FTS5 virtual + 4 FTS5 internal)
**Total migrations**: 28 (0000-0027)
**Total type exports**: 39 entity types

## LLM-Friendliness Score: 8/10

**Positives**:
- Table and column names are self-documenting (`customer_name`, `payment_status`, `fulfillment_status`)
- Enum constants with descriptive values (`"amount_off_products"`, `"pending"`, `"cancelled"`)
- Clean file-per-domain organization makes it easy to scope context
- Barrel export means `import * from "./schema"` gives complete visibility
- Type exports on every file enable immediate type inference
- The `UNIX_NOW` helper is well-documented with a comment explaining why it exists

**Deductions**:
- -1 point: 18 JSON-in-text columns with no documented shape -- an LLM cannot infer what `config`, `metadata`, or `checkout_data` contains without reading service code
- -0.5 point: The `settings.type` column and `deliveryLocations.externalIds` / `metadata` columns require domain knowledge to understand
- -0.5 point: The `city`/`zone`/`area` vs `cityName`/`zoneName`/`areaName` dual-column pattern on customers/orders is not immediately obvious (ID vs display name? both text?) without reading delivery location code
