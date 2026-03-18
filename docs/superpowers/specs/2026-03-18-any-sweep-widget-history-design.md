# Any Type Sweep + Widget History — Design Spec

**Date**: 2026-03-18
**Status**: Approved
**Scope**: Two sequential priorities — systematic `any` type elimination across the admin/core/API, then Widget History write-side implementation.

## Context

Three hardening sessions (33 + Phase 1+2 + Phase 3 commits) left the codebase functionally correct with all 23 admin pages verified. Two cleanup priorities remain:

1. **~228 explicit `any` instances** across admin (~182), core (~35), shared (~9), database (~2) plus **~384 untyped catch blocks** across admin (~192), API (~110), and core (~82). Of the explicit instances, ~170 are fixable; ~58 are legitimate (Drizzle batch, Astro middleware locals, zodResolver, external libs). Note: catch block variable names include `error`, `e`, and `err`; ~12 empty `catch {}` blocks in the API are already valid.

2. **Widget History write-side missing** — the `widgetHistory` table, read/restore/delete API endpoints, and admin UI all exist, but nothing ever creates history entries. The table is always empty.

## Priority 1: `any` Type Sweep

### 1.1 Centralized Type Definitions

Extend `apps/admin/src/types/api-responses.ts` with interfaces derived from actual API route return values. These are temporary — they'll be replaced by SDK-generated types once `pnpm generate:sdk` runs.

**New interfaces:**

```typescript
// Shared
interface PaginationResponse {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Products domain
interface ProductListItem {
  id: string;
  name: string;
  price: number;
  compareAtPrice: number | null;
  sku: string | null;
  barcode: string | null;
  stock: number;
  reserved: number;
  isActive: boolean;
  categoryId: string | null;
  categoryName: string | null;
  primaryImage: string | null;
  variantCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ProductStats {
  total: number;
  active: number;
  inactive: number;
  outOfStock: number;
  categories: number;
}

interface ProductDetail { /* full product from GET /products/:id */ }
interface ProductVariantDetail { /* variant with stock, sku, barcode, attributes */ }
interface ProductImageDetail { /* id, url, isPrimary, sortOrder */ }

// Orders domain
interface OrderListItem { /* from GET /orders list */ }
interface OrderDetail { /* from GET /orders/:id */ }
interface OrderFormData { /* from GET /orders/:id/form-data */ }

// Customers domain
interface CustomerListItem { /* from GET /customers list */ }
interface CustomerDetail { /* from GET /customers/:id */ }
interface CustomerHistoryRecord { /* from GET /customers/:id/history */ }

// Discounts domain
interface DiscountListItem { /* from GET /discounts list */ }
interface DiscountDetail { /* from GET /discounts/:id */ }

// Widgets domain
interface WidgetHistoryEntry {
  id: string;
  widgetId: string;
  htmlContent: string;
  cssContent: string | null;
  reason: string;
  createdAt: number; // Unix timestamp — Drizzle Date goes through JSON.stringify → arrives as number via admin proxy
}

// Categories domain
interface CategoryFormOption { id: string; name: string; }

// Analytics
interface AnalyticsScript { id: string; name: string; script: string; isActive: boolean; }

// Dashboard
interface DashboardStats { /* revenue, orderCount, avgOrderValue, etc. */ }
interface DailyActivityPoint { date: string; orders: number; revenue: number; }

// Delivery/Shipping
interface Shipment { /* id, orderId, provider, trackingId, status, etc. */ }
interface ShipmentStatus { status: string; label: string; }
interface DeliveryProviderConfig { /* id, name, type, isActive, etc. */ }

// Settings/Config
interface HeaderConfig { /* navigation tree structure */ }
interface FooterConfig { /* footer menu structure */ }
interface FirebasePublicConfig { apiKey: string; authDomain: string; projectId: string; /* ... */ }
interface MetaConversionsSettings { /* pixelId, accessToken, etc. */ }
interface FraudCheckerProvider { /* id, name, isActive, config */ }

// AI/OpenRouter
interface ModelInfo { id: string; name: string; supportsVision?: boolean; supportsAudio?: boolean; modality?: string; }
interface OpenRouterMessage { role: string; content: string | Array<{ type: string; [key: string]: unknown }> }
```

