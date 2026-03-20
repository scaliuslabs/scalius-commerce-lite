# Widgets Domain Audit

**Analysis Date:** 2026-03-20

## Summary

The widgets domain is a complete vertical slice spanning schema, core service, API routes, admin UI, storefront rendering, and AI-assisted generation. The core CRUD layer is clean and follows codebase conventions well. The main concerns center on: (1) no HTML sanitization anywhere in the pipeline -- admin-authored HTML is rendered raw on the storefront, (2) non-atomic `restoreFromHistory` with a race condition window, (3) `z.any()` on the `aiContext` field bypasses all validation, (4) the `updateWidget` route wraps the service's typed `NotFoundError` in a lossy generic `ApiError` catch, (5) duplicated Zod schemas between core validation and the admin form, and (6) the `WidgetForm.tsx` component at 578 lines is the largest single file and carries significant complexity from AI-related concerns.

The widget history feature is functionally complete (API + UI) but lacks pagination, retention limits, and auto-snapshot on update -- CLAUDE.md flags it as "needs UI testing."

---

## Critical Issues

### 1. No HTML Sanitization -- Stored XSS Vector

**Severity:** Critical (if multi-admin or compromised account)
**Files:**
- `packages/core/src/modules/widgets/widgets.service.ts` (lines 71-88, 90-106) -- stores raw HTML
- `apps/storefront/src/lib/shortcodes.ts` (lines 45-63) -- renders raw HTML into storefront pages
- `apps/api/src/routes/widgets.ts` (lines 86-116, 135-157) -- returns raw HTML to storefront

**Problem:** Widget HTML content flows from admin form to database to storefront rendering with zero sanitization at any layer. The `renderWidgetShortcode()` function in `apps/storefront/src/lib/shortcodes.ts` injects the raw `htmlContent` directly into the page DOM:

```typescript
// shortcodes.ts line 59
return `<div class="widget-shortcode not-prose ${scopeClass}" data-widget-id="${widgetId}">${html}</div>`;
```

The admin `FullScreenEditor` iframe uses `sandbox="allow-scripts allow-same-origin"` (line 371 of `FullScreenEditor.tsx`), and the `WidgetHistoryModal` iframe uses only `sandbox="allow-scripts"` (line 58). The `allow-same-origin` in the editor combined with `allow-scripts` is the most permissive sandbox combination.

**Impact:** Any admin user (or compromised admin session) can inject arbitrary JavaScript that executes in every storefront visitor's browser. In a single-tenant deployment this is lower risk (admins already have full control), but becomes critical if admin access is ever shared or if the platform moves to multi-tenant.

**Fix approach:** Add server-side HTML sanitization (e.g., DOMPurify via `isomorphic-dompurify` or a server-safe alternative) as a middleware in `createWidget` and `updateWidget` before persisting. This preserves the raw HTML editing experience while preventing script injection on the storefront side. The iframe sandboxes in the admin are acceptable for preview purposes.

### 2. Non-Atomic `restoreFromHistory` -- Race Condition

**Severity:** High
**Files:**
- `packages/core/src/modules/widgets/widgets.service.ts` (lines 174-202)

**Problem:** The `restoreFromHistory` function performs three sequential database operations without a transaction or `db.batch()`:

```typescript
// Step 1: Read history entry
const [entry] = await db.select()...
// Step 2: Auto-snapshot current state (INSERT into widgetHistory)
await createHistoryEntry(db, widgetId, "Auto-saved before restore");
// Step 3: Overwrite widget with history content (UPDATE widgets)
await db.update(widgets).set({...}).where(eq(widgets.id, widgetId));
```

If the process crashes between step 2 and step 3, the auto-snapshot is created but the restore never completes, leaving the widget in an inconsistent state where the "Auto-saved before restore" entry exists but nothing was actually restored.

