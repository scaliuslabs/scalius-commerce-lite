# Database Schema & Migrations Re-Audit

**Re-Audit Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** `packages/database/` -- schema (13 files), client, migrations (31 total: 0000-0030)

---

## Previous Finding Status

### Critical Issue #1: Missing Drizzle Snapshots for Migrations 0019-0026

**Status: STILL OPEN**

- **Files:** `packages/database/migrations/meta/` -- snapshots exist for 0000-0018 and 0027-0029. The gap for 0019-0026 persists.
- **New wrinkle:** Migration 0030 (`0030_payment-idempotency-indexes.sql`) is hand-written and also has no snapshot file (`meta/0030_snapshot.json` does not exist). The gap is now 0019-0026 + 0030 (9 migrations without snapshots).
- **Impact unchanged:** Drizzle Kit cannot reconstruct schema state at those points. The next `drizzle-kit generate` may produce incorrect diffs or duplicate DDL.
- **The journal (`meta/_journal.json`) correctly tracks all 31 migrations (idx 0-30).**

### Critical Issue #2: `permissions.updatedAt` Nullable

**Status: FIXED**

- **File:** `packages/database/src/schema/rbac.ts:21-23`
- **Current code:**
  ```typescript
  updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(UNIX_NOW),
  ```
- The `.notNull()` is now present. Schema definition is consistent with all other tables.
- **Note:** No migration was generated for this fix -- the SQL-level column still lacks a NOT NULL constraint in production (the original `ALTER TABLE permissions ADD COLUMN updated_at INTEGER` from migration 0024 had no NOT NULL). However, Drizzle ORM always supplies the value at the application layer, so the practical risk is negligible.

### Critical Issue #3: `discountUsage.customerId` FK Missing `onDelete` Behavior

**Status: STILL OPEN**

- **File:** `packages/database/src/schema/marketing.ts:101`
- **Current code:**
  ```typescript
  customerId: text("customer_id").references(() => customers.id),
  // Still no onDelete specified -- defaults to "no action"
  ```
- Every other customer FK uses `onDelete: "set null"` or `onDelete: "cascade"`. This one is the sole exception.
- **Fix still needed:** Add `{ onDelete: "set null" }` and generate a table-recreate migration.

### Recommended #3: Missing `orders.deleted_at` Index

**Status: STILL OPEN**

- **File:** `packages/database/src/schema/orders.ts:58-63`
- The `orders` table has `deletedAt` column (line 57) but the indexes block (lines 58-63) has no `deleted_at` index. Every other soft-deletable table has one.
- The four existing indexes are: `orders_status_idx`, `orders_payment_status_idx`, `orders_customer_id_idx`, `orders_created_at_idx`.

### Recommended #5: Missing `mediaFolders.parent_id` Index

**Status: FIXED**

- **File:** `packages/database/src/schema/delivery.ts:27`
- Wait -- this was about `mediaFolders`, not `deliveryLocations`. Let me correct:
  - `delivery_locations_parent_id_idx` exists at `packages/database/src/schema/delivery.ts:27` -- this was already present before.
  - `mediaFolders` at `packages/database/src/schema/products.ts:200-211` -- still has NO indexes defined (no third argument to `sqliteTable`). The `parentId` FK column at line 203 has no index.
- **Status: STILL OPEN** for `mediaFolders.parent_id`.

### Recommended #7: Delete Stale `migrate-collections-data.ts`

**Status: FIXED**

- File no longer exists in `packages/database/migrations/`.

### Other Previous Recommendations (Status Unchanged)

| # | Recommendation | Status |
|---|---------------|--------|
| 4 | Re-sync Drizzle snapshots (0019-0026 gap) | STILL OPEN (gap now includes 0030) |
| 6 | Standardize legacy `CURRENT_TIMESTAMP` defaults | STILL OPEN -- 16 tables from migration 0000 still have `CURRENT_TIMESTAMP` as SQL default. Only 4 were recreated in 0028 (session, user, delivery_shipments, discounts). |
| 8 | Add Drizzle `relations()` definitions | STILL OPEN -- deliberate trade-off, low priority |
| 9 | Type the JSON columns with `{ mode: "json" }` | STILL OPEN -- 18 columns remain untyped |
| 10 | Add retention index to `inventory_movements` | PARTIALLY FIXED -- `inventory_movements_created_at_idx` now exists at `packages/database/src/schema/inventory.ts:33`, but composite `(created_at, type)` was not added. The single-column index still supports cleanup queries. |

---

## New Issues Found

### NEW-1: Migration 0030 Unique Indexes Not in Drizzle Schema (Schema-Migration Drift)

**Severity: Medium-High**

- **Migration:** `packages/database/migrations/0030_payment-idempotency-indexes.sql` creates three unique partial indexes:
  - `idx_order_payments_stripe_unique ON order_payments(order_id, stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL`
  - `idx_order_payments_sslcommerz_unique ON order_payments(order_id, sslcommerz_tran_id) WHERE sslcommerz_tran_id IS NOT NULL`
  - `idx_order_payments_polar_unique ON order_payments(order_id, polar_checkout_id) WHERE polar_checkout_id IS NOT NULL`
