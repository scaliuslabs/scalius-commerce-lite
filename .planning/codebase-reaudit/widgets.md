# Widgets Domain Re-Audit

**Analysis Date:** 2026-03-21
**Previous Audit:** 2026-03-20

## Summary

The fix session addressed 7 of the 22 original findings. The most impactful fixes were: `restoreFromHistory` is now atomic via `db.batch()`, all bulk service functions have empty-array guards, `deleteWidget` verifies existence, the update route no longer swallows typed errors, `aiContext` validation was tightened from `z.any()` to `z.record()`, HTML sanitization was added to the service layer, and the entity schema timestamps were properly typed. However, 15 issues remain open, most notably: the `updateWidgetSchema` still lacks cross-field `.refine()` validation, public widget routes still query the DB directly bypassing the service layer (despite new service functions existing for exactly this purpose), the form submit still uses raw `fetch()`, localStorage is still used for model preference, and the loader still fetches the full widget list just to extract collections.

**Previous Score: Not rated**
**Current Score: 6.5/10**

---

## Previous Finding Status

### Finding 1: No HTML Sanitization -- Stored XSS Vector
**Status: FIXED**

The service layer now includes a `sanitizeWidgetHtml()` function at `packages/core/src/modules/widgets/widgets.service.ts` (lines 24-30) that strips `<script>` tags, inline event handlers (`on*=`), and `javascript:` URLs. Two new service functions -- `getActiveWidgetById()` (line 81) and `getActiveHomepageWidgets()` (line 95) -- apply this sanitization before returning data. The storefront shortcodes in `apps/storefront/src/lib/shortcodes.ts` call through the API which uses these service functions.

**Note:** The sanitization is regex-based rather than using a DOM parser (e.g., DOMPurify). Regex-based sanitizers are bypassable with crafted payloads (e.g., `<img src=x onerror=alert(1)>` variations). For a single-tenant admin tool this is acceptable, but it is not production-grade sanitization for multi-tenant or user-generated content.

**Residual concern:** The public routes in `apps/api/src/routes/widgets.ts` (lines 86-116, 135-157) still query the DB directly and do NOT use `getActiveWidgetById()` or `getActiveHomepageWidgets()`, meaning the sanitization is bypassed for those endpoints. See Finding 10.

### Finding 2: Non-Atomic `restoreFromHistory` -- Race Condition
**Status: FIXED**

`restoreFromHistory` at `packages/core/src/modules/widgets/widgets.service.ts` (lines 222-255) now uses `db.batch()` to atomically snapshot current state and restore from history in a single batch. The implementation is correct.

### Finding 3: `aiContext` Accepts `z.any()` -- Unbounded JSON Blob
**Status: FIXED**

The validation at `packages/core/src/modules/widgets/widgets.validation.ts` (line 13) now uses `z.record(z.string(), z.unknown()).nullable().optional()` instead of `z.any()`. This constrains the field to a key-value object structure. It does not enforce the actual `AiContext` schema shape or a size limit, but it prevents non-object payloads.

### Finding 4: Update Route Swallows Typed Errors
**Status: FIXED**

The update route at `apps/api/src/routes/admin/widgets.ts` (lines 270-275) now calls `updateWidget()` directly and returns `ok(c, result)` without a try/catch wrapper. `NotFoundError` propagates to the global error handler as expected.

### Finding 5: Duplicated Zod Schema Between Core and Admin Form
**Status: STILL OPEN**

`packages/core/src/modules/widgets/widgets.validation.ts` defines `createWidgetSchema` with `.refine()` on the base schema. `apps/admin/src/components/admin/widgets/WidgetForm.tsx` (lines 40-70) still defines its own `widgetFormSchema` with an identical `.refine()` and identical field definitions. The duplication remains -- changes must be made in two places. The form schema uses `z.coerce.number()` for `sortOrder` (necessary for HTML inputs) while the core uses `z.number().int()`, but the structural logic is copy-pasted.

### Finding 6: Inline `WidgetPlacementRule` Constants in Loader
**Status: STILL OPEN**

`apps/admin/src/loaders/admin/widgets.ts` (lines 5-11) still inlines the `WidgetPlacementRule` values rather than importing from `@scalius/database/schema`. The admin app imports from `@scalius/database` elsewhere, so the rationale in the comment ("avoids DB dependency") is incorrect.

### Finding 7: Unused `_fetchWidgets` Parameter and Navigate-for-Refresh Pattern
**Status: STILL OPEN**

