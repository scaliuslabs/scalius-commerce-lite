# Any Type Sweep + Widget History Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate ~228 explicit `any` types and ~384 untyped catch blocks across the monorepo, then implement the missing widget version history write-side.

**Architecture:** Priority 1 (type sweep) creates a type infrastructure foundation (Task 1), then parallelizes fixes across 7 independent domains. Priority 2 (widget history) is sequential: service → API → UI. No schema migrations needed.

**Tech Stack:** TypeScript, Drizzle ORM, Hono (OpenAPIHono), React 19, react-hook-form, Astro 6, sonner

**Spec:** `docs/superpowers/specs/2026-03-18-any-sweep-widget-history-design.md`

---

## Chunk 1: Type Infrastructure Foundation

### Task 1: Type Infrastructure (MUST complete before Tasks 2-4, 9)

**Files:**
- Modify: `apps/admin/src/types/api-responses.ts`
- Modify: `apps/admin/src/env.d.ts:67-75`
- Modify: `apps/admin/src/types/window.d.ts`

- [ ] **Step 1: Add API response interfaces to `api-responses.ts`**

Add these interfaces after the existing types (after line 279). The file already has Product, Category, Collection, Order, Widget, Page, etc. We're adding shapes for API list/detail responses that loaders consume.

```typescript
// ---------------------------------------------------------------------------
// API Response Shapes (used by loaders + components)
// ---------------------------------------------------------------------------

export interface PaginationResponse {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface WidgetHistoryEntry {
  id: string;
  widgetId: string;
  htmlContent: string;
  cssContent: string | null;
  reason: string;
  createdAt: number;
}

export interface ProductVariantDetail {
  id: string;
  productId: string;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  compareAtPrice: number | null;
  costPerItem: number | null;
  stock: number;
  reserved: number;
  lowStockThreshold: number | null;
  weight: number | null;
  supplier: string | null;
  isDefault: boolean;
  isActive: boolean;
  version: number;
  stockVersion: number;
  createdAt: string | number; // JSON-serialized timestamp
  updatedAt: string | number;
}

export interface ProductImageDetail {
  id: string;
  productId: string;
  url: string;
  altText: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: string | number; // JSON-serialized timestamp
}

export interface OpenRouterMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
}
```

Read the actual API routes and loaders during implementation to verify field names and types. The existing types in the file (Product, Order, Widget, Category, etc.) already cover the primary domain shapes — these additions are for list/pagination responses and sub-domain shapes.

- [ ] **Step 2: Extend `App.Locals` in `env.d.ts`**

In `apps/admin/src/env.d.ts`, add 3 properties to the `App.Locals` interface (around line 68-74):

```typescript
declare namespace App {
  interface Locals {
    user: BetterAuthUser | null;
    session: BetterAuthSession | null;
    permissions: Set<string>;
    cfContext: ExecutionContext;
    apiBaseUrl: string;
    // Middleware-internal properties (set in auth.ts, consumed in rbac.ts/admin-detection.ts)
    _env?: Env;
    _isSuperAdmin?: boolean;
    _hasAdminAccess?: boolean;
  }
}
```

- [ ] **Step 3: Add `__adminSidebarPageLoadBound__` to `window.d.ts`**

In `apps/admin/src/types/window.d.ts`, add the missing property. The file already has `__CURRENCY_SYMBOL__`, `__CURRENCY_CODE__`, etc.

```typescript
export {};

declare global {
  interface Window {
    __USER_ID__?: string;
    __USER_PERMISSIONS__?: string[];
    __IS_SUPER_ADMIN__?: boolean;
    __CURRENCY_SYMBOL__?: string;
    __CURRENCY_CODE__?: string;
    __API_BASE_URL__?: string;
    __adminSidebarPageLoadBound__?: boolean;
  }
}
```

- [ ] **Step 4: Run `pnpm typecheck` to verify no regressions**