The exact field shapes will be derived by reading each API route's actual return value during implementation. The interfaces above show the structure; field names and types will be verified line-by-line.

### 1.2 Fix `App.Locals` in `env.d.ts`

Add missing properties that force middleware to use `(context.locals as any)`:

```typescript
// In apps/admin/src/env.d.ts, inside App.Locals:
_env?: Env;
_isSuperAdmin?: boolean;
_hasAdminAccess?: boolean;
```

This eliminates 13 `as any` casts across `auth.ts`, `rbac.ts`, `admin-detection.ts`, and `csp.ts`.

### 1.3 Extend `Window` interface

Add globals that force `(window as any)`:

```typescript
// In apps/admin/src/types/window.d.ts or env.d.ts:
declare global {
  interface Window {
    __adminSidebarPageLoadBound__?: boolean;
  }
}

// In packages/shared/src/currency.ts (module-level declare):
declare global {
  interface Window {
    __CURRENCY_SYMBOL__?: string;
    __CURRENCY_CODE__?: string;
  }
}
```

Some of these may already exist in `window.d.ts` — verify before adding duplicates.

### 1.4 Fix by Category

#### A. Loaders — 45 instances (HIGH PRIORITY)

All in `apps/admin/src/loaders/admin/`. Every loader uses `apiGet<any>` — replace with proper generic types.

**Files**: `products.ts` (~10), `orders.ts` (~12), `catalog.ts` (~8), `widgets.ts` (~7), `customers.ts` (~6), `discounts.ts` (~4), `settings.ts` (~5), `analytics.ts` (~3), `dashboard.ts` (~3), `layout.ts` (~2). Counts include all `any` usage (not just `apiGet<any>`).

**Pattern**:
```typescript
// Before:
const data = await apiGet<any>("/products", params);
data.products.map((product: any) => ({ ... }));

// After:
const data = await apiGet<{ products: ProductListItem[]; pagination: PaginationResponse }>("/products", params);
data.products.map((product) => ({ ... })); // type inferred
```

#### B. Widget AI Hooks — 16 instances (HIGH PRIORITY)

Files: `useAiGenerator.ts` (4), `useAiImprover.ts` (8), `useAiContext.ts` (2), `useStagedGeneration.ts` (3), `FullScreenEditor.tsx` (1), `AiAssistant.tsx` (1)

**Key fixes**:
- `useAiGenerator(aiContext: any, widget: any)` → `(aiContext: ReturnType<typeof useAiContext>, widget: Widget | undefined | null)`. Note: `ModelInfo` interface already exists locally in useAiGenerator.ts (lines 11-17) — reuse it, don't duplicate.
- `(m: any) => m.id === ...` → `(m: ModelInfo) => ...`
- `messages: any[]` → `messages: OpenRouterMessage[]`
- `(p: any) =>` and `(c: any) =>` → `(p: ProductSearchResult)`, `(c: Category)`. Note: `useAiImprover.ts` needs `ProductSearchResult` and `Category` imports added (already imported in `useAiContext.ts` but not in `useAiImprover.ts`).
- `FullScreenEditor.tsx`: `aiContext?: any` → typed aiContext prop
- `AiAssistant.tsx`: `widget: any` → `Widget | undefined | null`
- `useAiImprover.ts` line 246: `catch (mergeError: any)` → `catch (mergeError: unknown)`

#### C. Component Props — 15 instances (MEDIUM PRIORITY)

**Key files and fixes**:
- `WidgetDetails.tsx`: `register: any; errors: any` → `UseFormRegister<WidgetFormValues>; FieldErrors<WidgetFormValues>`
- `WidgetPlacement.tsx`: `control: any; errors: any; watch: any; register: any` → proper RHF generics
- `WidgetHistoryModal.tsx`: `history: any[]; selectedHistoryItem: any` → `WidgetHistoryEntry[]; WidgetHistoryEntry | null`
- `OrderTableRow.tsx`, `OrderMobileCard.tsx`, `OrderTable.tsx`: `shipment: any` → `Shipment`
- `ShipmentStatusIndicator.tsx`: `onStatusUpdated?: (updatedShipment: any) => void` → `Shipment`
- `ShipmentForm.tsx`: `onSuccess?: (shipment: any) => void` → `Shipment`
- `AiAssistant.tsx`: `widget: any` → `Widget | undefined | null`

