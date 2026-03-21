# Database & Data Layer Audit

## Executive Summary

The database layer (`@scalius/database`) is well-organized for a single-tenant Cloudflare D1 (SQLite) commerce platform. 40 tables across 11 domain-specific schema files use consistent patterns: text primary keys with prefixed nanoid, integer Unix timestamps via `UNIX_NOW`, comprehensive soft-delete support, and Drizzle ORM throughout. The recent hardening sprint (migrations 0019-0030) closed significant gaps in FK indexing, singleton constraints, payment idempotency, and optimistic locking.

Strengths: domain-organized schema files, thorough FTS5 integration, defensive optimistic locking for inventory, atomic `db.batch()` usage for multi-table writes, comprehensive index coverage. The system handles concurrency well for a single-tenant deployment.

Weaknesses: SQLite's lack of runtime FK enforcement (D1 does not enable `PRAGMA foreign_keys`), heavy reliance on `text()` for JSON columns without schema-level validation, some denormalized address fields duplicated across orders/customers, no Drizzle relations defined (preventing relational query API), and the `db.batch()` typing workaround (`as any`) creates a maintenance burden. Several enum-like columns use inline strings without a centralized source of truth.

---

## Ratings

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Maintainability** | 8/10 | Clean 11-file domain split, barrel re-export, shared helpers, excellent README. Deducted for `as any` batch casts and JSON columns lacking schema-level typing. |
| **Robustness** | 6/10 | FK constraints defined in Drizzle schema but NOT enforced at runtime by D1 (no `PRAGMA foreign_keys=ON`). Optimistic locking on orders and inventory is solid. Missing CHECK constraints on numeric ranges and enum columns. Singleton tables use unique indexes but no DB-level enforcement beyond that. |
| **Code Quality** | 7/10 | Consistent Drizzle usage, proper type exports via `InferSelectModel`, centralized enums. Deducted for pervasive `as any` casts on `db.batch()`, some raw SQL string interpolation, and inconsistent enum usage (centralized vs inline). |
| **Scalability** | 5/10 | Single-tenant D1 (SQLite) architecture. No connection pooling needed (D1 is serverless), but no partitioning strategy, no read replicas, no sharding. `inventoryMovements` and `metaConversionsLogs` will grow unbounded. 40 FTS5 triggers add write amplification on every INSERT/UPDATE/DELETE of indexed tables. |
| **Performance** | 8/10 | Thorough index coverage after migrations 0019-0030. FTS5 for search avoids LIKE scans. Smart use of `db.batch()` to minimize D1 round-trips. Composite indexes on hot queries (orders status+date, products active+deleted). Some dashboard queries use full-table aggregations that will slow down at scale. |
| **Feature Readiness** | 8/10 | Adding new tables is straightforward (schema file + `pnpm db:generate`). CLAUDE.md documents the recipe. The enum pattern is extensible. The batch-oriented write pattern is well-established. Deducted because adding Drizzle relations retroactively would be a significant lift. |

**Overall: 7.0/10**

---

## Detailed Findings

### Strengths

#### 1. Domain-Organized Schema (Excellent)
The 11 schema files map cleanly to business domains: auth, rbac, products, customers, orders, inventory, delivery, marketing, content, system. Each file is self-contained with its own table definitions, FK references, indexes, and `InferSelectModel` type exports. The barrel `index.ts` re-exports everything.

Key files:
- `/packages/database/src/schema/index.ts` -- barrel export
- `/packages/database/src/schema/shared.ts` -- `UNIX_NOW` helper
- `/packages/database/src/schema/enums.ts` -- centralized enum constants

#### 2. Consistent Timestamp Pattern
Every table uses `integer("column_name", { mode: "timestamp" })` with `.default(UNIX_NOW)` for `createdAt`/`updatedAt`. This ensures:
- Storage as Unix epoch seconds (not ISO strings in integer columns)
- Drizzle auto-converts to/from JS `Date` objects
- SQLite-native defaults via `strftime('%s','now')`

The initial migration (0000) had `DEFAULT CURRENT_TIMESTAMP` on some tables (storing ISO strings into integer columns), but this was corrected via later migrations standardizing to `UNIX_NOW`.

