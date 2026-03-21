---
phase: 01-bengali-fts5-search
plan: 01
subsystem: database
tags: [fts5, unicode61, bengali, sqlite, search, tokenizer, migration]

# Dependency graph
requires: []
provides:
  - Bengali-safe FTS5 tokenizer migration (0031) for 5 content tables
  - Hardened query sanitizer with Bengali danda punctuation stripping
affects: [01-02-PLAN (validation), storefront search, admin search]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "FTS5 unicode61 tokenizer with categories 'L* N* Co Mc Mn' for Bengali script support"
    - "Bengali danda characters (U+0964, U+0965) stripped from search queries"

key-files:
  created:
    - packages/database/migrations/0031_bengali_fts5_tokenizer.sql
  modified:
    - packages/database/migrations/meta/_journal.json
    - packages/core/src/search/fts5.ts

key-decisions:
  - "Preserved all 20 triggers identically from migration 0016 to avoid any behavioral changes"
  - "Only touched 5 Bengali-content FTS tables; left 3 ASCII-only tables unchanged"

patterns-established:
  - "FTS5 migration pattern: DROP triggers -> DROP tables -> CREATE with tokenizer -> CREATE triggers -> REBUILD"

requirements-completed: [BEN-04]

# Metrics
duration: 3min
completed: 2026-03-22
---

# Phase 01 Plan 01: Bengali FTS5 Tokenizer Migration Summary

**FTS5 unicode61 tokenizer migration for 5 Bengali-content tables with Mc/Mn category preservation and danda-safe query sanitizer**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-21T21:28:48Z
- **Completed:** 2026-03-21T21:31:21Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Created migration 0031 that reconfigures 5 FTS5 tables (products, categories, pages, orders, customers) with unicode61 tokenizer preserving Bengali combining marks (Mc/Mn categories)
- Added Bengali Danda (U+0964) and Double Danda (U+0965) to the FTS5 query sanitizer regex to prevent parse errors
- All 20 triggers preserved identically from migration 0016 with no behavioral changes

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Bengali FTS5 tokenizer migration** - `18e9e8a` (feat)
2. **Task 2: Harden FTS5 query sanitizer with Bengali punctuation** - `27f07d1` (feat)

## Files Created/Modified
- `packages/database/migrations/0031_bengali_fts5_tokenizer.sql` - Migration SQL that drops and recreates 5 FTS5 virtual tables with Bengali-safe unicode61 tokenizer, preserves all triggers, and rebuilds indexes
- `packages/database/migrations/meta/_journal.json` - Added entry for migration 0031
- `packages/core/src/search/fts5.ts` - Added Bengali danda characters to FTS5_SPECIAL_CHARS regex

## Decisions Made
- Preserved all 20 triggers identically from migration 0016 -- triggers do not need tokenizer changes, only the CREATE VIRTUAL TABLE definitions do
- Left 3 ASCII-only FTS tables (product_variants_fts, discounts_fts, abandoned_checkouts_fts) untouched since they contain no Bengali content
- Used `remove_diacritics 2` in tokenizer config for maximum normalization compatibility

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Migration file is ready for local D1 validation (Plan 01-02)
- Query sanitizer is ready for Bengali search testing
- All typecheck passes confirmed

---
*Phase: 01-bengali-fts5-search*
*Completed: 2026-03-22*