`apps/admin/src/components/admin/widget-list/hooks/useWidgets.ts` (lines 21-29) still uses `navigateTo()` for refresh. `useWidgetActions.ts` (line 8) still receives `_fetchWidgets` with underscore prefix. The pattern is intentional (Astro SSR data loading) but the naming remains misleading.

### Finding 8: Form Submit Uses Raw `fetch()` Instead of API Client Helpers
**Status: STILL OPEN**

`apps/admin/src/components/admin/widgets/WidgetForm.tsx` (lines 400-418) still uses raw `fetch()` with manual `response.ok` checking for form submission. The same component uses `clientGet`, `clientPost`, `clientDelete` for history operations (lines 325-371), showing inconsistency within the same file.

### Finding 9: Public Widget Route Inline-Defines `convertTimestampToISO`
**Status: STILL OPEN**

`apps/api/src/routes/widgets.ts` (lines 33-60) still defines `convertTimestampToISO` inline with complex multi-type branching logic. This utility is not shared with other routes.

### Finding 10: Public Widget Route Queries DB Directly Instead of Using Core Service
**Status: STILL OPEN**

`apps/api/src/routes/widgets.ts` (lines 86-116, 135-157) still imports `widgets` from `@scalius/database/schema` and builds queries directly. The fix session added `getActiveWidgetById()` and `getActiveHomepageWidgets()` to the service layer (lines 81-106 of `widgets.service.ts`) -- these functions exist specifically for the public routes and include HTML sanitization -- but the public routes were never updated to use them. This means the sanitization fix from Finding 1 is bypassed for all public/storefront widget access via these routes.

**Impact:** This is now more severe than before. The sanitization functions exist but are unused by the routes that serve widgets to the storefront. The `getActiveHomepageWidgets` route at `apps/api/src/routes/widgets.ts` line 135 returns raw HTML without sanitization.

### Finding 11: `widgetSchema` in Entity Schemas Uses `z.any()` for Timestamps
**Status: FIXED**

`apps/api/src/schemas/entities.ts` (lines 393-395) now uses `z.union([z.string(), z.number()]).nullable()` for all three timestamp fields instead of `z.any()`. The OpenAPI spec now correctly describes these fields.

### Finding 12: `WidgetForm.tsx` Is 578 Lines and Manages Too Many Concerns
**Status: STILL OPEN**

`apps/admin/src/components/admin/widgets/WidgetForm.tsx` is still 578 lines. Version history state and handlers (lines 122-371) could be extracted to a `useWidgetHistory` hook. The form orchestrates form state, version history, AI context, editor modes, content acceptance, improvement workflow, and paste modal state.

### Finding 13: Three AI Hooks Have Duplicated Streaming/Parsing Logic
**Status: STILL OPEN**

The SSE streaming + tag/JSON parsing logic is duplicated across:
- `apps/admin/src/components/admin/widgets/widget-form/useAiGenerator.ts` (lines 184-256)
- `apps/admin/src/components/admin/widgets/widget-form/useAiImprover.ts` (lines 156-299)
- `apps/admin/src/components/admin/widgets/widget-form/useStagedGeneration.ts` (lines 187-233)

All three contain: ReadableStream reading with TextDecoder, line buffering, `data: ` prefix parsing, `[DONE]` sentinel handling, `parseTagBasedResponse` then `parseJSONSafely` fallback, and `validateParsedWidget`/`validateWidgetJSON` validation. Approximately 40 lines of identical logic in each.

### Finding 14: `localStorage` Usage in AI Model Selector
**Status: STILL OPEN**

`apps/admin/src/components/admin/widgets/widget-form/AiAssistant.tsx` (line 86) still writes to `localStorage.setItem('global_preferred_ai_model', ...)`. `useAiGenerator.ts` (line 60) still reads from `localStorage.getItem('global_preferred_ai_model')`. The `WidgetForm.tsx` header comment (line 10) still claims "No localStorage usage" which is incorrect.

### Finding 15: `listWidgets` Fetches All Widgets + All Collections in One Call
**Status: STILL OPEN**

`packages/core/src/modules/widgets/widgets.service.ts` (lines 36-69) still fetches all widgets with full HTML/CSS content and all collections in a single call with no pagination. The admin list page at `apps/admin/src/components/admin/widget-list/WidgetsList.tsx` implements client-side pagination (lines 79-84) and client-side search filtering (lines 73-77), but the full dataset is fetched server-side.

### Finding 16: Widget History Has No Pagination or Retention Limits
**Status: STILL OPEN**

`packages/core/src/modules/widgets/widgets.service.ts` (lines 211-220) still fetches all history entries for a widget with no LIMIT clause and no retention policy.