#### D. Middleware — 13 instances (resolved by 1.2)

All `(context.locals as any)._env` patterns eliminated by extending `App.Locals`.

#### E. API Catch Blocks — ~110 instances (HIGH PRIORITY, MECHANICAL)

All in `apps/api/src/`. Pattern: `catch (error) {` → `catch (error: unknown) {` (also `catch (e)` and `catch (err)` variants).

~88 are already typed correctly. The remaining ~110 need the `: unknown` annotation. ~12 empty `catch {}` blocks are already valid and need no change. The error handling patterns downstream already use `instanceof Error` checks, so no logic changes needed.

#### F. Core Firebase — 8 instances (MEDIUM PRIORITY)

Files: `packages/core/src/integrations/firebase/admin.ts` (6), `client.ts` (2)

**Fix**: Define `ServiceAccount` and `FirebaseClientConfig` interfaces:
```typescript
interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

interface FirebaseClientConfig {
  apiKey: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
}
```

#### G. Shared Package — 8 instances (LOW PRIORITY)

- `currency.ts` (4): Fixed by adding `declare global { interface Window }` in currency.ts itself (admin `window.d.ts` already has these globals — only shared needs the fix)
- `cors-helper.ts` (2): `(c: any)` → define minimal Hono context type or use `unknown` with type guard
- `json-repair.ts` (3): `any` → `unknown` for parse return types
- `error-utils.ts` (1): `Record<string, any>` → `Record<string, unknown>`

#### H. Database Package — 2 instances (LOW PRIORITY)

- `schema/delivery.ts`: `(): any =>` in self-referential FK → remove `: any` (Drizzle handles arrow function return)
- `client.ts`: `(_db as any)[prop]` → proper type indexing

#### I. API Route Fixes — 14 instances (LOW PRIORITY)

- 6 unnecessary `as unknown as number` timestamp casts in `categories.ts`, `shipping-methods.ts`, `hero.ts` — remove (Drizzle returns Date objects)
- 5 `(c.env as any)?.PROPERTY` in delivery settings routes — type `c.env` properly
- 1 `as unknown as boolean` in `shipping-methods.ts` — remove
- 2 `z.any()` in navigation route — replace with `z.lazy()` for recursive schema

#### J. Admin Catch Blocks — ~192 instances (MECHANICAL)

Same pattern as API: `catch (error) {` → `catch (error: unknown) {` (also `e`, `err` variants).

#### K. Core Catch Blocks — ~82 instances (MECHANICAL)

Same pattern across `packages/core/`.

### 1.5 What NOT to Fix (eslint-disable)

| Pattern | Count | Reason |
|---------|-------|--------|
| `db.batch(... as any)` | 8 | Drizzle D1 batch typing limitation |
| `zodResolver(...) as any` | 1 | @hookform/resolvers upstream issue |
| `calendar.tsx` external lib types | 3 | DayPicker component typing |
| `debounce.ts` generic function | 1 | Legitimate generic constraint |
| `order-form/types.ts` `Record<string, any>` for metadata | 2 | Intentionally flexible key-value |

These should get `// eslint-disable-next-line @typescript-eslint/no-explicit-any` with a comment explaining why.

### 1.6 Verification

After all fixes:
- `pnpm typecheck` must pass with 0 errors (excluding pre-existing SDK api-client error)
- All 23 admin pages must return 200
- Grep for remaining `any` — should match only the ~15 eslint-disabled legitimate cases

---

## Priority 2: Widget History Write-Side

### 2.1 Problem Statement

The widget versioning system has the read side (API endpoints + UI) but no write side. The `widgetHistory` table is always empty because nothing creates entries. Additionally, restoring a version overwrites the current content with no safety net.

### 2.2 Solution: Explicit Save + Auto-Save Before Restore

#### Service Layer Changes

**File**: `packages/core/src/modules/widgets/widgets.service.ts`

Add 4 new functions:

```typescript
import { widgetHistory } from "@scalius/database/schema";

// Snapshots the widget's CURRENT content into history.
// The API handler calls this without content params — the function reads current state.
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
) {
  const [entry] = await db
    .select()
    .from(widgetHistory)
    .where(and(eq(widgetHistory.id, historyId), eq(widgetHistory.widgetId, widgetId)));
  if (!entry) throw new NotFoundError("History entry not found");

  await db.delete(widgetHistory).where(eq(widgetHistory.id, historyId));
}
```