Run: `pnpm typecheck`
Expected: 0 errors (excluding pre-existing SDK api-client error)

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/types/api-responses.ts apps/admin/src/env.d.ts apps/admin/src/types/window.d.ts
git commit -m "types: add API response interfaces, extend App.Locals and Window"
```

---

## Chunk 2: Admin Loaders + Widget AI Hooks + Component Props

### Task 2: Admin Loaders (depends on Task 1)

**Files:**
- Modify: `apps/admin/src/loaders/admin/products.ts`
- Modify: `apps/admin/src/loaders/admin/orders.ts`
- Modify: `apps/admin/src/loaders/admin/catalog.ts`
- Modify: `apps/admin/src/loaders/admin/customers.ts`
- Modify: `apps/admin/src/loaders/admin/widgets.ts`
- Modify: `apps/admin/src/loaders/admin/discounts.ts`
- Modify: `apps/admin/src/loaders/admin/settings.ts`
- Modify: `apps/admin/src/loaders/admin/analytics.ts`
- Modify: `apps/admin/src/loaders/admin/dashboard.ts`
- Modify: `apps/admin/src/loaders/admin/layout.ts`

- [ ] **Step 1: Read every loader file and identify each `any` usage**

For each of the 10 loader files, read the full file. For every `apiGet<any>`, `(item: any)`, or `let x: any` — determine the correct type by checking what the API route returns.

Cross-reference with:
- Existing types in `apps/admin/src/types/api-responses.ts`
- API route return shapes in `apps/api/src/routes/admin/` and `apps/api/src/routes/storefront/`

- [ ] **Step 2: Fix all `any` in each loader**

Replace every `apiGet<any>` with the proper generic. Replace every `(item: any) =>` callback with the proper type so TypeScript infers downstream usage.

Pattern:
```typescript
// Before:
const data = await apiGet<any>("/products", params);
data.products.map((product: any) => ({ ... }));

// After (import types from @/types/api-responses):
import type { Product, PaginationResponse } from "@/types/api-responses";
const data = await apiGet<{ products: Product[]; pagination: PaginationResponse }>("/products", params);
data.products.map((product) => ({ ... }));
```

If a loader maps API data to a different shape for the component, keep the mapping but type the input. If new interfaces are needed (e.g., `ProductStats`), add them to `api-responses.ts` first.

- [ ] **Step 3: Run `pnpm typecheck`**

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/loaders/admin/ apps/admin/src/types/api-responses.ts
git commit -m "types: replace all any in admin loaders with proper API response types"
```

### Task 3: Widget AI Hooks + Component Props (depends on Task 1)

**Files:**
- Modify: `apps/admin/src/components/admin/widgets/widget-form/useAiGenerator.ts`
- Modify: `apps/admin/src/components/admin/widgets/widget-form/useAiImprover.ts`
- Modify: `apps/admin/src/components/admin/widgets/widget-form/useAiContext.ts`
- Modify: `apps/admin/src/components/admin/widgets/widget-form/useStagedGeneration.ts`
- Modify: `apps/admin/src/components/admin/widgets/widget-form/WidgetDetails.tsx`
- Modify: `apps/admin/src/components/admin/widgets/widget-form/WidgetPlacement.tsx`
- Modify: `apps/admin/src/components/admin/widgets/widget-form/WidgetHistoryModal.tsx`
- Modify: `apps/admin/src/components/admin/widgets/widget-form/AiAssistant.tsx`
- Modify: `apps/admin/src/components/admin/widgets/widget-form/FullScreenEditor.tsx`
- Modify: `apps/admin/src/components/admin/order-list/components/OrderTableRow.tsx`
- Modify: `apps/admin/src/components/admin/order-list/components/OrderMobileCard.tsx`
- Modify: `apps/admin/src/components/admin/order-list/components/OrderTable.tsx`
- Modify: `apps/admin/src/components/admin/shared/ShipmentStatusIndicator.tsx`
- Modify: `apps/admin/src/components/admin/shared/ShipmentForm.tsx`

- [ ] **Step 1: Read all widget-form hook files and type params/callbacks**

Key fixes for each file:

**useAiGenerator.ts:**
- Line 19: `(aiContext: any, widget: any)` → `(aiContext: ReturnType<typeof useAiContext>, widget: Widget | undefined | null)` — import `useAiContext` type and `Widget` from `@/types/api-responses`
- Line 57, 59: `(m: any)` → `(m: ModelInfo)` — `ModelInfo` already defined locally at lines 11-17
- Line 162: `messages: any[]` → `messages: OpenRouterMessage[]` — import from `@/types/api-responses`

**useAiImprover.ts:**
- Lines 21-22: `aiContext: any; aiGenerator: any` → proper hook return types
- Lines 57, 59: `(p: any)`, `(c: any)` → `(p: ProductSearchResult)`, `(c: Category)` — add imports from `./types`
- Line 96, 201: `(s: any, idx: number)` → type the section shape
- Line 108: `(m: any)` → `(m: ModelInfo)` — import from useAiGenerator or define locally
- Line 246: `catch (mergeError: any)` → `catch (mergeError: unknown)`

**useAiContext.ts:**
- Lines 39, 91: `(p: any)` → `(p: ProductSearchResult)` — already imported in this file