#### 3. Comprehensive Index Coverage
After the hardening sprint (migrations 0019, 0023, 0025, 0029), index coverage is thorough:
- All FK columns have indexes (session.userId, account.userId, orderItems.orderId, etc.)
- Soft-delete columns (`deletedAt`) are indexed on every table that uses them
- Composite indexes on hot query patterns: `products(isActive, deletedAt)`, `widgets(displayTarget, isActive, deletedAt)`, `deliveryShipments(providerId, status)`
- Unique indexes: `products.slug`, `productVariants.sku`, `discounts.code`, `categories.slug`, `pages.slug`
- Payment idempotency: unique partial indexes on `orderPayments` for each gateway's transaction ID per order (migration 0030)

#### 4. FTS5 Full-Text Search Integration
Migration 0016 creates FTS5 virtual tables for 8 entities (products, variants, categories, pages, orders, customers, discounts, abandoned_checkouts). Uses external content mode (`content='table_name'`) so no data duplication. Four triggers per table (AFTER INSERT, BEFORE DELETE, BEFORE UPDATE, AFTER UPDATE) keep the FTS index in sync. Search is used via `ftsMatch()` helper in `@scalius/core/search/fts5.ts`.

#### 5. Optimistic Locking for Concurrency
Two separate version fields on `productVariants`:
- `version` -- general row-level OAS (optimistic locking)
- `stockVersion` -- stock-specific CAS (compare-and-swap) used by inventory operations

Orders have a `version` field for CAS-based concurrent edit detection (see `orders.admin.ts:updateOrder`).

The inventory `reserve.ts` implements full CAS with retry (3 attempts, exponential backoff), both sequential (`reserveStock`) and batched (`reserveStockBatch` via `db.batch()`).

#### 6. Atomic Batch Writes
All multi-table writes use D1's `db.batch()` for atomicity:
- Order creation (customer + order + items + discount usage)
- Product creation/update (product + images + rich content + attributes)
- Payment processing (payment record + order update + inventory)
- Queue order ingest (batches multiple orders into a single atomic write)

#### 7. Singleton Table Pattern
`siteSettings` and `metaConversionsSettings` use a `singletonKey` column with a unique index (migration 0024/0029) to enforce single-row semantics at the DB level.

#### 8. Thorough Documentation
The `README.md` at 294 lines documents every table, JSON column shape, entity ID prefix, timestamp pattern, migration history, and known gaps. This is exceptional for an internal package.

---

### Weaknesses

#### 1. FK Constraints Not Enforced at Runtime (Critical)
**Files affected**: All schema files

Drizzle's `.references()` generates `REFERENCES` clauses in `CREATE TABLE` DDL, but Cloudflare D1 does not enable `PRAGMA foreign_keys=ON` by default. This means:
- CASCADE deletes do NOT execute
- SET NULL on delete does NOT execute
- Orphaned records can and will accumulate

The codebase compensates by manually handling cascades in service code (e.g., `permanentlyDeleteProduct` explicitly deletes variants, images, attributes, and rich content before the product). But this is fragile -- any new delete path that forgets to cascade will silently create orphans.

**Impact**: Data integrity depends entirely on application-level discipline. No DB-level safety net.

#### 2. JSON Columns Without Schema-Level Validation
**Files affected**: `products.ts`, `content.ts`, `delivery.ts`, `system.ts`

Multiple columns store JSON as plain `text()`:
- `collections.config` -- collection query configuration
- `siteSettings.headerConfig`, `footerConfig`, `socialLinks`, `contactInfo` -- complex nested JSON
- `deliveryProviders.credentials`, `config` -- provider-specific shapes
- `deliveryShipments.metadata`, `shipmentItems` -- arbitrary JSON
- `deliveryLocations.externalIds`, `metadata` -- provider-specific data
- `heroSections.config`, `pageTemplates.config` -- opaque configuration
- `checkoutLanguages.languageData`, `fieldVisibility` -- i18n data

Only `productAttributes.options` uses Drizzle's `mode: "json"` with a `$type<string[]>()` annotation. All others are untyped `text()`. The README documents expected shapes, but there is no compile-time or insert-time validation.

**Recommendation**: Use `.$type<T>()` annotations on all JSON columns. Add Zod schemas for critical JSON columns in validation layer.

#### 3. No Drizzle Relations Defined
**Files affected**: All schema files

None of the schema files define Drizzle `relations()` objects. This means:
- The Drizzle relational query API (`db.query.products.findMany({ with: { variants: true } })`) is unavailable
- All joins must use the lower-level `db.select().from().leftJoin()` API
- Service code manually reconstructs parent-child relationships (e.g., `getProductDetails` runs 4 separate queries and `Promise.all`s them)

