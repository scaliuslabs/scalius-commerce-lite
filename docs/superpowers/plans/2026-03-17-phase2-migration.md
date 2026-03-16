# Phase 2: Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all admin data fetching from direct DB access to API calls, remove `@scalius/database` from admin bundle, fix security issues.

**Architecture:** Fill API gaps first (new endpoints), then convert all 9 loaders to use `apiGet()` from Phase 1, then fix security issues in API routes.

**Tech Stack:** Astro 6, Hono + @hono/zod-openapi, Drizzle ORM, Zod, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-17-admin-refactoring-design.md` — Phase 2 (sections 2.1–2.4)

**Prerequisites:** Phase 1 Foundation complete (middleware split, shared hooks created, scripts extracted)

**Execution:** Sequential — Task 1 (API gaps) BLOCKS Task 2 (loader migration). Task 3 (security) can overlap with Task 2.

---

## Task 1: Fill API Gaps

New API endpoints needed before loaders can migrate. All follow existing patterns: `createRoute()` + Zod schemas + `ok()`/`created()`/`noContent()`.

**Files:**
- Modify: `apps/api/src/routes/admin/products.ts` — add stats endpoint
- Modify: `apps/api/src/routes/admin/customers.ts` — add history endpoint
- Modify: `apps/api/src/routes/admin/categories.ts` — add form-options endpoint
- Modify: `apps/api/src/routes/admin/collections.ts` — add form-options endpoint
- Modify: `apps/api/src/routes/admin/orders.ts` — add form-data endpoint
- Modify: `apps/api/src/routes/admin/widgets.ts` — add 3 history endpoints
- Modify: `apps/api/src/routes/admin/navigation.ts` — expand from 1 GET to full CRUD
- Modify: `apps/api/src/app.ts` — register any new route groups if needed

**Context:** Each endpoint delegates to `@scalius/core` service functions. The response shapes must match what the current loaders return so admin pages need zero changes. Reference current loaders at `apps/admin/src/loaders/admin/*.ts` for exact shapes.

- [ ] **Step 1: Read all 9 current loader files**

Read every file in `apps/admin/src/loaders/admin/` to understand exactly what data shapes each loader function returns. These are the contracts that new API endpoints must match.

- [ ] **Step 2: Read existing API route files**

Read the route files being modified to understand existing patterns: `apps/api/src/routes/admin/products.ts`, `customers.ts`, `categories.ts`, `collections.ts`, `orders.ts`, `widgets.ts`, `navigation.ts`.

- [ ] **Step 3: Add `GET /admin/products/stats`**

In `apps/api/src/routes/admin/products.ts`, add a stats endpoint that returns:
```typescript
{ totalProducts: number, activeProducts: number, productsWithImages: number, categoriesCount: number }
```
Use the `getProductStats()` and `getCategoryStats()` functions from `@scalius/core/modules/products`.

- [ ] **Step 4: Add `GET /admin/customers/{id}/history`**

In `apps/api/src/routes/admin/customers.ts`, add an endpoint that returns:
```typescript
{ customer: Customer, history: CustomerHistory[], orders: Order[] }
```
Reference `apps/admin/src/loaders/admin/customers.ts` `getCustomerHistoryData()` for the exact query logic.

- [ ] **Step 5: Add `GET /admin/categories/form-options`**

In `apps/api/src/routes/admin/categories.ts`, add a lightweight endpoint:
```typescript
{ categories: { id: string, name: string }[] }
```
Simple query: active categories, ordered by name, no pagination.

- [ ] **Step 6: Add `GET /admin/collections/form-options`**

In `apps/api/src/routes/admin/collections.ts`, add:
```typescript
{ categories: { id: string, name: string }[], products: { id: string, name: string, price: number }[] }
```
Reference `apps/admin/src/loaders/admin/catalog.ts` `getCollectionFormOptions()`.

- [ ] **Step 7: Add `GET /admin/orders/{id}/form-data`**

In `apps/api/src/routes/admin/orders.ts`, add an endpoint that returns order data with product/variant options for the edit form:
```typescript
{ order: Order, products: ProductWithVariants[] }
```
Reference `apps/admin/src/loaders/admin/orders.ts` `getOrderEditData()`.

- [ ] **Step 8: Add widget history endpoints**

In `apps/api/src/routes/admin/widgets.ts`, add 3 endpoints:
- `GET /admin/widgets/{id}/history` — list version history
- `POST /admin/widgets/{id}/history/{versionId}/restore` — restore a version
- `DELETE /admin/widgets/{id}/history/{versionId}` — delete a version

The `widgetHistory` table already exists in the schema. Reference `apps/admin/src/components/admin/widgets/WidgetForm.tsx` lines 314, 323, 342 for the expected request/response format.

- [ ] **Step 9: Expand navigation CRUD**

In `apps/api/src/routes/admin/navigation.ts` (currently 27 lines, skeleton), add:
- `POST /admin/navigation` — create navigation config
- `PUT /admin/navigation/{id}` — update navigation config
- `DELETE /admin/navigation/{id}` — delete navigation config

Reference `@scalius/core/modules/navigation/navigation.service.ts` for available service functions.

- [ ] **Step 10: Typecheck and commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git commit -m "feat: add API endpoints for loader migration (stats, history, form-options, widget-history, nav CRUD)"
```

---

## Task 2: Loader → API Migration

Convert all 9 loader files from direct DB imports to `apiGet()` calls. Then clean up the admin bundle.

**Files:**
- Modify: `apps/admin/src/loaders/admin/products.ts`
- Modify: `apps/admin/src/loaders/admin/orders.ts`
- Modify: `apps/admin/src/loaders/admin/customers.ts`
- Modify: `apps/admin/src/loaders/admin/catalog.ts`
- Modify: `apps/admin/src/loaders/admin/widgets.ts`
- Modify: `apps/admin/src/loaders/admin/discounts.ts`
- Modify: `apps/admin/src/loaders/admin/settings.ts`
- Modify: `apps/admin/src/loaders/admin/analytics.ts`
- Modify: `apps/admin/src/loaders/admin/layout.ts`
- Modify: `apps/admin/src/pages/firebase-messaging-sw.js.ts` — migrate from DB to API
- Modify: `apps/admin/package.json` — remove @scalius/database dependency

**Context:** All loaders use `apiGet()` from `apps/admin/src/lib/api-fetch.ts` (created in Phase 1). The admin proxy at `/api/v1/admin/*` transforms `{ success, data: T }` → `{ success, ...T }`. The `apiGet` function strips the `success` flag and returns the rest.

CRITICAL: Each loader function must return EXACTLY the same data shape as before. The Astro pages and React components consuming these loaders must not change at all.

- [ ] **Step 1: Migrate `products.ts` (283 → ~40 lines)**

Replace all DB imports with `apiGet()` calls:
- `getActiveCategories()` → `apiGet<{categories: ...}>("/categories/form-options")`
- `getProductsIndexData(opts)` → `apiGet<...>("/products", params)`
- `getProductEditData(id)` → `apiGet<...>("/products/" + id)`
- `getProductViewData(id)` → `apiGet<...>("/products/" + id)`

Ensure return shapes match exactly. The pages pass these directly to React components.

- [ ] **Step 2: Migrate `orders.ts` (259 → ~35 lines)**

- `getOrdersIndexData(opts)` → `apiGet("/orders", params)`
- `getOrderFormProducts()` → `apiGet("/products", { limit: "999" })`
- `getOrderViewData(id)` → `apiGet("/orders/" + id)`
- `getOrderEditData(id)` → `apiGet("/orders/" + id + "/form-data")`

- [ ] **Step 3: Migrate `customers.ts` (359 → ~30 lines)**

- `getCustomersIndexData(opts)` → `apiGet("/customers", params)`
- `getCustomerEditData(id)` → `apiGet("/customers/" + id)`
- `getCustomerHistoryData(id)` → `apiGet("/customers/" + id + "/history")`

- [ ] **Step 4: Migrate `catalog.ts` (143 → ~25 lines)**

- `getCategoriesIndexData(opts)` → `apiGet("/categories", params)`
- `getCategoryEditData(id)` → `apiGet("/categories/" + id)`
- `getCollectionFormOptions()` → `apiGet("/collections/form-options")`
- `getCollectionEditData(id)` → `apiGet("/collections/" + id)`

- [ ] **Step 5: Migrate `widgets.ts` (143 → ~20 lines)**

- `getWidgetsListPageData(opts)` → `apiGet("/widgets", params)`
- `getWidgetFormPageData(id)` → `apiGet("/widgets/" + id)` + `apiGet("/collections/form-options")`

- [ ] **Step 6: Migrate `discounts.ts` (102 → ~15 lines)**

- `getDiscountsIndexData(opts)` → `apiGet("/discounts", params)`
- `getDiscountEditData(id)` → `apiGet("/discounts/" + id)`

- [ ] **Step 7: Migrate `settings.ts` (64 → ~15 lines)**

- `getGeneralSettingsData()` → `apiGet("/settings/header")` + `apiGet("/settings/footer")`
- `getMetaConversionSettingsData()` → `apiGet("/settings/meta-conversions")`
- `getDeliveryProvidersData()` → `apiGet("/settings/delivery-providers")`

- [ ] **Step 8: Migrate `analytics.ts` (45 → ~10 lines)**

- `getAnalyticsListData()` → `apiGet("/analytics")`
- `getAnalyticsEditData(id)` → `apiGet("/analytics/" + id)`

- [ ] **Step 9: Migrate `layout.ts` (90 → ~20 lines)**

- `getSidebarStorefrontUrl()` → `apiGet("/settings/storefront-url")`
- `getAdminLayoutFirebaseConfig()` → `apiGet("/settings/firebase")`
- `getSetupAdminExists()` → stays in middleware (not a loader concern), remove from this file
- `getAccountSecurityData(userId)` → keep in middleware or migrate to API call

- [ ] **Step 10: Migrate `firebase-messaging-sw.js.ts`**

Replace direct DB access (`import { db }` from `@scalius/database/client`) with fetch from `GET /api/v1/auth/firebase-config` which already exists.

- [ ] **Step 11: Remove @scalius/database from admin**

In `apps/admin/package.json`, remove `@scalius/database` from dependencies.

Run: `pnpm install`
Run: `pnpm typecheck`

If typecheck fails, some file still imports from @scalius/database. Find and fix it.

- [ ] **Step 12: Verify no DB imports remain**

Run: `grep -r "@scalius/database" apps/admin/src/ --include="*.ts" --include="*.tsx" --include="*.astro"`
Expected: Zero results (except possibly type-only imports in .d.ts files)

- [ ] **Step 13: Commit**

```bash
git commit -m "refactor: migrate all admin loaders from direct DB to API calls, remove @scalius/database"
```

---

## Task 3: Security Fixes

Fix the 9 security and correctness issues identified in the codebase audit.

**Files:**
- Modify: `apps/api/src/routes/admin/fraud-checker.ts` — add Zod validation
- Modify: `apps/api/src/routes/admin/openrouter.ts` — add Zod validation
- Modify: `apps/api/src/routes/admin/settings/site.ts` — add Zod validation, fix global db import
- Modify: `apps/api/src/routes/admin/settings/delivery-providers.ts` — add Zod validation
- Modify: `apps/api/src/routes/admin/settings/system.ts` — fix global db import
- Modify: `apps/api/src/routes/admin/settings/integrations.ts` — fix global db import
- Modify: `apps/api/src/routes/admin/auth-management.ts` — add rate limiting to setup
- Modify: `apps/api/src/routes/admin/ai-prompts.ts` — fix response format

- [ ] **Step 1: Read each file to understand current state**

Read all 8 files listed above.

- [ ] **Step 2: Add Zod schemas to fraud-checker.ts**

Lines 54 and 87 use `c.req.json()` without validation. Add Zod schemas for provider create/update:
```typescript
const fraudCheckerProviderSchema = z.object({
  name: z.string().min(1),
  apiUrl: z.string().url(),
  apiKey: z.string().min(1),
  isActive: z.boolean().optional(),
  providerType: z.string().optional(),
});
```

- [ ] **Step 3: Add Zod schema to openrouter.ts**

The POST /generate endpoint at line ~97 uses `c.req.json()` without validation. Add schema:
```typescript
const generateContentSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1),
  stream: z.boolean().optional(),
  // ... other fields based on what the handler expects
});
```

Read the handler to understand what fields it actually uses.

- [ ] **Step 4: Add Zod schemas to settings/site.ts**

Line 58 uses `c.req.json()` without validation. Add schema for currency settings.

- [ ] **Step 5: Add Zod schema to settings/delivery-providers.ts**

Lines 90-91 use `c.req.json()` without validation. Add schema for provider create/update.

- [ ] **Step 6: Fix global db imports**

In `settings/site.ts`, `settings/system.ts`, and `settings/integrations.ts`, replace:
```typescript
import { db } from "@scalius/database/client";
```
with:
```typescript
const db = c.get("db");
```
within each route handler. Use the per-request context instead of global singleton.

- [ ] **Step 7: Add rate limiting to setup endpoint**

In `auth-management.ts` line ~490, add KV-based rate limiting to the setup route:
- 5 requests per IP per hour
- Use `c.env.CACHE` KV namespace for storage
- Key format: `setup_rate:{ip}`
- Return 429 if exceeded

- [ ] **Step 8: Fix ai-prompts.ts response format**

Line 53 returns `c.text()` instead of JSON. First check what the admin consumer expects — if it's the WidgetForm AI context, it likely expects JSON. Change to `ok(c, { prompt: text })`.

Read `apps/admin/src/components/admin/widgets/WidgetForm.tsx` to verify the expected format.

- [ ] **Step 9: Typecheck and commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git commit -m "fix: add Zod validation to 4 endpoints, fix global db imports, rate-limit setup, fix response format"
```

---

## Phase 2 Completion Verification

After all 3 tasks complete:

- [ ] `pnpm typecheck` passes with zero errors
- [ ] `grep -r "@scalius/database" apps/admin/src/` returns zero results (except type-only)
- [ ] All admin pages load data correctly (product list, order list, customer list, etc.)
- [ ] API gaps filled: products/stats, customers/history, form-options, widget-history, nav CRUD all respond
- [ ] Security: No unvalidated POST endpoints, no global db imports, setup is rate-limited

Phase 2 is complete. Phase 3 (Refinement) plan will be written separately.