**useStagedGeneration.ts:**
- Lines 52, 125, 238: `messages: any[]` → `messages: OpenRouterMessage[]`

**FullScreenEditor.tsx:**
- `aiContext?: any` → proper type

**AiAssistant.tsx:**
- `widget: any` → `Widget | undefined | null`

- [ ] **Step 2: Type widget form sub-component props**

**WidgetDetails.tsx:**
```typescript
import type { UseFormRegister, FieldErrors } from "react-hook-form";
import type { WidgetFormValues } from "../WidgetForm";

interface WidgetDetailsProps {
  register: UseFormRegister<WidgetFormValues>;
  errors: FieldErrors<WidgetFormValues>;
  handleShowPreview: () => void;
  onPaste: () => void;
  onImproveExisting?: () => void;
}
```

**WidgetPlacement.tsx:**
```typescript
import type { Control, UseFormRegister, UseFormWatch, FieldErrors } from "react-hook-form";
import type { WidgetFormValues } from "../WidgetForm";

interface WidgetPlacementProps {
  control: Control<WidgetFormValues>;
  errors: FieldErrors<WidgetFormValues>;
  watch: UseFormWatch<WidgetFormValues>;
  register: UseFormRegister<WidgetFormValues>;
  availableCollections: Pick<Collection, "id" | "name" | "type">[];
  placementRules: WidgetPlacementRule[];
}
```

**WidgetHistoryModal.tsx:** Replace all `any` with `WidgetHistoryEntry` (import from `@/types/api-responses`).

- [ ] **Step 3: Type shipment-related component props**

Read each file, replace `shipment: any` with `DeliveryShipment` (already in `@/types/api-responses`):
- `OrderTableRow.tsx`, `OrderMobileCard.tsx`, `OrderTable.tsx`: `shipment: any` → `DeliveryShipment`
- `ShipmentStatusIndicator.tsx`: `onStatusUpdated?: (updatedShipment: any) => void` → `DeliveryShipment`
- `ShipmentForm.tsx`: `onSuccess?: (shipment: any) => void` → `DeliveryShipment`

- [ ] **Step 4: Run `pnpm typecheck`**