While the current query patterns work, defining relations would:
- Enable type-safe eager loading
- Reduce boilerplate in service code
- Make the ORM aware of the entity graph for future tooling

#### 4. Denormalized Address Fields
**Files affected**: `customers.ts`, `orders.ts`

Both `customers` and `orders` store:
- `city`, `zone`, `area` (location IDs)
- `cityName`, `zoneName`, `areaName` (display names)

Orders denormalize customer data (name, phone, email, address) by design (correct for order snapshots), but the name fields are resolved at write-time from `deliveryLocations` and baked into the record. If a location name changes, historical records will be inconsistent with the current name -- which is actually correct for orders (snapshot semantics) but problematic for customers whose address display names should stay current.

#### 5. Pervasive `as any` Casts on `db.batch()`
**Files affected**: Every service file that uses batch writes

D1's `db.batch()` requires a specific tuple type signature that Drizzle cannot satisfy with dynamically-constructed arrays. Every batch call uses:
```typescript
await db.batch(writeBatch as any);
```

This suppresses type checking on the entire batch array, meaning:
- Type errors in individual statements are invisible
- Refactoring column names won't catch batch query breakage
- 15+ occurrences across the codebase

**Recommendation**: Create a typed `safeBatch()` wrapper that accepts a `readonly` tuple and handles the D1 typing limitation in one place.

#### 6. Mixed Enum Strategies
**Files affected**: `enums.ts`, `products.ts`, `content.ts`, `delivery.ts`, `system.ts`

Some enum-like columns use the centralized `enums.ts` constants:
- `orders.status` -> `OrderStatus` enum
- `orders.paymentMethod` -> `PaymentMethod` enum
- `discounts.type` -> `DiscountType` enum

Others use inline string arrays in the schema:
- `products.discountType` -> `["percentage", "flat"]`
- `productVariants.barcodeType` -> `["ean13", "upc", "isbn", "gtin", "custom"]`
- `heroSliders.type` -> `["desktop", "mobile"]`
- `siteSettings.checkoutMode` -> `["guest_cod_only", "gateways_only", "all"]`
- `orderPayments.status` -> just a `text()` with comment "pending | confirmed | failed | refunded | cancelled"
- `codTracking.codStatus` -> just a `text()` with comment "pending | collected | failed | returned"

The inconsistency means some columns have type-safe insertion while others accept any string.

#### 7. No CHECK Constraints
SQLite supports CHECK constraints, but none are defined:
- `productVariants.stock` can go negative (only prevented by application logic)
- `productVariants.reservedStock` can go negative (the `MAX(0, ...)` guard is in SQL but not a constraint)
- `orders.totalAmount` can be negative
- `discounts.discountValue` has no range validation
- `orderItems.quantity` has no minimum check

#### 8. Unbounded Growth Tables
No retention policy or archival strategy for:
- `inventoryMovements` -- every stock operation logs a row (6+ per order lifecycle)
- `metaConversionsLogs` -- every Meta CAPI event logged with full request/response payloads
- `webhookEvents` -- every webhook from every provider
- `customerHistory` -- every customer create/update/delete
- `widgetHistory` -- every widget revision

`metaConversionsSettings.logRetentionDays` exists (default 30) but there is no scheduled cleanup job.

---

### Critical Issues

#### Issue 1: FK Cascade Non-Enforcement
**Severity**: High
**Location**: All tables with `.references()` and `{ onDelete: "cascade" }` or `{ onDelete: "set null" }`

The schema declares 25+ FK relationships with cascade/set-null behavior. None of these are enforced by D1. Example: deleting a product does NOT cascade-delete its `productImages`, `productVariants`, `productAttributeValues`, or `productRichContent` rows. The service layer handles this manually, but:
- `deleteProduct()` only soft-deletes (sets `deletedAt`) -- child rows are not touched
- `permanentlyDeleteProduct()` explicitly deletes children, but only handles 4 of 5 possible child tables (does not delete `inventoryMovements` referencing variants of the product, though those use `onDelete: "restrict"` anyway)

If any code path deletes a parent row without the application-level cascade, orphans will accumulate silently.

#### Issue 2: `twoFactor` Table Missing FK Index
**Severity**: Low
**Location**: `/packages/database/src/schema/auth.ts:93`

