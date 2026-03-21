# Collections Domain Re-Audit

**Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** Same vertical slice -- schema, core service, API routes (admin + public), admin UI, storefront client, storefront service.

---

## Previous Findings Status

### Issue 1: `new Date()` produces wrong timestamps in D1
**Status:** FIXED

All 7 instances of `new Date()` in `packages/core/src/modules/collections/collections.service.ts` have been replaced with `sql\`(unixepoch())\``. Every mutation now uses the correct pattern:

- `updateCollection` line 129: `updatedAt: sql\`(unixepoch())\``
- `deleteCollection` line 149: `deletedAt: sql\`(unixepoch())\``, `updatedAt: sql\`(unixepoch())\``
- `bulkDeleteCollections` line 165: same
- `bulkActivateCollections` line 175: same
- `bulkDeactivateCollections` line 184: same
- `restoreCollections` line 193: same
- `reorderCollections` line 206: same

### Issue 2: `updateCollection` silently succeeds on non-existent IDs
**Status:** FIXED

`packages/core/src/modules/collections/collections.service.ts` lines 126-127 now check existence before updating:

```typescript
const existing = await db.select({ id: collections.id }).from(collections).where(eq(collections.id, id)).get();
if (!existing) throw new NotFoundError("Collection not found");
```

The `NotFoundError` is imported from `@scalius/core/errors` (line 9).

### Issue 3: Storefront type includes phantom `"AllCategories"` enum value
**Status:** STILL OPEN

`apps/storefront/src/lib/api/types.ts` line 193 still contains:

```typescript
type: "manual" | "dynamic" | "AllCategories";
```

Neither the DB schema, Zod validation, nor entity schema support `"AllCategories"`. No functional impact but confusing for consumers.

### Issue 4: Storefront SDK client uses `as any` casts
**Status:** PARTIALLY FIXED

`apps/storefront/src/lib/api/collections.ts` now uses the `unwrapData` helper from `apps/storefront/src/lib/api/unwrap.ts` instead of raw `(data as any)?.data`. The pattern is cleaner:

```typescript
return unwrapData<{ collections: Collection[] }>(data)?.collections ?? null;
```

However, `getCollectionById` (line 63) still uses `collection: any` in its generic parameter:

```typescript
const d = unwrapData<{ collection: any; categories?: CategorySummary[]; ... }>(data);
```

This single `any` is localized and the `as CollectionWithProducts` cast on line 70 restores typing downstream. Minor improvement possible when SDK types are fully aligned.

### Issue 5: `CollectionRow` uses `& any` in forwardRef generic
**Status:** STILL OPEN

`apps/admin/src/components/admin/collections-list/components/CollectionRow.tsx` lines 23-25 still use:

```typescript
export const CollectionRow = forwardRef<
  HTMLTableRowElement,
  CollectionRowProps & any
>(
```

### Issue 6: API route `sort` uses unsafe type cast
**Status:** STILL OPEN

`apps/api/src/routes/admin/collections.ts` line 101 still uses:

```typescript
sort: q.sort as "name" | "type" | "isActive" | "updatedAt" | "sortOrder" | undefined,
```

The Zod schema at line 80 defines `sort: z.string().optional()`, so any string passes validation. The cast is cosmetic, not constraining.

### Issue 7: API route `order` uses unsafe type cast
**Status:** STILL OPEN

`apps/api/src/routes/admin/collections.ts` line 102 still uses:

```typescript
order: q.order as "asc" | "desc" | undefined
```

Same issue as #6. Should be `z.enum(["asc", "desc"]).default("asc")`.

### Issue 8: `reorderCollections` uses sequential updates instead of `db.batch()`
**Status:** FIXED

`packages/core/src/modules/collections/collections.service.ts` lines 197-210 now uses `db.batch()`:

```typescript
await db.batch(
    items.map((item) =>
        db.update(collections)
            .set({ sortOrder: item.sortOrder, updatedAt: sql`(unixepoch())` })
            .where(eq(collections.id, item.id))
    ) as any
);
```

The `as any` cast on the batch argument is a known Drizzle typing limitation (the batch method signature is overly restrictive). This is acceptable.

### Issue 9: Search uses LIKE instead of FTS5
**Status:** STILL OPEN

`packages/core/src/modules/collections/collections.service.ts` line 43 still uses:

```typescript
whereConditions.push(like(collections.name, `%${search}%`));
```

Low priority -- collections table is typically small (<50 rows). LIKE wildcards (`%`, `_`) in user search input are not escaped.

### Issue 10: Duplicate `formatTimestamp` / `unixToISO` utility
**Status:** STILL OPEN

Two identical functions remain:
- `apps/api/src/routes/collections.ts` lines 25-42: `formatTimestamp()`
- `packages/core/src/modules/storefront/storefront.service.ts` lines 32-39: `unixToISO()`

Neither has been extracted to `@scalius/shared`.

### Issue 11: Admin delete route catches and re-wraps errors unnecessarily
**Status:** FIXED

Both the soft-delete route (lines 366-371) and permanent-delete route (lines 389-394) in `apps/api/src/routes/admin/collections.ts` now call service functions directly without try/catch wrappers. The global error handler catches `ApiError` subclasses properly.