#### API Route Changes

**File**: `apps/api/src/routes/admin/widgets.ts`

1. **Add** `POST /{id}/history` — new endpoint:
   - Request: `{ reason?: string }` (defaults to "Manual save")
   - Calls `createHistoryEntry(db, id, reason)` — function reads current widget content internally
   - Returns: `201 Created` with the history entry

2. **Refactor** existing `GET /{id}/history` to use `getWidgetHistory(db, id)`
3. **Refactor** existing `POST /{id}/history/restore` to use `restoreFromHistory(db, id, historyId)` (which auto-snapshots)
4. **Refactor** existing `DELETE /{id}/history/{versionId}` to use `deleteHistoryEntry(db, id, versionId)`

Import new service functions, remove inline DB queries from route handlers.

#### Admin UI Changes

**File**: `apps/admin/src/components/admin/widgets/WidgetForm.tsx`

1. Add "Save Version" button (next to "Version History", edit mode only):
```tsx
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
```

2. Add save version dialog state:
```typescript
const [isSaveVersionOpen, setIsSaveVersionOpen] = useState(false);
const [versionReason, setVersionReason] = useState("");
```

3. Add save version handler using `clientPost`:
```typescript
const handleSaveVersion = async () => {
  if (!widget?.id) return;
  try {
    await clientPost(`/admin/widgets/${widget.id}/history`, {
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

4. Replace all raw `fetch()` calls with `clientGet`/`clientPost`/`clientDelete`:
   - `openHistory()`: `fetch(url)` → `clientGet<WidgetHistoryEntry[]>(...)`
   - `handleRestore()`: `fetch(url, { method: 'POST' })` → `clientPost(...)`
   - `handleDeleteHistory()`: `fetch(url, { method: 'DELETE' })` → `clientDelete(...)`

5. Type history state:
```typescript
const [history, setHistory] = useState<WidgetHistoryEntry[]>([]);
const [selectedHistoryItem, setSelectedHistoryItem] = useState<WidgetHistoryEntry | null>(null);
```

6. Add a small `AlertDialog` for the save version prompt (reason input + confirm).

**File**: `apps/admin/src/components/admin/widgets/widget-form/WidgetHistoryModal.tsx`

Replace all `any` types:
```typescript
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

### 2.3 No Schema Changes

The `widgetHistory` table already has all needed columns (`id`, `widgetId`, `htmlContent`, `cssContent`, `reason`, `createdAt`). No migration needed.

### 2.4 No Storefront Changes

The storefront only reads active widgets (`GET /widgets/active/homepage`, `GET /widgets/:id`). Widget history is admin-only. No storefront changes needed.

### 2.5 Verification

- Create a widget, edit it, click "Save Version" — verify history entry appears in modal
- Edit again, save another version — verify both entries appear chronologically
- Click "Restore This Version" on older entry — verify:
  - Widget content reverts to old version
  - A new "Auto-saved before restore" entry appears in history
- Delete a history entry — verify it disappears
- `pnpm typecheck` passes
- Test in dev mode (Vite proxy) AND conceptually verify production path (admin proxy envelope)

---

## Files Changed Summary

### Priority 1 (any sweep)