The `twoFactor` table has `userId` referencing `user.id` with `onDelete: "cascade"`, but unlike `session` and `account`, it has NO index on `userId`. While the table is small (one row per user at most), lookups by userId during 2FA verification will require a full table scan.

#### Issue 3: `discountUsage` Missing Index for Per-Order Lookup
**Severity**: Medium
**Location**: `/packages/database/src/schema/marketing.ts:93-108`

The `discountUsage` table has a composite index on `(discountId, customerId)` but no index on `orderId`. The service code joins on `orderId` in the queue handler (`orders.queue.ts:268`) and in eligibility checks. With high discount usage volume, these joins will degrade.

#### Issue 4: `deliveryLocations.type` Column Missing Index
**Severity**: Low
**Location**: `/packages/database/src/schema/delivery.ts:12`

The `deliveryLocations` table is queried by `type` for the cascading city/zone/area dropdowns (storefront + admin). Only `parentId` is indexed. Type-based queries will require full table scan.

#### Issue 5: `orders` Table Missing Composite Index for Dashboard Aggregations
**Severity**: Medium
**Location**: `/packages/core/src/modules/analytics/dashboard.service.ts`

Dashboard queries aggregate orders by `createdAt` range, `deletedAt IS NULL`, and `status NOT IN (...)`. The current indexes cover `status`, `createdAt`, and `deletedAt` individually, but the compound query `WHERE deletedAt IS NULL AND createdAt >= ? AND status NOT IN (...)` would benefit from a composite index on `(deletedAt, createdAt, status)`.

#### Issue 6: `bulkDeleteOrders` N+1 Pattern
**Severity**: Medium
**Location**: `/packages/core/src/modules/orders/orders.admin.ts:884-902`

`bulkDeleteOrders` loops over each orderId with a sequential SELECT + applyInventoryForStatusChange. For bulk operations on 50+ orders, this creates 100+ sequential DB round-trips. Should batch-read all orders, then batch-process inventory.

---

### File-by-File Notes

#### `packages/database/src/client.ts`
- Module-level singleton pattern is correct for D1 (no per-connection cost)
- The `Proxy` legacy export is clever but creates a runtime error if middleware order is wrong
- No way to reset the singleton for testing -- would need a `resetDb()` function

#### `packages/database/src/schema/auth.ts`
- Well-structured Better Auth schema
- Missing: `twoFactor` table lacks userId index (see Issue 2)
- `session.token` is unique-indexed (good for token lookup)
- `verification.identifier` is indexed (good for lookup by email/phone)

