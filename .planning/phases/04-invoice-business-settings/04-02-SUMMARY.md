---
phase: 04-invoice-business-settings
plan: 02
subsystem: database, api
tags: [drizzle, sqlite, d1, migration, cas, invoice, sequential-counter]

requires:
  - phase: none
    provides: none
provides:
  - invoiceNumber column on orders table with partial unique index
  - Invoice numbering service with CAS-based sequential counter
  - formatInvoiceNumber and getOrAssignInvoiceNumber exports
affects: [04-03, 04-04]

tech-stack:
  added: []
  patterns: [CAS counter via settings table with returning() for conflict detection, partial unique index for nullable unique columns]

key-files:
  created:
    - packages/core/src/modules/orders/invoice.service.ts
    - packages/database/migrations/0032_lyrical_adam_warlock.sql
  modified:
    - packages/database/src/schema/orders.ts

key-decisions:
  - "Stripped Drizzle-generated drift artifacts from migration to keep it safe and minimal"
  - "Used .returning() instead of rowsAffected for CAS conflict detection (D1 type compatibility)"

patterns-established:
  - "CAS counter pattern: read value, update with WHERE guard on old value, use .returning() to detect conflict"
  - "Partial unique index pattern: added manually to migration SQL since Drizzle cannot express WHERE clauses in indexes"

requirements-completed: [INV-05]

duration: 4min
completed: 2026-03-22
---

# Phase 04 Plan 02: Invoice Number Schema & Service Summary

**Nullable invoice_number column on orders with partial unique index, plus CAS-based sequential numbering service**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-21T22:08:13Z
- **Completed:** 2026-03-21T22:12:48Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Added nullable `invoice_number` integer column to orders table
- Generated and applied migration 0032 with partial unique index (allows multiple NULLs)
- Created invoice service with idempotent `getOrAssignInvoiceNumber` (returns existing or assigns next)
- CAS counter in settings table with single-retry on conflict
- Configurable prefix resolution: provided arg > business_info setting > default "INV"

## Task Commits

Each task was committed atomically:

1. **Task 1: Add invoice_number column to orders schema and generate migration** - `9727b90` (feat)
2. **Task 2: Create invoice numbering service with CAS counter** - `a4c16ea` (feat)

## Files Created/Modified
- `packages/database/src/schema/orders.ts` - Added invoiceNumber column to orders table definition
- `packages/database/migrations/0032_lyrical_adam_warlock.sql` - ALTER TABLE + partial unique index migration
- `packages/core/src/modules/orders/invoice.service.ts` - Invoice numbering service with CAS counter

## Decisions Made
- Stripped Drizzle-generated drift artifacts (table recreations for inventory_movements, discount_usage, permissions) from migration to prevent NOT NULL constraint failures on existing data
- Used `.returning({ id: settings.id })` for CAS conflict detection instead of casting to `{ rowsAffected }` for D1 type safety

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Stripped Drizzle migration drift artifacts**
- **Found during:** Task 1
- **Issue:** `pnpm db:generate` produced table recreation statements for unrelated tables (inventory_movements, discount_usage, permissions) due to schema drift detection. The permissions recreation failed with NOT NULL constraint on `updated_at` because existing rows had NULL values.
- **Fix:** Rewrote migration to contain only the actual change: `ALTER TABLE orders ADD invoice_number` and the partial unique index
- **Files modified:** packages/database/migrations/0032_lyrical_adam_warlock.sql
- **Verification:** `pnpm db:migrate:local` succeeded
- **Committed in:** 9727b90

**2. [Rule 1 - Bug] Fixed D1 result type for CAS conflict detection**
- **Found during:** Task 2
- **Issue:** Casting update result to `{ rowsAffected }` caused TS2352 error because D1Result does not have that property
- **Fix:** Used `.returning({ id: settings.id })` and checked array length instead
- **Files modified:** packages/core/src/modules/orders/invoice.service.ts
- **Verification:** `pnpm typecheck` passed with 0 errors
- **Committed in:** a4c16ea

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes necessary for migration to apply and types to compile. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Invoice number column and service ready for API route integration (Plan 03)
- `getOrAssignInvoiceNumber` ready to be called from invoice generation endpoint
- `formatInvoiceNumber` ready for invoice template rendering

## Self-Check: PASSED

All files verified present. All commit hashes verified in git log.

---
*Phase: 04-invoice-business-settings*
*Completed: 2026-03-22*