### Finding 17: Public Homepage Widgets Route Sorts by `placementRule` Then `sortOrder`
**Status: STILL OPEN**

`apps/api/src/routes/widgets.ts` (line 147) still uses `.orderBy(asc(widgets.placementRule), asc(widgets.sortOrder))`, which sorts alphabetically by placement rule string. The service layer's `getActiveHomepageWidgets()` (line 100) also uses the same ordering, so even if the route is updated to use the service function, the ordering semantics remain unchanged.

### Finding 18: `deleteWidget` Does Not Verify Widget Exists
**Status: FIXED**

`packages/core/src/modules/widgets/widgets.service.ts` (lines 149-157) now checks existence and throws `NotFoundError("Widget not found")` before soft-deleting.

### Finding 19: `bulkDeleteWidgets` Has No ID Array Length Validation
**Status: FIXED**

All four bulk functions now have `if (ids.length === 0) return;` guards:
- `bulkDeleteWidgets` (line 160)
- `bulkActivateWidgets` (line 172)
- `bulkDeactivateWidgets` (line 177)
- `restoreWidgets` (line 182)

### Finding 20: No Auto-Snapshot on Widget Update
**Status: STILL OPEN**

`updateWidget()` at `packages/core/src/modules/widgets/widgets.service.ts` (lines 131-147) still overwrites content without creating a history entry. Only `restoreFromHistory` auto-snapshots.

### Finding 21: `updateWidgetSchema` Loses the `.refine()` Validation
**Status: STILL OPEN**

`packages/core/src/modules/widgets/widgets.validation.ts` (line 52) still defines `updateWidgetSchema = widgetBaseSchema.partial()` without the `.refine(validateCollectionRef, ...)` check. The `validateCollectionRef` function (lines 28-38) exists and is shared, but is only applied to `createWidgetSchema`. A user could set `placementRule: "before_collection"` in one update and clear `referenceCollectionId` in another, resulting in an invalid widget.

### Finding 22: Loader Fetches Full Widget List Just for Collections
**Status: STILL OPEN**

`apps/admin/src/loaders/admin/widgets.ts` (lines 67-68) still fetches the full widget list response to extract `availableCollections`, loading all widget HTML content just to discard it.

---

## New Issues

### NEW-1: Public Routes Bypass Service-Layer Sanitization

**Severity:** High
**Files:**
- `apps/api/src/routes/widgets.ts` (lines 86-116, 135-157)
- `packages/core/src/modules/widgets/widgets.service.ts` (lines 81-106)

**Problem:** The fix session added `getActiveWidgetById()` and `getActiveHomepageWidgets()` service functions that sanitize HTML. However, the public routes at `apps/api/src/routes/widgets.ts` were never updated to use them. The public routes still query the DB directly and return raw, unsanitized HTML to the storefront. This creates a false sense of security -- the sanitization code exists but is dead code for the actual storefront data path.

**Fix approach:** Replace the inline DB queries in `apps/api/src/routes/widgets.ts` with calls to `getActiveWidgetById()` and `getActiveHomepageWidgets()` from `@scalius/core/modules/widgets`. This also eliminates the need for the inline `convertTimestampToISO` function (Finding 9), since the service functions handle timestamp casting.

### NEW-2: `updateWidgetSchema` Should Apply Cross-Field Validation

**Severity:** Medium
**Files:**
- `packages/core/src/modules/widgets/widgets.validation.ts` (line 52)

**Problem:** While this was noted in Finding 21, the fix session extracted the `validateCollectionRef` function (lines 28-38) and `collectionRefMessage` constant (lines 40-43) to be shareable, but then only applied them to `createWidgetSchema`. The fix was half-done -- the shared validation function exists but is not used on the update schema.

**Fix approach:** Apply `.refine(validateCollectionRef, collectionRefMessage)` after `.partial()` on the update schema. The `validateCollectionRef` function already handles `undefined` fields correctly (it checks `data.placementRule !== undefined` before validating).

### NEW-3: WidgetForm Comment Block Claims "No localStorage Usage"

**Severity:** Low (documentation accuracy)
**Files:**
- `apps/admin/src/components/admin/widgets/WidgetForm.tsx` (line 10)

**Problem:** The component header comment claims "No localStorage usage" as an improvement, but `localStorage` is actively used in `AiAssistant.tsx` (line 86) and `useAiGenerator.ts` (line 60) for global AI model preference. This misleads developers reviewing the component.

**Fix approach:** Remove the "No localStorage usage" claim from the comment block, or migrate the model preference to server-side storage and then the claim becomes accurate.