#### `packages/database/src/schema/rbac.ts`
- Clean many-to-many junction tables with proper unique constraints
- All FK columns indexed
- `assignedBy` FK on `userRoles`/`userPermissions` uses `onDelete: "set null"` (correct -- don't cascade-delete role assignments when an admin is deleted)

#### `packages/database/src/schema/products.ts`
- `products.slug` unique index prevents duplicates
- `productVariants.sku` unique index prevents duplicate SKUs
- `productImages` has composite index on `(productId, isPrimary)` for efficient primary image lookups
- `mediaFolders.parentId` uses `(): any =>` cast for self-referential FK (Drizzle limitation, acceptable)
- `productAttributes.options` correctly uses `mode: "json"` with `$type<string[]>()`

#### `packages/database/src/schema/orders.ts`
- Most heavily indexed table (5 indexes + payment gateway indexes)
- `paymentPlans.orderId` and `codTracking.orderId` are unique (correct for 1:1)
- `orderPayments` has excellent gateway-specific column design (nullable columns per provider)
- `abandonedCheckouts.checkoutId` unique constraint prevents duplicate checkout saves
- `webhookEvents` has no unique constraint on `(provider, id)` -- relies on PK

#### `packages/database/src/schema/inventory.ts`
- `inventoryMovements.variantId` uses `onDelete: "restrict"` -- correctly prevents deleting variants with movement history
- `productLowStockAlerts.variantId` is unique (one alert per variant, correct)
- Missing: no index on `inventoryMovements.type` for filtering by movement type

#### `packages/database/src/schema/delivery.ts`
- `deliveryShipments` has composite index on `(providerId, status)` for provider-filtered status queries
- `externalId` index supports webhook lookups by provider's external ID
- `deliveryLocations` uses self-referential FK for city/zone/area hierarchy
- Missing: no index on `deliveryLocations.type` (see Issue 4)

#### `packages/database/src/schema/marketing.ts`
- `discounts.code` unique index prevents duplicate codes
- `discountUsage` composite index on `(discountId, customerId)` supports per-customer limit checks
- `metaConversionsLogs.eventId` unique constraint prevents duplicate event logging
- Missing: `discountUsage.orderId` index (see Issue 3)

#### `packages/database/src/schema/content.ts`
- `widgets` has well-designed composite index on `(displayTarget, isActive, deletedAt)` for storefront widget queries
- `widgetHistory` cascades on widget delete (correct)
- `heroSections` and `pageTemplates` lack deleted_at (no soft-delete capability)

#### `packages/database/src/schema/system.ts`
- `settings` uses composite unique on `(key, category)` -- clean KV pattern
- `siteSettings` singleton enforced via unique index on `singletonKey`
- `shippingMethods.name` unique constraint prevents duplicate method names
- `checkoutLanguages.code` unique constraint prevents duplicate language codes
- Missing: `checkoutLanguages` has no `deletedAt` index (has `deletedAt` column but no soft-delete index)

#### Migration Strategy (0000-0030)
- 31 migrations, well-organized with descriptive names
- Hybrid approach: Drizzle-generated (0000-0013, 0015, 0017, 0027-0029) and hand-written (0014, 0016, 0018-0026, 0030)
- All hand-written migrations use `IF NOT EXISTS` guards for idempotency
- Migration 0030 includes data cleanup (DELETE duplicates) before creating unique partial indexes -- safe and correct
- The journal file tracks all entries with timestamps and breakpoints

---

## Recommendations

### High Priority

1. **Add missing indexes**:
   - `twoFactor(userId)` -- for 2FA verification lookups
   - `discountUsage(orderId)` -- for order-level discount queries
   - `deliveryLocations(type)` -- for type-filtered location queries
   - `orders(deletedAt, createdAt, status)` composite -- for dashboard aggregations

2. **Audit all delete paths for orphan prevention**: Since D1 does not enforce FK cascades, grep the entire codebase for `db.delete()` calls and verify each one handles child records. Consider adding a `cascadeDelete()` utility function per domain.

3. **Fix `bulkDeleteOrders` N+1**: Batch-read all affected orders in one query, then process inventory in bulk.

4. **Centralize remaining enum-like columns**: Move `orderPayments.status`, `codTracking.codStatus`, `paymentPlans.status`, `deliveryShipments.status`, and `productLowStockAlerts.alertStatus` to `enums.ts` as const objects.

### Medium Priority

5. **Define Drizzle relations**: Add `relations()` definitions for all FK relationships. This enables `db.query.*.findMany({ with: { ... } })` and documents the entity graph in code.

6. **Type JSON columns**: Add `.$type<T>()` on all JSON `text()` columns to at least document the expected shape at the schema level. Critical columns: `siteSettings.headerConfig`, `siteSettings.footerConfig`, `collections.config`, `deliveryProviders.credentials`.

7. **Create typed `safeBatch()` wrapper**: Replace the 15+ `as any` casts with a single utility that handles the D1 batch typing limitation:
   ```typescript
   export function safeBatch(db: Database, statements: unknown[]) {
     return db.batch(statements as [any, ...any[]]);
   }
   ```

8. **Add data retention cleanup job**: Implement a scheduled worker (or queue-triggered) cleanup for `inventoryMovements`, `metaConversionsLogs`, `webhookEvents`, and `widgetHistory`. The `logRetentionDays` field on `metaConversionsSettings` already exists but has no implementation.

### Low Priority

9. **Add CHECK constraints where possible**: While D1 may not enforce all CHECK constraints, adding them documents intent and may be enforced in future D1 versions:
   - `productVariants.stock >= 0`
   - `productVariants.reservedStock >= 0`
   - `orderItems.quantity > 0`
   - `discounts.discountValue > 0`

10. **Consider separate `addresses` table**: The duplicated address fields (city, zone, area, cityName, zoneName, areaName) across customers and orders could be normalized into an `addresses` table with a polymorphic reference. However, this would complicate the order snapshot pattern and may not be worth the migration cost.

11. **Add `resetDb()` for testing**: The module-level singleton in `client.ts` has no reset mechanism, making it difficult to test with different D1 instances.

12. **Document migration strategy more formally**: The hybrid Drizzle-generated + hand-written approach works well but should have a CONTRIBUTING section explaining when to use which approach (especially for FTS5 changes, partial indexes, and data migrations).