Expected: 0 errors. If there are cascade errors from the typing changes, fix them.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/admin/
git commit -m "types: replace all any in widget hooks, form props, and shipment components"
```

### Task 4: Middleware + Astro Pages + Misc Admin Components (depends on Task 1)

**Files:**
- Modify: `apps/admin/src/middleware/auth.ts`
- Modify: `apps/admin/src/middleware/rbac.ts`
- Modify: `apps/admin/src/middleware/admin-detection.ts`
- Modify: `apps/admin/src/middleware/csp.ts`
- Modify: `apps/admin/src/pages/admin/categories/index.astro`
- Modify: `apps/admin/src/pages/admin/discounts/index.astro`
- Modify: Various other admin components with remaining `any` usage

- [ ] **Step 1: Fix middleware `as any` casts**

With `App.Locals` now extended (Task 1), replace all `(context.locals as any)._env` with `context.locals._env`. Do the same for `_isSuperAdmin` and `_hasAdminAccess`.

For `(cfEnv as any)?.ASSETS` and similar Cloudflare env detection — these are legitimate (proxy object detection). Leave these but add eslint-disable comment explaining why.

For `(session as any).twoFactorVerified` — already fixed in env.d.ts `BetterAuthSession` interface (line 61: `twoFactorVerified?: boolean`). Just remove the `as any` cast.

**Also fix any untyped catch blocks in these middleware files** (since Task 8 should NOT touch files already modified by Task 4 to avoid merge conflicts). Check each middleware file for `catch (error) {` without `: unknown` and fix those too.

- [ ] **Step 2: Fix Astro page `any` types**

**categories/index.astro:** Replace `let formattedCategories: any[] = []`, `let data: any`, `let stats: any` with proper types from `@/types/api-responses`.

**discounts/index.astro:** Replace `(d: any)` mapper with proper `Discount` type.

- [ ] **Step 3: Grep for remaining `any` in admin components**

Run: `grep -rn ': any\|as any' apps/admin/src/components/ --include='*.tsx' --include='*.ts' | grep -v node_modules | grep -v eslint-disable`

For each remaining instance:
- If fixable: fix with proper type
- If legitimate (zodResolver, Drizzle batch, calendar, etc.): add `// eslint-disable-next-line @typescript-eslint/no-explicit-any` with a reason comment

Specific files to check:
- `InventoryManager.tsx`: `let aVal: any` → `unknown`, `icon: any` → `React.ComponentType`
- `CollectionsList.tsx`: `(result: any)` → check if react-beautiful-dnd has `DropResult` type
- `VariantSortModal.tsx`: same DnD pattern
- `VariantTable.tsx`: `draftUpdates?: Record<string, any>` → `Record<string, unknown>`
- `HeaderBuilder.tsx`, `FooterBuilder.tsx`: `migrateConfig(config: any)` → `(config: unknown)`
- `CategoryForm.tsx`: `(error: any)` → `(error: unknown)`
- `FraudCheckerSettings.tsx`: type handler params
- `FirebaseSettingsForm.tsx`: type config objects
- `mediaClient.ts`: `let data: any` → `unknown`
- `AdminLayout.astro`: `(user as any).isSuperAdmin` → use proper type, `(window as any).__adminSidebarPageLoadBound__` → fixed by Task 1
- `ProductForm.tsx`: type attributes
- `AdminNav.ts`, `SideBar.astro`: `icon?: any` → `React.ComponentType` or `typeof LucideIcon`

**Important:** The explicit file list above is NOT exhaustive. The grep results are the source of truth. Fix every `any` instance found by grep that isn't a legitimate exception (spec section 1.5).

- [ ] **Step 4: Add eslint-disable to legitimate `any` cases**

For each case that cannot be fixed (spec section 1.5):
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle batch() requires mixed query type cast
await db.batch(statements as any);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- zodResolver return type mismatch with RHF
resolver: zodResolver(schema) as any,
```

- [ ] **Step 5: Run `pnpm typecheck`**

Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/middleware/ apps/admin/src/pages/ apps/admin/src/components/ apps/admin/src/layouts/
git commit -m "types: fix middleware, Astro pages, and misc admin component any types"
```

---

## Chunk 3: Catch Blocks + Core/Shared/Database/API Fixes

### Task 5: API Catch Blocks (independent — no file overlap with Tasks 2-4)

**Files:**
- Modify: All `.ts` files in `apps/api/src/` with untyped catch blocks (~29 files)

- [ ] **Step 1: Find all untyped catch blocks**

Search for `catch (error)`, `catch (e)`, `catch (err)` WITHOUT `: unknown` in `apps/api/src/`. Exclude empty `catch {}` blocks (already valid).

- [ ] **Step 2: Add `: unknown` to each**

Pattern: `catch (error) {` → `catch (error: unknown) {`

The downstream error handling in these files already uses `instanceof Error` checks or `String(error)`, so no logic changes needed. Just add the type annotation.

- [ ] **Step 3: Run `pnpm typecheck`**

Expected: 0 errors. If any catch block uses `error.message` without a type guard, add `error instanceof Error ? error.message : String(error)`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/
git commit -m "types: annotate all API catch blocks with unknown"
```

### Task 6: Core + Firebase + Shared + Database (independent)

**Files:**
- Modify: All `.ts` files in `packages/core/src/` with untyped catch blocks (~25 files)
- Modify: `packages/core/src/integrations/firebase/admin.ts`
- Modify: `packages/core/src/integrations/firebase/client.ts`
- Modify: `packages/shared/src/currency.ts`
- Modify: `packages/shared/src/cors-helper.ts`
- Modify: `packages/shared/src/json-repair.ts`
- Modify: `packages/shared/src/error-utils.ts`
- Modify: `packages/database/src/schema/delivery.ts`
- Modify: `packages/database/src/client.ts`

- [ ] **Step 1: Fix core catch blocks**

Same pattern as Task 5: `catch (error) {` → `catch (error: unknown) {` across all files in `packages/core/src/`.

For Drizzle `db.batch(... as any)` instances — add eslint-disable comments instead of trying to fix:
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
await db.batch(statements as any);
```

- [ ] **Step 2: Define Firebase interfaces in `firebase/admin.ts`**

Add at the top of the file:
```typescript
interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}
```

Replace all `serviceAccount: any` params with `serviceAccount: ServiceAccount`. Replace `environment?: any` with `environment?: Record<string, unknown>`. Replace class properties `private serviceAccount: any` and `private env: any` with proper types.

- [ ] **Step 3: Define Firebase config interface in `firebase/client.ts`**

Add at the top:
```typescript
interface FirebaseClientConfig {
  apiKey: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
}
```

Replace `config: any` params with `config: FirebaseClientConfig`.

- [ ] **Step 4: Fix shared package**

**currency.ts:** Add `declare global { interface Window { __CURRENCY_SYMBOL__?: string; __CURRENCY_CODE__?: string; } }` at top of file. Replace `(window as any).__CURRENCY_SYMBOL__` with `window.__CURRENCY_SYMBOL__`.

**cors-helper.ts:** Replace `(c: any)` with a minimal context type or `(c: { env: Record<string, unknown>; req: { header: (name: string) => string | undefined } })`.

**json-repair.ts:** Replace `any` return types with `unknown`: `extractAndParseJSON(): unknown`, `parseJSONSafely(): { success: boolean; data?: unknown; error?: string }`, `validateWidgetJSON(data: unknown)`.

**error-utils.ts:** Replace `Record<string, any>` with `Record<string, unknown>`.

- [ ] **Step 5: Fix database package**

**schema/delivery.ts:** Remove `: any` from self-referential FK: `parentId: text("parent_id").references(() => deliveryLocations.id, ...)` (Drizzle handles the circular reference with the arrow function alone).

**client.ts:** Replace `(_db as any)[prop]` with proper type indexing.

- [ ] **Step 6: Run `pnpm typecheck`**

Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add packages/core/ packages/shared/ packages/database/
git commit -m "types: fix catch blocks, Firebase interfaces, shared/database any types"
```

### Task 7: API Route Fixes (independent)

**Files:**
- Modify: `apps/api/src/routes/categories.ts`
- Modify: `apps/api/src/routes/shipping-methods.ts`
- Modify: `apps/api/src/routes/hero.ts`
- Modify: `apps/api/src/routes/admin/settings/delivery-locations.ts`
- Modify: `apps/api/src/routes/admin/settings/delivery-providers.ts`
- Modify: `apps/api/src/routes/admin/navigation.ts`

- [ ] **Step 1: Remove unnecessary timestamp casts**

In `categories.ts`, `shipping-methods.ts`, `hero.ts`: remove `as unknown as number` casts on Drizzle timestamp fields. Drizzle with `mode: "timestamp"` returns `Date` objects. Use `.toISOString()` directly:

```typescript
// Before:
createdAt: unixToDate(category.createdAt as unknown as number)?.toISOString() || null,

// After:
createdAt: category.createdAt instanceof Date ? category.createdAt.toISOString() : null,
```

Check if `unixToDate()` is still needed or if direct `.toISOString()` works. If the service layer uses `sql<number>` casts (like `listWidgets` does), the timestamp arrives as a number — in that case, keep `unixToDate()` but remove the `as unknown as number` cast and just pass the value.

- [ ] **Step 2: Fix `(c.env as any)` casts in delivery settings**

In `delivery-locations.ts` and `delivery-providers.ts`: replace `(c.env as any)?.CACHE` and `(c.env as any)?.CREDENTIAL_ENCRYPTION_KEY` with properly typed access. Check if the Hono app's `Env` type already includes these bindings. If not, add them to the Hono generic or use a typed intermediate:

```typescript
const env = c.env as { CACHE?: KVNamespace; CREDENTIAL_ENCRYPTION_KEY?: string };
```

- [ ] **Step 3: Fix `shipping-methods.ts` boolean cast**

Remove `1 as unknown as boolean` — just pass `true` or `1` directly to the Drizzle `eq()`.

- [ ] **Step 4: Fix `z.any()` in navigation route**

In `navigation.ts`, replace recursive `z.any()` with `z.lazy()`:

```typescript
const navigationItemSchema: z.ZodType<NavigationItem> = z.lazy(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    href: z.string().optional(),
    subMenu: z.array(navigationItemSchema).optional(),
  })
);
```

For `config: z.record(z.string(), z.any())` — this is legitimately dynamic (nav config varies). Add eslint-disable with comment.

- [ ] **Step 5: Run `pnpm typecheck`**

Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/
git commit -m "types: fix API route timestamp casts, env typing, and z.any() schemas"
```

### Task 8: Admin Catch Blocks (independent — but exclude middleware files handled by Task 4)

**Files:**
- Modify: All `.ts` and `.tsx` files in `apps/admin/src/` with untyped catch blocks
- **Exclude**: `apps/admin/src/middleware/*.ts` (already handled by Task 4)

- [ ] **Step 1: Find all untyped catch blocks in admin**

Search for `catch (error)`, `catch (e)`, `catch (err)` WITHOUT `: unknown` in `apps/admin/src/`. Exclude empty `catch {}` blocks. **Exclude middleware files** (`apps/admin/src/middleware/`) since Task 4 handles those.

- [ ] **Step 2: Add `: unknown` to each**

Same mechanical pattern as Task 5. Verify downstream usage handles `unknown` correctly (uses `instanceof Error` or `String(error)`).

- [ ] **Step 3: Run `pnpm typecheck`**

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/
git commit -m "types: annotate all admin catch blocks with unknown"
```

---

## Chunk 4: Priority 1 Verification + Priority 2 Widget History

### Task 9: Priority 1 Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `pnpm typecheck`
Expected: 0 errors (excluding pre-existing SDK api-client error)

- [ ] **Step 2: Count remaining `any` instances**

Run:
```bash
grep -rn ': any\|as any\| any;' apps/admin/src/ packages/core/src/ packages/shared/src/ packages/database/src/ apps/api/src/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '.d.ts' | grep -v eslint-disable | grep -v '\.astro'
```

Expected: Only the ~15 legitimate cases that have eslint-disable comments, plus JSX `IntrinsicElements` in env.d.ts.

If any unfixed instances remain, fix them before proceeding.

### Task 10: Widget History Service Layer (depends on Task 1)

**Files:**
- Modify: `packages/core/src/modules/widgets/widgets.service.ts`
- Modify: `packages/core/src/modules/widgets/index.ts`

- [ ] **Step 1: Add widgetHistory import and 4 new functions**

In `packages/core/src/modules/widgets/widgets.service.ts`:

Modify the existing import at line 4 to add `widgetHistory` (don't create a new import — `widgets` and `collections` are already imported):
```typescript
import { widgets, widgetHistory, collections } from "@scalius/database/schema";
```

Add a type import:
```typescript
import type { WidgetHistory } from "@scalius/database/schema";
```

Add 4 new functions at the bottom of the file (after `restoreWidgets`):

```typescript
// ─────────────────────────────────────────
// History
// ─────────────────────────────────────────

export async function createHistoryEntry(
    db: Database,
    widgetId: string,
    reason: string = "Manual save",
): Promise<WidgetHistory> {
    const widget = await getWidgetById(db, widgetId);
    if (!widget) throw new NotFoundError("Widget not found");

    return db
        .insert(widgetHistory)
        .values({
            id: "whist_" + nanoid(),
            widgetId,
            htmlContent: widget.htmlContent,
            cssContent: widget.cssContent,
            reason,
        })
        .returning()
        .get();
}

export async function getWidgetHistory(db: Database, widgetId: string) {
    const widget = await getWidgetById(db, widgetId);
    if (!widget) throw new NotFoundError("Widget not found");

    return db
        .select()
        .from(widgetHistory)
        .where(eq(widgetHistory.widgetId, widgetId))
        .orderBy(sql`${widgetHistory.createdAt} DESC`);
}

export async function restoreFromHistory(
    db: Database,
    widgetId: string,
    historyId: string,
) {
    const widget = await getWidgetById(db, widgetId);
    if (!widget) throw new NotFoundError("Widget not found");

    const [entry] = await db
        .select()
        .from(widgetHistory)
        .where(and(eq(widgetHistory.id, historyId), eq(widgetHistory.widgetId, widgetId)));
    if (!entry) throw new NotFoundError("History entry not found");

    // Auto-snapshot current state before overwriting
    await createHistoryEntry(db, widgetId, "Auto-saved before restore");

    // Overwrite widget with history entry content
    await db
        .update(widgets)
        .set({
            htmlContent: entry.htmlContent,
            cssContent: entry.cssContent,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(widgets.id, widgetId));

    return { message: "Widget restored from history" };
}

export async function deleteHistoryEntry(
    db: Database,
    widgetId: string,
    historyId: string,
): Promise<void> {
    const [entry] = await db
        .select()
        .from(widgetHistory)
        .where(and(eq(widgetHistory.id, historyId), eq(widgetHistory.widgetId, widgetId)));
    if (!entry) throw new NotFoundError("History entry not found");

    await db.delete(widgetHistory).where(eq(widgetHistory.id, historyId));
}
```

Note: `and` is already imported from `drizzle-orm` in the file.

- [ ] **Step 2: Update barrel export**

In `packages/core/src/modules/widgets/index.ts` — this already re-exports everything from `widgets.service.ts` via `export * from "./widgets.service"`, so no change needed. Verify.

- [ ] **Step 3: Run `pnpm typecheck`**

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/modules/widgets/
git commit -m "feat: add widget history service functions (create, list, restore, delete)"
```

### Task 11: Widget History API Routes

**Files:**
- Modify: `apps/api/src/routes/admin/widgets.ts`

- [ ] **Step 1: Add imports for new service functions**

Add to the existing import from `@scalius/core/modules/widgets`:
```typescript
import {
    listWidgets,
    getWidgetById,
    createWidget,
    updateWidget,
    deleteWidget,
    bulkDeleteWidgets,
    bulkActivateWidgets,
    bulkDeactivateWidgets,
    restoreWidgets,
    createWidgetSchema,
    updateWidgetSchema,
    createHistoryEntry,
    getWidgetHistory,
    restoreFromHistory,
    deleteHistoryEntry,
} from "@scalius/core/modules/widgets";
```

After refactoring all 3 history handlers to use service functions, clean up imports that are no longer needed:
- `widgetHistory` from `@scalius/database/schema` — no longer used in routes
- `widgets` from `@scalius/database/schema` — no longer used in routes (was only used in history restore handler)
- `eq`, `and`, `sql` from `drizzle-orm` — no longer used in routes (service handles all DB access)

Verify each import is truly unused before removing. The route file should only need service function imports after refactoring.

- [ ] **Step 2: Add `POST /{id}/history` endpoint**

Add after the existing `GET /{id}/history` route (after line 325):

```typescript
// ── Create Widget History Entry ──

const createHistoryRoute = createRoute({
    method: "post",
    path: "/{id}/history",
    tags: ["Admin - Widgets"],
    summary: "Save current widget state as a history entry",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({ reason: z.string().optional().default("Manual save") })
                }
            }
        }
    },
    responses: {
        201: { description: "History entry created" },
        404: { description: "Widget not found" }
    }
});

app.openapi(createHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const entry = await createHistoryEntry(db, id, reason);
    return created(c, entry);
});
```

- [ ] **Step 3: Refactor existing history endpoints to use service**

Replace inline DB queries with service function calls:

**GET /{id}/history:**
```typescript
app.openapi(getHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const history = await getWidgetHistory(db, id);
    return ok(c, history);
});
```

**POST /{id}/history/restore:**
```typescript
app.openapi(restoreHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { historyId } = c.req.valid("json");
    const result = await restoreFromHistory(db, id, historyId);
    return ok(c, result);
});
```

**DELETE /{id}/history/{versionId}:**
```typescript
app.openapi(deleteHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id, versionId } = c.req.valid("param");
    await deleteHistoryEntry(db, id, versionId);
    return noContent(c);
});
```

- [ ] **Step 4: Run `pnpm typecheck`**

Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin/widgets.ts
git commit -m "feat: add POST history endpoint, refactor existing history routes to use service"
```

### Task 12: Widget History Admin UI

**Files:**
- Modify: `apps/admin/src/components/admin/widgets/WidgetForm.tsx`
- Modify: `apps/admin/src/components/admin/widgets/widget-form/WidgetHistoryModal.tsx`

- [ ] **Step 1: Type history state and replace raw fetch in WidgetForm.tsx**

Add imports:
```typescript
import { clientGet, clientPost, clientDelete } from "@/lib/api-client-fetch";
import type { WidgetHistoryEntry } from "@/types/api-responses";
import { Save } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
```

Replace state types (lines 118-119):
```typescript
const [history, setHistory] = useState<WidgetHistoryEntry[]>([]);
const [selectedHistoryItem, setSelectedHistoryItem] = useState<WidgetHistoryEntry | null>(null);
```

Add save version state:
```typescript
const [isSaveVersionOpen, setIsSaveVersionOpen] = useState(false);
const [versionReason, setVersionReason] = useState("");
```

- [ ] **Step 2: Replace raw fetch() with clientGet/clientPost/clientDelete**

Replace `openHistory` (lines 311-319):
```typescript
const openHistory = async () => {
    if (widget?.id) {
        setIsHistoryOpen(true);
        try {
            const data = await clientGet<WidgetHistoryEntry[]>(`/widgets/${widget.id}/history`);
            setHistory(data);
        } catch (error: unknown) {
            toast.error("Failed to load version history");
            setHistory([]);
        }
    }
};
```

Replace `handleRestore` (lines 321-338):
```typescript
const handleRestore = async (historyId: string) => {
    if (!widget?.id) return;
    try {
        await clientPost(`/widgets/${widget.id}/history/restore`, { historyId });
        toast.success("Version restored successfully!");
        void navigateTo(window.location.pathname);
    } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : "Failed to restore version");
    }
};
```

Replace `handleDeleteHistory` (lines 340-358):
```typescript
const handleDeleteHistory = async (historyId: string) => {
    if (!widget?.id) return;
    try {
        await clientDelete(`/widgets/${widget.id}/history/${historyId}`);
        toast.success("Version deleted successfully!");
        setHistory(prev => prev.filter(h => h.id !== historyId));
        if (selectedHistoryItem?.id === historyId) {
            setSelectedHistoryItem(null);
        }
    } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : "Failed to delete version");
    }
};
```

Add save version handler:
```typescript
const handleSaveVersion = async () => {
    if (!widget?.id) return;
    try {
        await clientPost(`/widgets/${widget.id}/history`, {
            reason: versionReason.trim() || "Manual save",
        });
        toast.success("Version saved!");
        setIsSaveVersionOpen(false);
        setVersionReason("");
    } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : "Failed to save version");
    }
};
```

- [ ] **Step 3: Add Save Version button and dialog**

Replace the button section (lines 467-476) with:
```tsx
<div className="flex justify-end gap-2">
    {!isCreateMode && (
        <>
            <Button type="button" variant="outline" onClick={() => setIsSaveVersionOpen(true)}>
                <Save className="mr-2 h-4 w-4" /> Save Version
            </Button>
            <Button type="button" variant="outline" onClick={openHistory}>
                <Clock className="mr-2 h-4 w-4" /> Version History
            </Button>
        </>
    )}
    <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Saving..." : submitButtonText}
    </Button>