- **Schema:** `packages/database/src/schema/orders.ts:115-120` -- the `orderPayments` table defines only 4 non-unique indexes. None of the three new unique indexes appear in the Drizzle schema definition.
- **Impact:** The indexes exist in the live database (applied by migration) but Drizzle does not know about them. This causes:
  1. The next `drizzle-kit generate` will NOT include them in its snapshot, potentially generating a migration that drops them.
  2. No TypeScript-level documentation that these uniqueness constraints exist.
  3. Drizzle's introspection tools will not show them.
- **Fix approach:** Add the three unique indexes to the `orderPayments` table definition in `packages/database/src/schema/orders.ts`. Note: Drizzle ORM does not natively support partial indexes (`WHERE` clause). Options:
  - Add them as regular unique indexes (Drizzle syntax) and accept they'll differ slightly from the SQL.
  - Add them as comments documenting their existence.
  - Use `sql` raw expressions if Drizzle supports it for index definitions.

### NEW-2: Migration 0030 Data Cleanup is Destructive and Not Idempotent

**Severity: Low (migration already applied)**

- **File:** `packages/database/migrations/0030_payment-idempotency-indexes.sql:4-26`
- The migration DELETEs duplicate `order_payments` rows before creating unique indexes. While the DELETE logic is correct (keeps earliest record per combo), running this migration a second time would be safe only because `CREATE UNIQUE INDEX IF NOT EXISTS` prevents errors. However, the DELETE statements would still run, which is harmless (no duplicates exist after first run) but not guarded.
- **Impact:** Negligible -- D1 migration tracking prevents re-runs. But the pattern is worth noting.

### NEW-3: Migration 0030 Missing Snapshot File

**Severity: Medium**

- `packages/database/migrations/meta/0030_snapshot.json` does not exist.
- The journal (`meta/_journal.json`) includes entry idx 30 for `0030_payment-idempotency-indexes`.
- This extends the snapshot gap: 0019-0026 + 0030 = 9 migrations without snapshots.

### NEW-4: `inventoryMovements.variantId` FK is `.notNull()` but Uses `onDelete: "set null"`

**Severity: Low**

- **File:** `packages/database/src/schema/inventory.ts:18-19`
- **Code:**
  ```typescript
  variantId: text("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "set null" }),
  ```
- The column is marked `.notNull()`, but the FK uses `onDelete: "set null"`. If a variant is deleted, SQLite will attempt to set `variantId` to NULL, but the NOT NULL constraint will cause the DELETE to fail (FK constraint violation error).
- **Impact:** This effectively makes variant deletion impossible if any inventory movements reference it. This may be intentional (preventing data loss on audit records), but the `onDelete: "set null"` is misleading -- `onDelete: "restrict"` would express the actual behavior more clearly.
- **Fix approach:** Change to `onDelete: "restrict"` (or remove the onDelete clause entirely, since "no action" is equivalent here) to match the actual constraint behavior.

---

## Summary Table

| Finding | Previous Status | Current Status |
|---------|----------------|----------------|
| Missing snapshots 0019-0026 | OPEN | STILL OPEN (now includes 0030) |
| `permissions.updatedAt` nullable | OPEN | **FIXED** (schema only, no migration) |
| `discountUsage.customerId` missing onDelete | OPEN | STILL OPEN |
| Missing `orders.deleted_at` index | OPEN | STILL OPEN |
| Missing `mediaFolders.parent_id` index | OPEN | STILL OPEN |
| Stale `migrate-collections-data.ts` | OPEN | **FIXED** (deleted) |
| Legacy CURRENT_TIMESTAMP defaults | OPEN | STILL OPEN (12 of 16 tables remain) |
| `inventory_movements` retention index | OPEN | **PARTIALLY FIXED** (created_at index added) |
| Migration 0030 unique indexes not in schema | -- | **NEW** (medium-high) |
| `inventoryMovements.variantId` conflicting constraints | -- | **NEW** (low) |

---

## Rating: 7.5/10

**Previous rating equivalent: ~7/10.** The fix session addressed 2.5 of the 10 recommendations (permissions.updatedAt fixed, stale script deleted, partial inventory index). The core schema remains solid. The new migration 0030 adds valuable payment idempotency but introduces schema-migration drift (the unique partial indexes exist only in SQL, not in the Drizzle schema definition). The snapshot gap has widened from 8 to 9 missing files. The `discountUsage.customerId` onDelete gap and `orders.deleted_at` missing index persist as the most actionable remaining items.

**Improvement from previous audit:** +0.5 points for permissions fix, stale script cleanup, and the new idempotency indexes (even if not reflected in schema).

**What would reach 9/10:**
1. Fix `discountUsage.customerId` onDelete (table recreate migration)
2. Add `orders.deleted_at` index
3. Reflect migration 0030's unique indexes in the Drizzle schema
4. Re-sync snapshots for 0019-0026 + 0030
5. Add `mediaFolders.parent_id` index

---

*Re-audit: 2026-03-21*