| File | Change |
|------|--------|
| `apps/admin/src/types/api-responses.ts` | Add ~20 response interfaces |
| `apps/admin/src/env.d.ts` | Extend `App.Locals` with `_env`, `_isSuperAdmin`, `_hasAdminAccess` |
| `apps/admin/src/types/window.d.ts` | Add `__adminSidebarPageLoadBound__` |
| `apps/admin/src/loaders/admin/*.ts` (9 files) | Replace `apiGet<any>` with typed generics |
| `apps/admin/src/components/admin/widgets/widget-form/useAiGenerator.ts` | Type params and callbacks |
| `apps/admin/src/components/admin/widgets/widget-form/useAiImprover.ts` | Type params and callbacks |
| `apps/admin/src/components/admin/widgets/widget-form/useAiContext.ts` | Type callbacks |
| `apps/admin/src/components/admin/widgets/widget-form/useStagedGeneration.ts` | Type messages param |
| `apps/admin/src/components/admin/widgets/widget-form/WidgetDetails.tsx` | Type RHF props |
| `apps/admin/src/components/admin/widgets/widget-form/WidgetPlacement.tsx` | Type RHF props |
| `apps/admin/src/components/admin/widgets/widget-form/AiAssistant.tsx` | Type widget prop |
| `apps/admin/src/components/admin/widgets/widget-form/FullScreenEditor.tsx` | Type aiContext prop |
| `apps/admin/src/components/admin/order-list/components/*.tsx` (4 files) | Shipment types |
| `apps/admin/src/components/admin/shared/ShipmentStatusIndicator.tsx` | Shipment type |
| `apps/admin/src/components/admin/shared/ShipmentForm.tsx` | Shipment type |
| `apps/admin/src/middleware/*.ts` (4 files) | Remove `as any` (uses extended Locals) |
| `apps/admin/src/pages/admin/categories/index.astro` | Type local vars |
| `apps/admin/src/pages/admin/discounts/index.astro` | Type mapper |
| Various admin components (~15 files) | Misc `any` → proper types |
| `apps/api/src/**/*.ts` (~29 files) | `catch (error)` → `catch (error: unknown)` |
| `packages/core/src/**/*.ts` (~25 files) | `catch (error)` → `catch (error: unknown)` |
| `packages/core/src/integrations/firebase/admin.ts` | ServiceAccount interface |
| `packages/core/src/integrations/firebase/client.ts` | FirebaseClientConfig interface |
| `packages/shared/src/currency.ts` | Window interface extension |
| `packages/shared/src/cors-helper.ts` | Type context param |
| `packages/shared/src/json-repair.ts` | `any` → `unknown` |
| `packages/shared/src/error-utils.ts` | `Record<string, any>` → `Record<string, unknown>` |
| `packages/database/src/schema/delivery.ts` | Remove unnecessary `: any` |
| `packages/database/src/client.ts` | Type proxy return |

### Priority 2 (Widget History)

| File | Change |
|------|--------|
| `packages/core/src/modules/widgets/widgets.service.ts` | Add 4 history functions |
| `packages/core/src/modules/widgets/index.ts` | Re-export new functions |
| `apps/api/src/routes/admin/widgets.ts` | Add POST endpoint, refactor 3 existing to use service |
| `apps/admin/src/components/admin/widgets/WidgetForm.tsx` | Save Version button + dialog, fix fetch → clientPost, type state |
| `apps/admin/src/components/admin/widgets/widget-form/WidgetHistoryModal.tsx` | `any` → `WidgetHistoryEntry` |
| `apps/admin/src/types/api-responses.ts` | `WidgetHistoryEntry` (included in Priority 1) |

---

## Execution Strategy

**Priority 1** parallelizes well:
- Agent 1: Type definitions file + env.d.ts + window.d.ts
- Agent 2: Loaders (all 9 files)
- Agent 3: Widget AI hooks (4 files) + component props (10 files)
- Agent 4: Middleware (4 files) + Astro pages (~5 files)
- Agent 5: API catch blocks (29 files)
- Agent 6: Core catch blocks + Firebase types + shared package
- Agent 7: Database + API route fixes

**Priority 2** is sequential (service → routes → UI) — one agent or orchestrated.

### Success Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| 1 | `pnpm typecheck` passes (0 errors, excluding SDK) | Run after each agent completes |
| 2 | Remaining `any` count matches eslint-disabled list (~15) | `grep -rn ': any\|as any' apps/admin/ packages/core/ packages/shared/ packages/database/ \| grep -v eslint-disable \| grep -v node_modules \| wc -l` |
| 3 | All 23 admin pages return 200 | Spot-check after priority 1 |
| 4 | Widget "Save Version" creates history entry | Manual test |
| 5 | Widget "Restore" auto-snapshots current state | Manual test |
| 6 | No raw `fetch()` in WidgetForm history calls | Grep verification |
| 7 | All catch blocks typed as `unknown` | `grep 'catch (error)' \| grep -v unknown \| wc -l` should be ~0 |

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Type definitions drift from actual API | Temporary — SDK regeneration replaces them |
| Catch block changes break error handling | Downstream code already uses `instanceof Error` checks |
| Widget history grows unbounded | Acceptable — CASCADE delete cleans up on widget deletion; future: add max entries per widget |
| Parallel agents touch same files | File ownership boundaries defined per agent |