---

## Scoring Breakdown

| Category | Score | Notes |
|----------|-------|-------|
| Correctness | 6/10 | Bulk guards and delete existence check fixed; `updateWidgetSchema` cross-field validation still missing; public routes bypass sanitization |
| Security | 6/10 | Regex-based sanitization added but bypassed by public routes; sanitization is not robust against all XSS vectors |
| Code Quality | 6/10 | Update route error handling fixed; entity schema timestamps typed; form still uses raw fetch; AI streaming logic still duplicated x3 |
| Maintainability | 6/10 | Form still 578 lines; schemas still duplicated; loader still inlines enum |
| Performance | 7/10 | No changes; client-side pagination exists but server fetches all data |
| Architecture | 7/10 | Service layer has correct functions (`getActiveWidgetById`, `getActiveHomepageWidgets`); routes not yet wired to use them |
| LLM-Friendliness | 7/10 | Good README, naming, exports; split admin directories still confusing; misleading comment block |

**Overall: 6.5/10**

---

## Recommended Fixes (Priority-Ordered)

### Priority 1 -- Correctness / Safety

| # | Change | Files | Effort | Status |
|---|--------|-------|--------|--------|
| 1 | Wire public widget routes to use `getActiveWidgetById()` and `getActiveHomepageWidgets()` from core service | `apps/api/src/routes/widgets.ts` | Small | NEW (supersedes Findings 9, 10, and NEW-1) |
| 2 | Apply `.refine(validateCollectionRef, ...)` to `updateWidgetSchema` | `packages/core/src/modules/widgets/widgets.validation.ts` | Small | STILL OPEN (Finding 21, NEW-2) |

### Priority 2 -- Consistency

| # | Change | Files | Effort | Status |
|---|--------|-------|--------|--------|
| 3 | Use `clientPost`/`clientPut` for form submission instead of raw `fetch()` | `apps/admin/src/components/admin/widgets/WidgetForm.tsx` | Small | STILL OPEN (Finding 8) |
| 4 | Import `WidgetPlacementRule` from `@scalius/database/schema` in loader | `apps/admin/src/loaders/admin/widgets.ts` | Small | STILL OPEN (Finding 6) |
| 5 | Fix misleading "No localStorage usage" comment | `apps/admin/src/components/admin/widgets/WidgetForm.tsx` | Trivial | NEW (NEW-3) |

### Priority 3 -- Performance / Robustness

| # | Change | Files | Effort | Status |
|---|--------|-------|--------|--------|
| 6 | Add pagination to `listWidgets`, exclude HTML/CSS from list query | `packages/core/src/modules/widgets/widgets.service.ts` | Medium | STILL OPEN (Finding 15) |
| 7 | Add pagination + retention limit to `getWidgetHistory` | `packages/core/src/modules/widgets/widgets.service.ts` | Medium | STILL OPEN (Finding 16) |
| 8 | Add auto-snapshot on content change in `updateWidget` | `packages/core/src/modules/widgets/widgets.service.ts` | Medium | STILL OPEN (Finding 20) |
| 9 | Dedicated collections endpoint for widget form loader | `apps/admin/src/loaders/admin/widgets.ts` | Small | STILL OPEN (Finding 22) |

### Priority 4 -- Maintainability

| # | Change | Files | Effort | Status |
|---|--------|-------|--------|--------|
| 10 | Extract `useWidgetHistory` hook from `WidgetForm.tsx` | `apps/admin/src/components/admin/widgets/WidgetForm.tsx` | Medium | STILL OPEN (Finding 12) |
| 11 | Extract shared SSE streaming + parsing utility | `useAiGenerator.ts`, `useAiImprover.ts`, `useStagedGeneration.ts` | Medium | STILL OPEN (Finding 13) |
| 12 | Migrate localStorage model preference to server-side | `AiAssistant.tsx`, `useAiGenerator.ts` | Small | STILL OPEN (Finding 14) |

---

## Fix Summary

| Status | Count | Findings |
|--------|-------|----------|
| FIXED | 7 | 1 (HTML sanitization added), 2 (restoreFromHistory atomic), 3 (aiContext z.record), 4 (update route error propagation), 11 (entity schema timestamps), 18 (deleteWidget existence check), 19 (bulk empty-array guards) |
| STILL OPEN | 15 | 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 20, 21, 22 |
| NEW | 3 | NEW-1 (public routes bypass sanitization), NEW-2 (updateWidgetSchema half-fix), NEW-3 (misleading comment) |