### Issue 12: Config is stored as raw JSON string -- no validation on read
**Status:** STILL OPEN

No `parseCollectionConfig()` helper has been created. Every consumer still independently calls `JSON.parse()`:
- `apps/api/src/routes/collections.ts` line 101: `JSON.parse(collection.config)` -- no try/catch
- `apps/api/src/routes/collections.ts` line 163: `JSON.parse(collection.config)` -- no try/catch
- `apps/admin/src/loaders/admin/catalog.ts` line 98: `JSON.parse(collection.config)` -- no try/catch (relies on truthy check)
- `apps/admin/src/components/admin/collections-list/components/CollectionRow.tsx` line 94: `JSON.parse(collection.config)` -- inside try/catch
- `packages/core/src/modules/storefront/storefront.service.ts` line 138: uses `safeJsonParse()` -- safe

The storefront service is the only consumer using safe parsing. The public API routes would throw unhandled `SyntaxError` on corrupt config data.

### Issue 13: Form schema is duplicated between core validation and admin types
**Status:** STILL OPEN

`apps/admin/src/components/admin/collection-form/types.ts` defines its own `collectionFormSchema` (lines 28-44) that is structurally identical to `packages/core/src/modules/collections/collections.validation.ts` `createCollectionSchema` (lines 13-18), plus an optional `id` field. They can drift independently.

### Issue 14: Statistics counts are computed from current page, not total
**Status:** STILL OPEN

`apps/admin/src/components/admin/collections-list/CollectionsList.tsx` lines 76-77 still compute active/inactive counts from the current page only:

```typescript
const activeCount = collections.filter((c) => c.isActive).length;
const inactiveCount = collections.length - activeCount;
```

### Issue 15: `formOptions` endpoint loads up to 500 categories and 500 products
**Status:** STILL OPEN

`apps/api/src/routes/admin/collections.ts` lines 54-63 still load up to 500 of each with no server-side search.

### Issue 16: Batch resolution does not enforce per-collection `maxProducts` at SQL level
**Status:** STILL OPEN

`resolveCollectionProductsBatch()` in `packages/core/src/modules/collections/collections.service.ts` still fetches all matching products then applies `.slice(0, maxProducts)` in JavaScript. Intentional tradeoff, acceptable for typical usage.

### Issue 17: Correlated subqueries use `COUNT(*) > 0` instead of `EXISTS`
**Status:** STILL OPEN

`packages/core/src/modules/collections/collections.service.ts` line 236 still uses:

```typescript
SELECT COUNT(*) > 0 FROM "product_variants" ...
```

Should use `EXISTS (SELECT 1 FROM ...)` for short-circuit evaluation.

### Issue 18: Public collection route does not validate JSON.parse output
**Status:** STILL OPEN

`apps/api/src/routes/collections.ts` lines 101 and 163 still call `JSON.parse(collection.config)` without try/catch. A corrupt config string would throw an unhandled `SyntaxError`, resulting in a 500 error.

### Issue 19: Bulk operations accept empty arrays without guard
**Status:** FIXED

All four bulk operations in `packages/core/src/modules/collections/collections.service.ts` now have early returns for empty arrays:
- `bulkDeleteCollections` line 158: `if (ids.length === 0) return;`
- `bulkActivateCollections` line 171: `if (ids.length === 0) return;`
- `bulkDeactivateCollections` line 180: `if (ids.length === 0) return;`
- `restoreCollections` line 189: `if (ids.length === 0) return;`
- `reorderCollections` line 201: `if (items.length === 0) return;`

### Issue 20: No storefront cache invalidation when collections are modified
**Status:** STILL OPEN

Admin mutation routes in `apps/api/src/routes/admin/collections.ts` still do not trigger cache purge. The storefront edge cache in `apps/storefront/src/lib/api/collections.ts` uses `CACHE_TTL.LONG` (3600 seconds based on the cache middleware config at `apps/api/src/routes/collections.ts` line 17). Collection changes remain invisible to storefront visitors until TTL expires or a manual purge is issued.

---

## New Issues Found

### NEW-1: `reorderCollections` batch cast uses `as any` -- acceptable but undocumented

**Severity:** Low
**File:** `packages/core/src/modules/collections/collections.service.ts` line 208

The `db.batch()` call casts the mapped array `as any` to work around Drizzle's strict batch typing (requires a tuple, not an array). This is a known Drizzle limitation seen across the codebase. Not a bug, but the `as any` makes the batch silently accept incorrect query types if the map function is modified.

### NEW-2: Public list route `JSON.parse` on line 101 can throw inside `.map()`

**Severity:** Medium
**File:** `apps/api/src/routes/collections.ts` line 101

```typescript
const formattedCollections = activeCollections.map((collection) => ({
    ...collection,
    config: JSON.parse(collection.config),  // throws on corrupt JSON
```

If even one collection has corrupt config JSON, the entire list endpoint fails with an unhandled `SyntaxError`. Unlike the single-collection endpoint (line 163), this affects ALL collections, not just one. The storefront service's `safeJsonParse` in `packages/core/src/modules/storefront/storefront.service.ts` line 27 shows the correct pattern.