</div>
```

Add save version dialog before the closing `</div>` of the component (before line 533):
```tsx
{/* Save Version Dialog */}
<AlertDialog open={isSaveVersionOpen} onOpenChange={setIsSaveVersionOpen}>
    <AlertDialogContent>
        <AlertDialogHeader>
            <AlertDialogTitle>Save Version</AlertDialogTitle>
            <AlertDialogDescription>
                Save the current widget content as a version you can restore later.
            </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="py-4">
            <Label htmlFor="versionReason">Reason (optional)</Label>
            <Input
                id="versionReason"
                value={versionReason}
                onChange={(e) => setVersionReason(e.target.value)}
                placeholder="e.g., Before redesign, Final version, etc."
                className="mt-2"
            />
        </div>
        <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setVersionReason("")}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSaveVersion}>Save Version</AlertDialogAction>
        </AlertDialogFooter>
    </AlertDialogContent>
</AlertDialog>
```

- [ ] **Step 4: Type WidgetHistoryModal.tsx**

Replace the props interface:
```typescript
import type { WidgetHistoryEntry } from "@/types/api-responses";

interface WidgetHistoryModalProps {
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    history: WidgetHistoryEntry[];
    selectedHistoryItem: WidgetHistoryEntry | null;
    setSelectedHistoryItem: (item: WidgetHistoryEntry | null) => void;
    handleRestore: (historyId: string) => void;
    handleDeleteHistory: (historyId: string) => void;
    widgetName: string;
}
```

- [ ] **Step 5: Run `pnpm typecheck`**

Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/components/admin/widgets/
git commit -m "feat: add Save Version button, replace raw fetch with clientGet/clientPost, type history state"
```