**Fix approach:** Wrap all three operations in `db.batch()` (D1's batched execution, used elsewhere in the codebase for similar atomic operations -- see `processPaymentConfirmed` pattern).

### 3. `aiContext` Accepts `z.any()` -- Unbounded JSON Blob

**Severity:** Medium
**Files:**
- `packages/core/src/modules/widgets/widgets.validation.ts` (line 13): `aiContext: z.any().optional()`
- `packages/core/src/modules/widgets/widgets.service.ts` (line 84): `JSON.stringify(data.aiContext)`

**Problem:** The `aiContext` field is validated as `z.any()`, meaning any JSON payload of any size can be stored. The field is serialized via `JSON.stringify` and stored in a TEXT column. There is no schema enforcement, no size limit, and no structural validation. A malicious or buggy client could store megabytes of data in this field.

The admin form constructs a typed `AiContext` object (from `@scalius/core/modules/ai/ai-context-schema`), but this schema is never enforced on the API side -- only on the client side.

**Fix approach:** Replace `z.any()` with the actual `aiContextSchema` from `@scalius/core/modules/ai/ai-context-schema`, or at minimum use `z.string().max(500000).optional()` to cap size. The structured schema exists and is already imported client-side -- it should be shared with the validation layer.

---

## Code Quality Issues

### 4. Update Route Swallows Typed Errors

**File:** `apps/api/src/routes/admin/widgets.ts` (lines 270-280)

```typescript
app.openapi(updateWidgetRoute, async (c) => {
    ...
    try {
        const result = await updateWidget(db, id, c.req.valid("json"));
        return ok(c, result);
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number };
        throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
    }
});
```

**Problem:** The service layer throws `NotFoundError` (which extends `AppError` with a 404 status code), but the route catches it, casts to a generic object, and re-throws as `ApiError` with a default of 400. This:
- Loses the typed error class
- Returns 400 instead of 404 if `statusCode` isn't preserved through the cast
- Violates the codebase convention where most routes let `NotFoundError` propagate to the global error handler (see the `getByIdRoute` handler at line 246 which correctly does `throw new NotFoundError(...)` directly)

**Fix approach:** Remove the try/catch entirely. The global error handler in Hono already converts `NotFoundError` to a proper 404 response. Every other widget route lets errors propagate naturally.

### 5. Duplicated Zod Schema Between Core and Admin Form

**Files:**
- `packages/core/src/modules/widgets/widgets.validation.ts` (lines 9-43) -- `createWidgetSchema` with `.refine()`
- `apps/admin/src/components/admin/widgets/WidgetForm.tsx` (lines 40-70) -- `widgetFormSchema` with identical `.refine()`

**Problem:** The admin form defines its own Zod schema (`widgetFormSchema`) that duplicates the same validation logic as `createWidgetSchema` from `@scalius/core`. Both schemas validate the same fields with the same rules and even the same `.refine()` for collection reference requirements. This means:
- Validation changes must be made in two places
- The schemas can drift (the form uses `z.coerce.number()` for `sortOrder` while the core uses `z.number().int()`)

**Note:** The form schema's use of `z.coerce.number()` for `sortOrder` is intentional (HTML inputs return strings), but the structural duplication remains a maintenance risk.

### 6. Inline `WidgetPlacementRule` Constants in Loader

**File:** `apps/admin/src/loaders/admin/widgets.ts` (lines 5-11)

```typescript
// Placement rule values inlined from @scalius/database schema (avoids DB dependency)
const WidgetPlacementRule = {
  BEFORE_COLLECTION: "before_collection",
  ...
} as const;
```

**Problem:** The enum values are copy-pasted from `@scalius/database/schema/enums.ts` with a comment explaining the duplication. If a new placement rule is added to the database enum, this file will be silently out of sync. The admin app already imports from `@scalius/database` elsewhere (per the dependency graph in CLAUDE.md), so the "avoids DB dependency" rationale is moot.

**Fix approach:** Import `WidgetPlacementRule` directly from `@scalius/database/schema` instead of inlining.

### 7. Unused `_fetchWidgets` Parameter and Navigate-for-Refresh Pattern

**Files:**
- `apps/admin/src/components/admin/widget-list/hooks/useWidgets.ts` (lines 21-29)
- `apps/admin/src/components/admin/widget-list/hooks/useWidgetActions.ts` (line 8)

```typescript
const fetchWidgets = async () => {
    setIsLoading(true);
    try {
      void navigateTo(window.location.pathname + window.location.search);
    } catch (error: unknown) {
      console.error("Error fetching widgets:", error);
      setIsLoading(false);
    }
};
```

**Problem:** `fetchWidgets` doesn't actually fetch widgets -- it triggers a full-page navigation via `navigateTo()`, which causes the entire Astro page to re-render with fresh server-side data. While this works (Astro SSR re-fetches data), it:
- Causes a full page reload for every mutation (losing scroll position, selections, etc.)
- Makes `setIsLoading(true)` misleading (loading never returns to false because the page reloads)
- `useWidgetActions` receives `_fetchWidgets` (prefixed with `_` indicating it's unused) but the `useBulkActions` hook calls `fetchWidgets()` after bulk operations

This is an intentional pattern in other admin list pages (Astro SSR handles data loading), but the naming is misleading.

---

## Pattern Violations

### 8. Form Submit Uses Raw `fetch()` Instead of API Client Helpers

**File:** `apps/admin/src/components/admin/widgets/WidgetForm.tsx` (lines 400-418)

```typescript
const response = await fetch(apiUrl, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submissionData),
});
if (response.ok) { ... }
```

**Problem:** The form submit handler uses raw `fetch()` and manually checks `response.ok`, while the list actions in `useWidgetActions.ts` correctly use `unwrapEnvelope()` and `extractApiError()` from `@/lib/api-helpers`. The form handler:
- Doesn't unwrap the response envelope
- Swallows error details with a generic fallback message
- Doesn't use the `clientPost`/`clientPut` helpers that are used by the history handlers in the same file (lines 325-337)

The same form has history handlers that correctly use `clientGet`, `clientPost`, `clientDelete` -- showing inconsistency within the same component.

### 9. Public Widget Route Inline-Defines `convertTimestampToISO`

**File:** `apps/api/src/routes/widgets.ts` (lines 33-60)

**Problem:** The `convertTimestampToISO` function is defined inline in the public widget routes file. It handles multiple input types (Date, number, string) with complex branching. This utility should live in `@scalius/shared` and be reusable. Other routes may need the same conversion.

### 10. Public Widget Route Queries DB Directly Instead of Using Core Service

**File:** `apps/api/src/routes/widgets.ts` (lines 86-116, 135-157)

**Problem:** The public widget routes import `widgets` from `@scalius/database/schema` and build queries directly, bypassing the `getWidgetById` service function in `@scalius/core/modules/widgets`. This violates the "thin HTTP layer" convention where routes delegate to core services. The admin routes correctly use the service layer. The public route adds an `isActive` filter that the service doesn't provide, but the proper fix is to add a `getActiveWidgetById` function to the service.

### 11. `widgetSchema` in Entity Schemas Uses `z.any()` for Timestamps

**File:** `apps/api/src/schemas/entities.ts` (lines 383-397)

```typescript
createdAt: z.any(),
updatedAt: z.any(),
deletedAt: z.any().nullable(),
```

**Problem:** Three timestamp fields use `z.any()` instead of `z.union([z.number(), z.string()])` or similar. This weakens the OpenAPI spec output -- the generated types for these fields will be `unknown` rather than properly typed.

---

## Maintainability Concerns

### 12. `WidgetForm.tsx` Is 578 Lines and Manages Too Many Concerns

**File:** `apps/admin/src/components/admin/widgets/WidgetForm.tsx`

**Problem:** The widget form component manages:
- Form state (react-hook-form)
- Version history (fetch, restore, delete, save)
- AI context loading/restoring
- Editor mode transitions
- Generated content acceptance
- Improvement workflow
- Paste modal state
- Form submission with AI context serialization

While the AI concerns are split into hooks (`useAiContext`, `useAiGenerator`, `useAiImprover`), the form still orchestrates all of them plus history. A `useWidgetHistory` hook would reduce the form to ~400 lines.

### 13. Three AI Hooks Have Duplicated Streaming/Parsing Logic

**Files:**
- `apps/admin/src/components/admin/widgets/widget-form/useAiGenerator.ts` (lines 167-256)
- `apps/admin/src/components/admin/widgets/widget-form/useAiImprover.ts` (lines 140-299)
- `apps/admin/src/components/admin/widgets/widget-form/useStagedGeneration.ts` (lines 126-233)

**Problem:** All three hooks contain nearly identical SSE streaming logic:
1. Read from `response.body` with a `TextDecoder`
2. Buffer lines, look for `data: ` prefix
3. Parse `[DONE]` sentinel
4. Accumulate `delta.content`
5. Parse with tag-based parsing first, then JSON fallback
6. Validate with `validateParsedWidget`

This streaming + parsing logic is copy-pasted across three hooks (~40 lines each). A single `streamAndParseAiResponse(response)` utility would eliminate the duplication.

### 14. `localStorage` Usage in AI Model Selector

**File:** `apps/admin/src/components/admin/widgets/widget-form/AiAssistant.tsx` (line 86)

```typescript
localStorage.setItem('global_preferred_ai_model', newModelId);
```

And in `useAiGenerator.ts` (line 60):
```typescript
const globalModel = localStorage.getItem('global_preferred_ai_model');
```

**Problem:** CLAUDE.md states "No localStorage usage" is an improvement of the widget form. However, `localStorage` is still used for the global AI model preference. This is problematic in Cloudflare Worker SSR context where `localStorage` doesn't exist server-side (only works because the component is `client:idle`). The preference should be stored server-side in the settings table or as a user preference.

---

## Performance & Scalability

### 15. `listWidgets` Fetches All Widgets + All Collections in One Call

**File:** `packages/core/src/modules/widgets/widgets.service.ts` (lines 23-57)

**Problem:** The `listWidgets` function runs two separate queries (all widgets + all active collections) and returns both. There is no pagination. For a store with hundreds of widgets, this loads all HTML content (which can be large -- AI-generated widgets are typically 5-50KB of HTML each) into memory at once.

The admin list page implements client-side pagination (slicing in `WidgetsList.tsx` line 81-84), but the full dataset is fetched server-side and passed through Astro's SSR to the React island.

**Fix approach:** Add `page`/`limit` parameters to `listWidgets`. Exclude `htmlContent` and `cssContent` from the list query (they're not displayed in the table). The form edit page already fetches individual widgets for editing.

### 16. Widget History Has No Pagination or Retention Limits

**File:** `packages/core/src/modules/widgets/widgets.service.ts` (lines 163-172)

```typescript
export async function getWidgetHistory(db: Database, widgetId: string) {
    ...
    return db.select().from(widgetHistory)
        .where(eq(widgetHistory.widgetId, widgetId))
        .orderBy(sql`${widgetHistory.createdAt} DESC`);
}
```

**Problem:** History entries accumulate without limit. With frequent saves (especially from AI generation workflows where each improvement creates entries), a widget could accumulate hundreds of history entries. The modal loads all of them at once and renders them in a scrollable list.

There is no retention policy (e.g., keep last 50 entries) and no cleanup mechanism.

**Fix approach:** Add a `limit` parameter (default 50). Add a cleanup function that prunes entries beyond the retention limit. The UI already sorts by newest-first, so a LIMIT clause is natural.

### 17. Public Homepage Widgets Route Sorts by `placementRule` Then `sortOrder`

**File:** `apps/api/src/routes/widgets.ts` (line 147)

```typescript
.orderBy(asc(widgets.placementRule), asc(widgets.sortOrder))
```

**Problem:** Sorting by `placementRule` alphabetically means `after_collection` comes before `before_collection`, `fixed_bottom_homepage` before `fixed_top_homepage`, and `standalone` last. This alphabetical ordering is coincidental for some rules but semantically wrong -- the storefront likely expects widgets ordered by their spatial position on the page. The admin service sorts by `sortOrder` then `name` (line 43), which is different from the public route's ordering.

---

## Robustness Gaps

### 18. `deleteWidget` Does Not Verify Widget Exists

**File:** `packages/core/src/modules/widgets/widgets.service.ts` (lines 108-113)

```typescript
export async function deleteWidget(db: Database, id: string): Promise<void> {
    await db.update(widgets)
        .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
        .where(eq(widgets.id, id));
}
```

**Problem:** The function silently succeeds even if the widget ID doesn't exist. The `UPDATE` statement matches zero rows and returns without error. Compare with `updateWidget` (line 91) which correctly checks existence first and throws `NotFoundError`. The API route for delete returns 204 regardless.

### 19. `bulkDeleteWidgets` Has No ID Array Length Validation

**File:** `packages/core/src/modules/widgets/widgets.service.ts` (lines 115-124)

**Problem:** An empty `ids` array produces `WHERE id IN ()` which is a SQL syntax error in SQLite. Similarly, an extremely large array could create performance issues. The API route validates the body shape but doesn't validate array length. The same applies to `bulkActivateWidgets`, `bulkDeactivateWidgets`, and `restoreWidgets`.

**Fix approach:** Add `if (ids.length === 0) return;` guard at the top of each bulk function.

### 20. No Auto-Snapshot on Widget Update

**File:** `packages/core/src/modules/widgets/widgets.service.ts` (lines 90-106)

**Problem:** The `updateWidget` function overwrites content without creating a history entry. History entries are only created via explicit "Save Version" button clicks in the UI, or automatically during `restoreFromHistory`. This means:
- If a user edits HTML directly and saves, the previous version is lost unless they manually saved a version first
- AI-generated content that replaces existing content is not auto-snapshotted

The `restoreFromHistory` function correctly auto-snapshots before restoring, but the regular update path does not.

**Fix approach:** Optionally auto-create a history entry in `updateWidget` when `htmlContent` or `cssContent` changes. This could be gated by a parameter to avoid creating entries for metadata-only changes (like toggling `isActive`).

### 21. `updateWidgetSchema` Loses the `.refine()` Validation

**File:** `packages/core/src/modules/widgets/widgets.validation.ts` (line 46)

```typescript
export const updateWidgetSchema = widgetBaseSchema.partial();
```

**Problem:** The create schema has a `.refine()` that enforces `referenceCollectionId` is required when `placementRule` is `before_collection` or `after_collection`. The update schema is `.partial()` on the base (before `.refine()`), so this cross-field validation is completely absent on updates. A user could set `placementRule: "before_collection"` in one update and clear `referenceCollectionId` in another, resulting in an invalid state.

**Fix approach:** Apply `.refine()` after `.partial()`, or add a `.superRefine()` that only validates the cross-field constraint when both fields are present.

### 22. Loader Fetches Full Widget List Just for Collections

**File:** `apps/admin/src/loaders/admin/widgets.ts` (lines 67-68)

```typescript
const listData = await apiGet<WidgetListResponse>("/widgets");
const availableCollections = listData.availableCollections || [];
```

**Problem:** The `getWidgetFormPageData` function (used by the create/edit page) fetches the full widget list response just to extract `availableCollections`. This loads all widgets (with their HTML content) only to discard them. There should be a dedicated endpoint or query for just the collections list.

---

## LLM-Friendliness

### Strengths

1. **Excellent README:** `packages/core/src/modules/widgets/README.md` is 131 lines with complete function signatures, endpoint tables, file inventory, placement rules, and known gaps. This is one of the best domain READMEs in the codebase.

2. **Clear service function naming:** `listWidgets`, `getWidgetById`, `createWidget`, `updateWidget`, `deleteWidget`, `createHistoryEntry`, `getWidgetHistory`, `restoreFromHistory`, `deleteHistoryEntry` -- all self-documenting.

3. **Well-structured type exports:** The barrel `index.ts` re-exports everything from service and validation. Admin types are centralized in `widget-list/types/index.ts`.

4. **Consistent import patterns:** Service imports follow the `@scalius/core/modules/widgets` convention. Admin components use `@/` aliases consistently.

5. **Comment headers:** Service file uses section comments (`// Queries`, `// Mutations`, `// History`) that make navigation easy.

### Weaknesses

1. **Admin component split is non-obvious:** Widget UI lives in TWO separate directories:
   - `apps/admin/src/components/admin/widget-list/` -- list page components
   - `apps/admin/src/components/admin/widgets/` -- form page components
   A new developer (or LLM) looking for "widget components" might find one but miss the other.

2. **AI hooks are complex with minimal documentation:** `useAiGenerator.ts` (360 lines), `useAiImprover.ts` (354 lines), and `useStagedGeneration.ts` (382 lines) are large hooks with multi-step async workflows. Only `useAiImprover` has a JSDoc header explaining what it does. The others have no module-level documentation.

3. **The `WidgetForm` component comment block at the top** (lines 1-11) is a historical changelog ("Major improvements:") rather than a description of what the component does and how to use it.

4. **Mixed `Widget` type sources:** The admin uses `Widget` from `@/types/api-responses` (manually defined), while the core uses `Widget` from `@scalius/database/schema` (inferred from Drizzle). These have different timestamp types (one has `Date`, the other has `number`/`timestamp` mode). The loader in `widgets.ts` has to manually convert between them.

---

## Recommended Changes

### Priority 1 -- Correctness / Safety

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 1 | Wrap `restoreFromHistory` in `db.batch()` | `widgets.service.ts` | Small |
| 2 | Add empty-array guard to all bulk functions | `widgets.service.ts` | Small |
| 3 | Remove try/catch from update route (let `NotFoundError` propagate) | `apps/api/src/routes/admin/widgets.ts` | Small |
| 4 | Add `.refine()` back to `updateWidgetSchema` for cross-field validation | `widgets.validation.ts` | Small |
| 5 | Replace `aiContext: z.any()` with the actual schema or size-limited string | `widgets.validation.ts` | Small |

### Priority 2 -- Robustness

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 6 | Add existence check to `deleteWidget` (throw `NotFoundError`) | `widgets.service.ts` | Small |
| 7 | Add auto-snapshot on content change in `updateWidget` | `widgets.service.ts` | Medium |
| 8 | Add pagination + retention limit to `getWidgetHistory` | `widgets.service.ts` | Medium |
| 9 | Add HTML sanitization to `createWidget` and `updateWidget` | `widgets.service.ts` | Medium |

### Priority 3 -- Performance

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 10 | Add pagination to `listWidgets`, exclude HTML/CSS from list query | `widgets.service.ts`, `admin/widgets.ts` route | Medium |
| 11 | Add dedicated "list collections" endpoint or reuse existing one for widget form loader | `loaders/admin/widgets.ts` | Small |
| 12 | Move public widget routes to use core service functions | `apps/api/src/routes/widgets.ts` | Small |

### Priority 4 -- Maintainability

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 13 | Extract `useWidgetHistory` hook from `WidgetForm.tsx` | `WidgetForm.tsx`, new hook file | Medium |
| 14 | Extract shared SSE streaming + parsing utility from the three AI hooks | `useAiGenerator.ts`, `useAiImprover.ts`, `useStagedGeneration.ts` | Medium |
| 15 | Use form submit via `clientPost`/`clientPut` instead of raw `fetch()` | `WidgetForm.tsx` | Small |
| 16 | Import `WidgetPlacementRule` from `@scalius/database` in loader instead of inlining | `loaders/admin/widgets.ts` | Small |
| 17 | Extract `convertTimestampToISO` to `@scalius/shared` | `apps/api/src/routes/widgets.ts` | Small |
| 18 | Type `widgetSchema` timestamps properly in entity schemas | `apps/api/src/schemas/entities.ts` | Small |

---

## File Index

### Schema
- `packages/database/src/schema/content.ts` -- `widgets` table (lines 39-75), `widgetHistory` table (lines 77-90)
- `packages/database/src/schema/enums.ts` -- `WidgetPlacementRule` enum (lines 88-96)

### Core Service
- `packages/core/src/modules/widgets/widgets.service.ts` -- All queries, mutations, history operations
- `packages/core/src/modules/widgets/widgets.validation.ts` -- Zod schemas for create/update
- `packages/core/src/modules/widgets/index.ts` -- Barrel exports
- `packages/core/src/modules/widgets/README.md` -- Domain documentation

### API Routes
- `apps/api/src/routes/admin/widgets.ts` -- 16 admin endpoints (CRUD, bulk ops, history)
- `apps/api/src/routes/widgets.ts` -- 2 public endpoints (active homepage, single widget)
- `apps/api/src/schemas/entities.ts` -- `widgetSchema` (lines 382-397)

### Admin UI - List
- `apps/admin/src/pages/admin/widgets/index.astro` -- List page
- `apps/admin/src/pages/admin/widgets/trash.astro` -- Trash page
- `apps/admin/src/loaders/admin/widgets.ts` -- SSR data loading
- `apps/admin/src/components/admin/widget-list/WidgetsList.tsx` -- Main list component
- `apps/admin/src/components/admin/widget-list/types/index.ts` -- Type definitions
- `apps/admin/src/components/admin/widget-list/hooks/useWidgets.ts` -- Widget state hook
- `apps/admin/src/components/admin/widget-list/hooks/useWidgetActions.ts` -- CRUD action hook
- `apps/admin/src/components/admin/widget-list/hooks/useBulkActions.ts` -- Bulk action hook
- `apps/admin/src/components/admin/widget-list/components/WidgetTable.tsx` -- Table component
- `apps/admin/src/components/admin/widget-list/components/WidgetRow.tsx` -- Row component
- `apps/admin/src/components/admin/widget-list/components/WidgetToolbar.tsx` -- Toolbar
- `apps/admin/src/components/admin/widget-list/components/WidgetStatistics.tsx` -- Stats cards
- `apps/admin/src/components/admin/widget-list/components/WidgetDeleteDialog.tsx` -- Delete confirmation

### Admin UI - Form
- `apps/admin/src/pages/admin/widgets/[id].astro` -- Create/edit page (handles both via "create" ID)
- `apps/admin/src/components/admin/widgets/WidgetForm.tsx` -- Main form component (578 lines)
- `apps/admin/src/components/admin/widgets/widget-form/types.ts` -- Form-specific types
- `apps/admin/src/components/admin/widgets/widget-form/WidgetDetails.tsx` -- Name, HTML, CSS fields
- `apps/admin/src/components/admin/widgets/widget-form/WidgetPlacement.tsx` -- Placement rule, collection, sort, active toggle
- `apps/admin/src/components/admin/widgets/widget-form/WidgetHistoryModal.tsx` -- Version history dialog
- `apps/admin/src/components/admin/widgets/widget-form/WidgetPasteModal.tsx` -- Paste AI response dialog
- `apps/admin/src/components/admin/widgets/widget-form/FullScreenEditor.tsx` -- Fullscreen preview/improvement editor (518 lines)
- `apps/admin/src/components/admin/widgets/widget-form/AiAssistant.tsx` -- AI generation panel
- `apps/admin/src/components/admin/widgets/widget-form/AiContextManager.tsx` -- Image/product/category context picker
- `apps/admin/src/components/admin/widgets/widget-form/useAiContext.ts` -- Context state hook
- `apps/admin/src/components/admin/widgets/widget-form/useAiGenerator.ts` -- AI generation hook
- `apps/admin/src/components/admin/widgets/widget-form/useAiImprover.ts` -- AI improvement hook
- `apps/admin/src/components/admin/widgets/widget-form/useStagedGeneration.ts` -- Multi-section staged generation hook

### Storefront
- `apps/storefront/src/lib/shortcodes.ts` -- Widget shortcode rendering

### Types
- `apps/admin/src/types/api-responses.ts` -- `Widget`, `WidgetHistoryEntry`, `WidgetListResponse` (lines 427-444)