**Fix:** Use the same `safeJsonParse` pattern or wrap in try/catch with a fallback:
```typescript
config: (() => { try { return JSON.parse(collection.config); } catch { return {}; } })(),
```

### NEW-3: Admin loader does not guard `JSON.parse` in `getCollectionEditData`

**Severity:** Low
**File:** `apps/admin/src/loaders/admin/catalog.ts` line 98

```typescript
const parsedConfig =
    typeof collection.config === "string"
      ? JSON.parse(collection.config)
      : collection.config || {};
```

The type check (`typeof ... === "string"`) prevents calling `JSON.parse` on non-strings but does not catch corrupt JSON strings. An admin editing a collection with corrupt config data would see an unhandled error instead of a fallback form.

---

## Summary of Status

| # | Issue | Status |
|---|-------|--------|
| 1 | `new Date()` timestamp bug | **FIXED** |
| 2 | Silent update on missing ID | **FIXED** |
| 3 | `"AllCategories"` phantom type | STILL OPEN |
| 4 | SDK `as any` casts | PARTIALLY FIXED |
| 5 | `& any` on CollectionRow | STILL OPEN |
| 6 | Unsafe sort cast | STILL OPEN |
| 7 | Unsafe order cast | STILL OPEN |
| 8 | Sequential reorder updates | **FIXED** |
| 9 | LIKE search (not FTS5) | STILL OPEN |
| 10 | Duplicate timestamp formatter | STILL OPEN |
| 11 | Unnecessary error re-wrapping | **FIXED** |
| 12 | No config validation on read | STILL OPEN |
| 13 | Duplicated form schemas | STILL OPEN |
| 14 | Page-scoped statistics | STILL OPEN |
| 15 | 500 item limit on form options | STILL OPEN |
| 16 | Batch over-fetching | STILL OPEN |
| 17 | `COUNT(*) > 0` vs `EXISTS` | STILL OPEN |
| 18 | Unhandled JSON.parse in public route | STILL OPEN |
| 19 | Empty array to `inArray()` | **FIXED** |
| 20 | No cache invalidation on mutations | STILL OPEN |
| NEW-1 | Batch cast `as any` | NEW (Low) |
| NEW-2 | List route JSON.parse in `.map()` | NEW (Medium) |
| NEW-3 | Admin loader JSON.parse unguarded | NEW (Low) |

**Fixed:** 5 of 20 (Issues 1, 2, 8, 11, 19)
**Partially Fixed:** 1 of 20 (Issue 4)
**Still Open:** 14 of 20
**New Issues:** 3

---

## Remaining Priority Actions

### Priority 1 -- Correctness (should fix now)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 18 | Unhandled JSON.parse in public route | `apps/api/src/routes/collections.ts` lines 101, 163 | Wrap in try/catch or use `safeJsonParse` |
| NEW-2 | List route JSON.parse in `.map()` crashes all | `apps/api/src/routes/collections.ts` line 101 | Use safe parse, skip corrupt entries |

### Priority 2 -- Pattern Consistency

| # | Issue | File | Fix |
|---|-------|------|-----|
| 3 | `"AllCategories"` phantom type | `apps/storefront/src/lib/api/types.ts` line 193 | Remove from union |
| 6-7 | Unsafe sort/order casts | `apps/api/src/routes/admin/collections.ts` lines 80-81, 101-102 | Use `z.enum()` in route schema |
| 10 | Duplicate timestamp formatter | `apps/api/src/routes/collections.ts`, `storefront.service.ts` | Extract to `@scalius/shared` |
| 12 | No config validation on read | Multiple files | Add `parseCollectionConfig()` to service module |

### Priority 3 -- Quality of Life

| # | Issue | File | Fix |
|---|-------|------|-----|
| 5 | `& any` on CollectionRow | `CollectionRow.tsx` line 24 | Type DnD props explicitly |
| 13 | Duplicated form schemas | `types.ts` vs `collections.validation.ts` | Import and extend core schema |
| 14 | Page-scoped statistics | `CollectionsList.tsx` lines 76-77 | Compute server-side |
| 17 | `COUNT(*) > 0` vs `EXISTS` | `collections.service.ts` line 236 | Use EXISTS subquery |

---

## Overall Assessment

**Rating: 7/10** (up from ~5.5/10 at previous audit)

The five critical and high-severity fixes addressed the most impactful issues: the timestamp corruption bug (issue 1), silent update on missing IDs (issue 2), empty array SQL crash (issue 19), sequential D1 round-trips on reorder (issue 8), and unnecessary error swallowing in delete routes (issue 11). The SDK integration also improved with the `unwrapData` helper replacing raw `as any` casts.

The remaining open issues are almost entirely pattern consistency and quality-of-life improvements, not correctness bugs. The two most actionable remaining items are the unguarded `JSON.parse` calls in the public routes (issues 18 and NEW-2), which could produce 500 errors if collection config data is ever corrupted. Everything else is low-urgency cleanup.