### Task 13: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `pnpm typecheck`
Expected: 0 errors (excluding pre-existing SDK api-client error)

- [ ] **Step 2: Verify remaining `any` count**

Run: `grep -rn ': any\|as any' apps/admin/src/ packages/core/src/ packages/shared/src/ packages/database/src/ apps/api/src/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v eslint-disable | grep -v '.d.ts'`

Expected: Only ~15 legitimate cases

- [ ] **Step 3: Verify no raw fetch in WidgetForm history handlers**

Run: `grep -n 'fetch(' apps/admin/src/components/admin/widgets/WidgetForm.tsx`

Remaining `fetch()` calls should only be for form submission (`onSubmit`) and AI requests — NOT for history operations.

---

## Dependency Graph

```
Task 1 (types infrastructure) ─┬─► Task 2 (loaders)
                                ├─► Task 3 (widget hooks + props)
                                ├─► Task 4 (middleware + pages)
                                └─► Task 10 (widget history service)
                                         │
Task 5 (API catch blocks)                │
Task 6 (core/shared/db)                  ▼
Task 7 (API route fixes)          Task 11 (widget history API)
Task 8 (admin catch blocks)              │
                                         ▼
                               Task 12 (widget history UI)
                                         │
Task 9 (P1 verification) ◄──────────────┘
                                         │
                               Task 13 (final verification)
```

**Parallel groups:**
- Group A: Task 1 (must complete first)
- Group B (after Task 1): Tasks 2, 3, 4 (parallel — no file overlap)
- Group C (independent): Tasks 5, 6, 7, 8 (parallel — no file overlap with Group B)
- Group D (after Groups B+C): Task 9
- Group E (after Task 1): Tasks 10, 11, 12 (sequential — each depends on previous)
- Group F (after Groups D+E): Task 13
