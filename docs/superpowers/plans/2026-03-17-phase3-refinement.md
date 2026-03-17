# Phase 3: Refinement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split 15+ oversized admin components, eliminate type safety violations, add test infrastructure, and optimize performance — preparing the codebase for rapid feature development at scale.

**Architecture:** Staged waves with parallel subagents. Wave 0 verifies current state. Wave 1 dispatches 4 domain agents to split components in isolated worktrees. Wave 2 dispatches 3 cross-cutting agents for toast migration, tests, and DB indexes. Wave 3 handles lazy-loading and final verification. Each wave gates the next.

**Tech Stack:** Astro 6 + React 19, Hono, Cloudflare Workers/D1, Drizzle ORM, Vitest, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-17-phase3-refinement-design.md`

---

## Chunk 1: Wave 0 — Verification Pass

### Task 1: Start Dev Servers and Verify Every Admin Page

**Executor:** Orchestrator (not a subagent). Must use browser automation to see actual rendered state.

**Files:** None modified. This task produces a bug list only.

- [ ] **Step 1: Start dev servers**

Run: `pnpm dev`
Expected: Admin on :4321, API on :8787. Wait for both to be ready.

- [ ] **Step 2: Verify Dashboard**

Navigate to `http://localhost:4321/admin`. Check:
- Stats cards render with numbers (not "undefined" or empty)
- Chart renders (Recharts)
- Recent orders table shows data
- Console has no errors

- [ ] **Step 3: Verify Products domain**

Navigate to each route, check data renders and console is clean:
- `/admin/products` — list loads, pagination works, search works
- `/admin/products/new` — form renders, category dropdown populates
- Pick a product → `/admin/products/[id]/edit` — data loads, images show, variants load
- Pick a product → `/admin/products/[id]` — view page renders

- [ ] **Step 4: Verify Orders domain**

- `/admin/orders` — list loads, status filters work
- `/admin/orders/new` — form renders, product picker works
- Pick an order → `/admin/orders/[id]` — view with shipments + payments renders

- [ ] **Step 5: Verify Customers domain**

- `/admin/customers` — list loads
- Pick a customer → `/admin/customers/[id]/edit` — form renders
- Pick a customer → `/admin/customers/[id]/history` — history + orders render

- [ ] **Step 6: Verify Categories, Collections, Discounts**

- `/admin/categories` — list, new, edit
- `/admin/collections` — list, new, edit
- `/admin/discounts` — list, new, edit

- [ ] **Step 7: Verify Widgets, Pages, Media, Navigation**

- `/admin/widgets` — list, new, edit (TipTap editor loads)
- `/admin/pages` — list, new, edit
- `/admin/media` — file browser renders
- `/admin/navigation` — nav config renders

- [ ] **Step 8: Verify Settings pages**

- `/admin/settings` — general settings load
- `/admin/settings/checkout` — checkout languages manager renders
- `/admin/settings/shipping` — shipping methods render
- `/admin/settings/delivery` — delivery providers render
- `/admin/settings/payment-gateways` — gateway configs render
- `/admin/settings/meta-conversions` — meta settings render
- `/admin/settings/account` — account settings render
- `/admin/settings/fraud-checker` — fraud checker renders

- [ ] **Step 9: Verify Analytics**

- `/admin/analytics` — list loads
- Pick one → `/admin/analytics/[id]/edit` — edit form renders

- [ ] **Step 10: Document bug list**

Create a structured list of all issues found, partitioned by domain. For each:
- Page URL
- Symptom (blank data, console error, form not submitting, etc.)
- Likely root cause (data shape mismatch, missing API field, wrong envelope parsing)

- [ ] **Step 11: Fix any critical bugs found**

If any page is completely broken (500 error, blank render, crash), fix it before proceeding. Non-critical issues (cosmetic, minor data issues) can be included in Wave 1 agent context.

- [ ] **Step 12: Commit any fixes**

```bash
git add -A && git commit -m "fix: resolve Phase 2 verification bugs found in Wave 0 audit"
```

**Gate:** Proceed to Wave 1 only after all pages at least load without 500 errors.

---

## Chunk 2: Wave 1 — Domain Agent Splits (4 Parallel Agents)

All 4 tasks below run in parallel as isolated subagents (worktrees). Each agent receives the Agent Context Template from the spec plus their domain-specific bug list from Wave 0.

### Task 2: Agent 1 — Products & Catalog Split

**Files:**
- Modify: `apps/admin/src/components/admin/CategoryList.tsx` (1,438 lines → split into directory)
- Modify: `apps/admin/src/components/admin/ProductList.tsx` (1,386 lines → split into directory)
- Modify: `apps/admin/src/components/admin/CollectionForm.tsx` (653 lines → split into directory)
- Modify: `apps/admin/src/components/admin/product-form/variants/BulkVariantGenerator.tsx` (706 lines → split into steps)
- Create: Multiple new files per split (container, sub-components, hooks, index.ts)

**Context to include in agent prompt:**
- Full Agent Context Template from spec (data flow, Vercel patterns, boundaries)
- Bug list for Products/Categories/Collections from Wave 0
- Reference: `apps/admin/src/components/admin/product-form/` as the gold standard (39 files)

- [ ] **Step 1: Read all 4 owned component files fully**

Read each file end-to-end. For each, trace:
- Where does data come from? (useApi? props from Astro page? direct fetch?)
- What state does it manage? (useState, useCallback, useEffect inventory)
- What inline component definitions exist? (Vercel HIGH impact violation)
- What `any` types exist?
- Does it use `useToast`? `window.location.reload()`? `@scalius/database/schema`?

- [ ] **Step 2: Split CategoryList.tsx (1,438 lines)**

Source file is at `apps/admin/src/components/admin/CategoryList.tsx` (flat, not in a subdirectory). Create `apps/admin/src/components/admin/categories/` directory structure and delete the original flat file after split:
- `CategoryListContainer.tsx` — owns useApi data fetching, state, callbacks
- `CategoryTable.tsx` — pure render of category rows with React.memo on each row
- `CategoryFilters.tsx` — search, sort, status filter UI
- `CategoryBulkActions.tsx` — bulk delete, bulk status change
- `hooks/useCategoryList.ts` — extracted state logic (pagination, selection, filters)
- `index.ts` — barrel re-export of CategoryListContainer as default

Apply all shared rules: no inline components, React.memo on rows, derived state, functional setState, toast migration, any fixes, schema import replacement.

- [ ] **Step 3: Split ProductList.tsx (1,386 lines)**

Source file is at `apps/admin/src/components/admin/ProductList.tsx` (flat). Create `apps/admin/src/components/admin/product-list/` directory and delete the original flat file after split:
- `ProductListContainer.tsx` — owns useApi, state, callbacks
- `ProductTable.tsx` — pure render with React.memo rows
- `ProductFilters.tsx` — search, category filter, status filter
- `ProductBulkActions.tsx` — bulk operations
- `hooks/useProductList.ts` — state logic
- `index.ts` — barrel

- [ ] **Step 4: Split CollectionForm.tsx (653 lines)**

Source file is at `apps/admin/src/components/admin/CollectionForm.tsx` (flat). Note: `collections-list/` directory already exists with 7 sub-components — don't conflict with it. Create `apps/admin/src/components/admin/collection-form/` directory and delete the original flat file after split:
- `CollectionFormContainer.tsx` — form state, submission
- `ProductSelector.tsx` — product multi-select
- `CategorySelector.tsx` — category selection
- `index.ts` — barrel

- [ ] **Step 5: Split BulkVariantGenerator.tsx (706 lines)**

Split into wizard steps within the existing variants directory:
- `bulk-generator/SizeColorInput.tsx` — size/color option entry
- `bulk-generator/SkuConfig.tsx` — SKU template configuration
- `bulk-generator/PreviewTable.tsx` — generated variants preview
- `bulk-generator/index.ts` — barrel

- [ ] **Step 6: Update Astro page imports**

Any Astro pages that import the original components need their imports updated to point to the new barrel exports. Verify by grepping for old import paths.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS with zero errors

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor: split Products & Catalog components (CategoryList, ProductList, CollectionForm, BulkVariantGenerator)"
```

---

### Task 3: Agent 2 — Orders, Customers & Discounts Split

**Files:**
- Modify: `apps/admin/src/components/admin/OrderList.tsx` (804 lines → refactor to container)
- Modify: `apps/admin/src/components/admin/CustomerList.tsx` (959 lines → split into directory)
- Modify: `apps/admin/src/components/admin/discount/DiscountList.tsx` (1,367 lines → split into directory)
- Modify: `apps/admin/src/components/admin/discount/AmountOffProductsForm.tsx` (905 lines → split into directory)
- Create: Multiple new files per split

**Context to include in agent prompt:**
- Full Agent Context Template from spec
- Bug list for Orders/Customers/Discounts from Wave 0
- Note: `order-list/` sub-components MAY already exist — check before creating

- [ ] **Step 1: Read all 4 owned component files fully**

Same trace as Agent 1: data sources, state, inline components, any types, toast, reload, schema imports.

- [ ] **Step 2: Refactor OrderList.tsx (804 lines)**

Source file is at `apps/admin/src/components/admin/OrderList.tsx` (flat). Check if `apps/admin/src/components/admin/order-list/` directory already exists with sub-components. If yes:
- Refactor OrderList.tsx into `OrderListContainer.tsx` using existing sub-components
- Extract remaining inline state/filters into `hooks/useOrderList.ts`
- Add React.memo to any row components that don't have it
If no: create the full directory structure as specified.

- [ ] **Step 3: Split CustomerList.tsx (959 lines)**

Source file is at `apps/admin/src/components/admin/CustomerList.tsx` (flat). Create `apps/admin/src/components/admin/customer-list/` directory and delete the original flat file after split:
- `CustomerListContainer.tsx`
- `CustomerTable.tsx` with React.memo rows
- `CustomerFilters.tsx`
- `CustomerBulkActions.tsx`
- `hooks/useCustomerList.ts`
- `index.ts`

- [ ] **Step 4: Split DiscountList.tsx (1,367 lines)**

Create `apps/admin/src/components/admin/discount/discount-list/` directory:
- `DiscountListContainer.tsx`
- `DiscountTable.tsx` with React.memo rows
- `DiscountFilters.tsx`
- `DiscountTypeSelector.tsx`
- `hooks/useDiscountList.ts`
- `index.ts`

- [ ] **Step 5: Split AmountOffProductsForm.tsx (905 lines)**

Create `apps/admin/src/components/admin/discount/amount-off-products/` directory:
- `AmountOffProductsContainer.tsx`
- `ProductSelectorStep.tsx`
- `DiscountConfigStep.tsx`
- `SummaryStep.tsx`
- `index.ts`

- [ ] **Step 6: Update Astro page imports**

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor: split Orders, Customers & Discounts components (OrderList, CustomerList, DiscountList, AmountOffProductsForm)"
```

---

### Task 4: Agent 3 — Settings & Checkout Split

**Files:**
- Modify: `apps/admin/src/components/admin/AccountSettings.tsx` (1,419 lines)
- Modify: `apps/admin/src/components/admin/CheckoutLanguagesManager.tsx` (1,392 lines)
- Modify: `apps/admin/src/components/admin/ShippingMethodsManager.tsx` (1,270 lines)
- Modify: `apps/admin/src/components/admin/settings/PaymentGatewaysManager.tsx` (510 lines)
- Modify: `apps/admin/src/components/admin/MetaConversionsManager.tsx` (835 lines)
- Create: Multiple new files per split

**Context to include in agent prompt:**
- Full Agent Context Template from spec
- Bug list for Settings pages from Wave 0
- Note: StripeSettingsForm.tsx + SSLCommerzSettingsForm.tsx already exist as separate files in `settings/`

- [ ] **Step 1: Read all 5 owned component files fully**

- [ ] **Step 2: Split AccountSettings.tsx (1,419 lines)**

Create `apps/admin/src/components/admin/account-settings/` directory:
- `AccountSettingsContainer.tsx`
- `ProfileTab.tsx`
- `SecurityTab.tsx`
- `RolesTab.tsx`
- `PermissionsTab.tsx`
- `index.ts`

- [ ] **Step 3: Split CheckoutLanguagesManager.tsx (1,392 lines)**

Create `apps/admin/src/components/admin/checkout-languages/` directory:
- `CheckoutLanguagesContainer.tsx`
- `LanguagesTab.tsx`
- `PaymentMethodsTab.tsx`
- `ShippingTab.tsx`
- `index.ts`

- [ ] **Step 4: Split ShippingMethodsManager.tsx (1,270 lines)**

Create `apps/admin/src/components/admin/shipping-methods/` directory:
- `ShippingMethodsContainer.tsx`
- `MethodTable.tsx` with React.memo rows
- `MethodFormDialog.tsx`
- `ProviderConfig.tsx`
- `index.ts`

- [ ] **Step 5: Extract PolarForm from PaymentGatewaysManager.tsx (510 lines)**

- Extract inline PolarForm to `apps/admin/src/components/admin/settings/PolarSettingsForm.tsx`
- Verify StripeSettingsForm and SSLCommerzSettingsForm are correctly imported
- PaymentGatewaysManager.tsx should shrink to ~200 lines as a container

- [ ] **Step 6: Split MetaConversionsManager.tsx (835 lines)**

Create `apps/admin/src/components/admin/meta-conversions/` directory:
- `MetaConversionsContainer.tsx`
- `SettingsForm.tsx`
- `LogsViewer.tsx`
- `CleanupDialog.tsx`
- `index.ts`

- [ ] **Step 7: Verify toast, reload, and schema migrations in split files**

Per shared rules, verify all split files have been migrated:
- No `useToast` imports remain in any new file (use sonner `toast` instead)
- No `window.location.reload()` remains (AccountSettings.tsx has one at ~line 203 — replace with state update/refetch)
- No `@scalius/database/schema` imports remain (CheckoutLanguagesManager, ShippingMethodsManager, MetaConversionsManager all have schema imports — replace with local type definitions)

- [ ] **Step 8: Update Astro page imports**

- [ ] **Step 9: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "refactor: split Settings & Checkout components (AccountSettings, CheckoutLanguages, ShippingMethods, PaymentGateways, MetaConversions)"
```

---

### Task 5: Agent 4 — Delivery & Content Split

**Files:**
- Modify: `apps/admin/src/components/admin/DeliveryLocationsManager.tsx` (1,419 lines)
- Modify: `apps/admin/src/components/admin/DeliveryProviderSettings.tsx` (1,132 lines)
- Modify: `apps/admin/src/components/admin/HeroSliderManager.tsx` (662 lines)
- Modify: `apps/admin/src/components/admin/product-form/variants/VariantManager.tsx` (521 lines)
- Create: Multiple new files per split

**Context to include in agent prompt:**
- Full Agent Context Template from spec
- Bug list for Delivery/Content pages from Wave 0
- Extra: Replace `Math.random()` with `crypto.randomUUID()` in HeroSliderManager

- [ ] **Step 1: Read all 4 owned component files fully**

- [ ] **Step 2: Split DeliveryLocationsManager.tsx (1,419 lines)**

Create `apps/admin/src/components/admin/delivery-locations/` directory:
- `DeliveryLocationsContainer.tsx`
- `LocationTable.tsx` with React.memo rows
- `LocationForm.tsx`
- `LocationImport.tsx`
- `hooks/useDeliveryLocations.ts`
- `index.ts`

- [ ] **Step 3: Split DeliveryProviderSettings.tsx (1,132 lines)**

Create `apps/admin/src/components/admin/delivery-providers/` directory:
- `DeliveryProvidersContainer.tsx`
- `ProviderCard.tsx`
- `CredentialForm.tsx`
- `WebhookConfig.tsx`
- `index.ts`

- [ ] **Step 4: Split HeroSliderManager.tsx (662 lines)**

Create `apps/admin/src/components/admin/hero-slider/` directory:
- `HeroSliderContainer.tsx`
- `SliderEditor.tsx`
- `SortableSlide.tsx`
- `index.ts`
- Replace `Math.random()` with `crypto.randomUUID()`

- [ ] **Step 5: Extract from VariantManager.tsx (521 lines)**

In `apps/admin/src/components/admin/product-form/variants/`:
- Extract `VariantStats.tsx` to separate file
- Extract `VariantBulkEdit.tsx` to separate file
- VariantManager.tsx becomes a container importing these

- [ ] **Step 6: Update Astro page imports**

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor: split Delivery & Content components (DeliveryLocations, DeliveryProviders, HeroSlider, VariantManager)"
```

---

### Task 6: Wave 1 Gate — Merge and Verify

**Executor:** Orchestrator (not a subagent).

- [ ] **Step 1: Merge all 4 agent worktrees**

Merge each agent's branch. Resolve any conflicts (should be none given isolated file ownership).

- [ ] **Step 2: Run typecheck on merged result**

Run: `pnpm typecheck`
Expected: PASS with zero errors

- [ ] **Step 3: Quick smoke test**

Start dev servers, spot-check 3-4 pages from each domain to verify splits didn't break anything.

- [ ] **Step 4: Commit merge if needed**

```bash
git commit -m "refactor: merge Wave 1 domain splits (4 agents, 15 components)"
```

**Gate:** Proceed to Wave 2 only after typecheck passes and smoke test is clean.

---

## Chunk 3: Wave 2 — Cross-Cutting Sweeps (3 Parallel Agents)

### Task 7: Agent 5 — Toast Migration + Pattern Cleanup

**Files:**
- Delete: `apps/admin/src/components/ui/use-toast.ts` (188 lines)
- Delete: `apps/admin/src/hooks/use-toast.ts` (192 lines)
- Modify: `apps/admin/src/components/ui/toaster.tsx` (if depends on use-toast)
- Modify: All remaining files importing `useToast` NOT touched by Wave 1
- Modify: `apps/admin/src/components/admin/orderview/OrderStatusCard.tsx`
- Modify: `apps/admin/src/components/admin/orderview/ShipmentCard.tsx`
- Modify: `apps/admin/src/components/admin/orderview/PaymentCard.tsx`
- Modify: `apps/admin/src/components/admin/AnalyticsList.tsx`
- Modify: `apps/admin/src/components/admin/widget-list/hooks/useWidgets.ts`
- Modify: `apps/admin/src/components/admin/widgets/WidgetForm.tsx`
- Modify: `apps/admin/src/components/admin/DeliveryShipmentManager.tsx`
- Modify: `apps/admin/src/hooks/use-shipment-status.ts`
- Modify: `packages/core/src/modules/pages/pages.service.ts`
- Modify: `packages/core/src/modules/widgets/widgets.service.ts`

- [ ] **Step 1: Find all remaining useToast consumers**

Use the Grep tool to find all files: pattern `useToast|use-toast`, path `apps/admin/src/`, glob `*.{ts,tsx}`.
Filter out files owned by Wave 1 agents (they already migrated). The remaining list will be MUCH larger than Agent 5's explicit file list — expect ~20+ additional files including media-manager components, discount form components, product-form hooks, header/footer builders, widget-list hooks, settings builders, etc. ALL of these must be migrated.

- [ ] **Step 2: Migrate each useToast consumer to sonner**

For each file:
- Replace `import { useToast } from "@/components/ui/use-toast"` or `import { useToast } from "@/hooks/use-toast"` with `import { toast } from "sonner"`
- Replace `const { toast } = useToast()` with nothing (sonner's toast is a direct function)
- Replace `toast({ title: "...", description: "...", variant: "destructive" })` with `toast.error("title", { description: "..." })`
- Replace `toast({ title: "...", description: "..." })` with `toast.success("title", { description: "..." })`

- [ ] **Step 3: Delete both use-toast files**

Delete `apps/admin/src/components/ui/use-toast.ts` and `apps/admin/src/hooks/use-toast.ts`.
Update `toaster.tsx` if it imports from either.

- [ ] **Step 4: Replace window.location.reload() in owned files**

For each file with `window.location.reload()`:
- If it uses `useApi`, add `refetch()` call after mutation success
- If it uses direct `fetch()`, add a state counter that triggers useEffect refetch
- Remove the `setTimeout(() => window.location.reload(), 1500)` pattern
- Keep `toast.success()` before the refetch

Files to fix: OrderStatusCard, ShipmentCard, PaymentCard, AnalyticsList, useWidgets, WidgetForm, DeliveryShipmentManager, use-shipment-status.
Skip: ErrorBoundary.tsx (keep reload as last-resort recovery).

- [ ] **Step 5: Fix schema imports in Agent 5's owned files**

In ShipmentCard.tsx, WidgetForm.tsx, and DeliveryShipmentManager.tsx:
- Replace `import { ... } from "@scalius/database/schema"` with `import { ... } from "@/types/api-responses"`
- Note: Agent 7 creates `api-responses.ts` in parallel — if it doesn't exist yet, create the needed types inline temporarily

- [ ] **Step 6: Remove duplicate schemas in services**

In `packages/core/src/modules/pages/pages.service.ts`:
- Find duplicate Zod schema definitions that also exist in `pages.validation.ts`
- Remove them from service file, import from validation file instead

Same for `packages/core/src/modules/widgets/widgets.service.ts`.

- [ ] **Step 7: Fix remaining catch (error: any) patterns**

Run: `grep -rn "catch (error: any)" apps/admin/src/ --include="*.ts" --include="*.tsx"`
For each occurrence NOT in a Wave 1 file:
- Replace `catch (error: any)` with `catch (error: unknown)`
- Replace `error.message` with `error instanceof Error ? error.message : String(error)`

- [ ] **Step 8: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 9: Verify cleanup**

Run: `grep -r "useToast\|use-toast" apps/admin/src/ --include="*.ts" --include="*.tsx" -l`
Expected: Zero results

Run: `grep -rn "window.location.reload" apps/admin/src/ --include="*.ts" --include="*.tsx"`
Expected: Only ErrorBoundary.tsx

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "refactor: migrate all toasts to sonner, replace window.location.reload, fix error handlers, dedup schemas"
```

---

### Task 8: Agent 6 — Test Infrastructure

**Files:**
- Create: `tests/vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `tests/unit/core/orders/order-lifecycle.test.ts`
- Create: `tests/unit/core/orders/order-state-machine.test.ts`
- Create: `tests/unit/core/orders/order-cancellation.test.ts`
- Create: `tests/unit/core/inventory/reserve-deduct-release.test.ts`
- Create: `tests/unit/core/inventory/batch-reservation.test.ts`
- Create: `tests/unit/core/payments/process-payment.test.ts`
- Create: `tests/unit/core/payments/cod-idempotency.test.ts`
- Create: `tests/unit/core/payments/refund-validation.test.ts`
- Create: `tests/unit/core/discounts/discount-validation.test.ts`
- Create: `tests/unit/api/response-envelope.test.ts`

**Context to include in agent prompt:**
- Tests are private (gitignored `tests/` directory)
- Import from `@scalius/core` and `@scalius/database` directly
- Focus on the exact bugs fixed in the hardening session (33 commits)
- Read the core service files to understand function signatures and expected behavior
- Key files to read: `packages/core/src/modules/orders/orders.service.ts`, `inventory/inventory.service.ts`, `payments/*.service.ts`, `discounts/discounts.service.ts`

- [ ] **Step 1: Read existing test infrastructure**

Read `tests/README.md` and any existing vitest configs in the monorepo (`packages/core/vitest.config.ts`, `apps/api/vitest.config.ts`).

- [ ] **Step 2: Create vitest config**

Create `tests/vitest.config.ts` with:
- `globals: true`
- Path aliases matching monorepo (`@scalius/core`, `@scalius/database`, `@scalius/shared`)
- Setup file reference

- [ ] **Step 3: Create test setup**

Create `tests/setup.ts` with:
- D1 test database helper (miniflare or in-memory SQLite)
- Mock env factory for Cloudflare bindings (DB, KV, R2, Queues)
- Seed data generators for products, orders, customers, inventory

- [ ] **Step 4: Read core service files for function signatures**

Read the actual service implementations to understand:
- Order state transitions and validation rules
- Inventory CAS mechanism (stockVersion)
- Payment processing flow (db.batch atomicity)
- Discount validation logic

- [ ] **Step 5: Write order lifecycle tests**

`tests/unit/core/orders/order-lifecycle.test.ts`:
- PENDING → CONFIRMED → PROCESSING → SHIPPED → DELIVERED → COMPLETED
- Each transition calls the service function and verifies state change

`tests/unit/core/orders/order-state-machine.test.ts`:
- All valid transitions succeed
- All blocked transitions throw (CANCELLED is terminal except admin reactivation)
- Admin reactivation from CANCELLED works

`tests/unit/core/orders/order-cancellation.test.ts`:
- Cancel releases inventory reservations
- Cancel with partial shipment handles correctly

- [ ] **Step 6: Write inventory tests**

`tests/unit/core/inventory/reserve-deduct-release.test.ts`:
- Reserve decrements available, increments reserved
- Deduct decrements reserved, increments sold
- Release decrements reserved, increments available
- CAS conflict (wrong stockVersion) throws

`tests/unit/core/inventory/batch-reservation.test.ts`:
- Multi-variant batch is atomic (all succeed or all fail)

- [ ] **Step 7: Write payment tests**

`tests/unit/core/payments/process-payment.test.ts`:
- processPaymentConfirmed uses db.batch for atomicity
- All 4 gateways (Stripe, SSLCommerz, Polar, COD)

`tests/unit/core/payments/cod-idempotency.test.ts`:
- Duplicate COD collection is rejected

`tests/unit/core/payments/refund-validation.test.ts`:
- Cumulative refund cannot exceed paid amount
- Partial refund tracking

- [ ] **Step 8: Write discount tests**

`tests/unit/core/discounts/discount-validation.test.ts`:
- Per-customer usage limits enforced
- Expired codes rejected
- Global usage limit enforced

- [ ] **Step 9: Write response envelope test**

`tests/unit/api/response-envelope.test.ts`:
- Verify all routes return `{ success: true, data: T }` shape
- Verify error routes return `{ success: false, error: { code, message } }`

- [ ] **Step 10: Run tests**

Run: `npx vitest run --config tests/vitest.config.ts`
Expected: All tests PASS

- [ ] **Step 11: Verify tests stay local**

Tests are in the gitignored `tests/` directory — do NOT commit them. They are private to the core team. Verify:
Run: `git status tests/`
Expected: Files show as untracked (gitignored). This is correct. Do NOT use `git add -f`.

---

### Task 9: Agent 7 — Database Indexes + Admin Type Definitions

**Files:**
- Modify: `packages/database/src/schema/content.ts` (or `media.ts` — wherever media table is)
- Modify: `packages/database/src/schema/delivery.ts`
- Modify: `packages/database/src/schema/system.ts`
- Modify: `packages/database/src/schema/products.ts`
- Create: `apps/admin/src/types/api-responses.ts`
- Modify: ~14 admin component files (schema import replacement, excluding Wave 1 + Agent 5 files)

- [ ] **Step 1: Read schema files to find table definitions**

Read each schema file to locate the exact table definitions and find where to add indexes:
- `packages/database/src/schema/` — find media, delivery_providers, analytics, product_attributes tables

- [ ] **Step 2: Add indexes**

In the appropriate schema files, add:
```typescript
// media table (wherever it's defined):
index("media_folder_id_idx").on(table.folderId),
index("media_deleted_at_idx").on(table.deletedAt),

// delivery_providers table:
index("delivery_providers_type_idx").on(table.type),

// analytics table:
index("analytics_type_idx").on(table.type),

// product_attributes table:
index("product_attributes_slug_idx").on(table.slug),
```

- [ ] **Step 3: Generate migration**

Run: `pnpm db:generate`
Verify: New migration file created (check `packages/database/migrations/` for latest)

- [ ] **Step 4: Grep all @scalius/database/schema imports in admin**

Run: `grep -rn "@scalius/database/schema" apps/admin/src/ --include="*.ts" --include="*.tsx"`
List every file and what types it imports. Cross-reference with Wave 1 files (skip those) and Agent 5 files (skip ShipmentCard, WidgetForm, DeliveryShipmentManager).

- [ ] **Step 5: Create api-responses.ts**

Create `apps/admin/src/types/api-responses.ts` with interfaces for every type imported from `@scalius/database/schema` across the admin app. Read the actual DB schema types to get the full field definitions — don't guess.

- [ ] **Step 6: Update remaining admin component imports**

For each file from Step 4 (excluding Wave 1 and Agent 5 files):
- Replace `import { ... } from "@scalius/database/schema"` with `import { ... } from "@/types/api-responses"`
- Also replace `import type { ... }` variants

- [ ] **Step 7: Verify window.d.ts completeness**

Read `apps/admin/src/types/window.d.ts`. Grep for `window.__` patterns across admin. If any globals are used but not declared, add them.

- [ ] **Step 8: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 9: Verify no schema imports remain**

Run: `grep -r "@scalius/database/schema" apps/admin/src/components/ --include="*.ts" --include="*.tsx"`
Expected: Zero results (Agent 5's files may still show if running in parallel — that's OK, Agent 5 handles them)

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat: add 5 DB indexes, create admin api-responses types, migrate schema imports"
```

---

### Task 10: Wave 2 Gate — Merge and Verify

**Executor:** Orchestrator.

- [ ] **Step 1: Merge all 3 agent worktrees**

- [ ] **Step 2: Run typecheck on merged result**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Verify cleanup**

Run: `grep -r "useToast\|use-toast" apps/admin/src/ -l` → zero
Run: `grep -r "@scalius/database/schema" apps/admin/src/components/ -l` → zero
Run: `grep -rn "window.location.reload" apps/admin/src/` → only ErrorBoundary

- [ ] **Step 4: Commit merge**

```bash
git commit -m "refactor: merge Wave 2 cross-cutting sweeps (toast, tests, indexes, types)"
```

---

## Chunk 4: Wave 3 — Final Sweep

### Task 11: Lazy-Loading + Performance + Final Verification

**Executor:** Single agent or orchestrator.

**Files:**
- Modify: Dashboard component (lazy-load Recharts)
- Modify: Widget/Page editor component (lazy-load TipTap)
- Modify: `apps/admin/src/components/ui/tiptap-editor.tsx` (953 lines → split + lazy)
- Modify: Settings tab components (extend React.lazy)
- Modify: List component CSS (content-visibility)

- [ ] **Step 1: Lazy-load Recharts on dashboard**

Find the dashboard component that imports Recharts. Wrap with React.lazy:
```typescript
const DashboardChart = React.lazy(() => import("./DashboardChart"));
```
Add `<Suspense fallback={<div className="h-64 animate-pulse bg-muted rounded" />}>` wrapper.

- [ ] **Step 2: Split and lazy-load TipTap editor**

Split `apps/admin/src/components/ui/tiptap-editor.tsx` (953 lines) into:
- `tiptap/TiptapEditor.tsx` — core editor component
- `tiptap/TiptapToolbar.tsx` — toolbar buttons
- `tiptap/TiptapBubbleMenu.tsx` — floating menu
- `tiptap/TiptapExtensions.ts` — extension configuration
- `tiptap/index.ts` — barrel export

Then lazy-load the barrel from consuming components:
```typescript
const TiptapEditor = React.lazy(() => import("./tiptap"));
```

- [ ] **Step 3: Extend React.lazy to settings tabs**

Find settings page components that use heavy sub-components. Apply React.lazy pattern from existing CheckoutSettingsPage/GeneralSettingsPage to all settings tabs.

- [ ] **Step 4: Add content-visibility to long lists**

Add to list table CSS (product table, order table, customer table):
```css
.list-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 60px;
}
```

- [ ] **Step 5: Verify Firebase init defers**

Read Firebase initialization code. Verify it uses `requestIdleCallback` or dynamic import. If not, wrap appropriately.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS with zero errors across all workspaces

- [ ] **Step 7: Run tests**

Run: `npx vitest run --config tests/vitest.config.ts`
Expected: All tests PASS

- [ ] **Step 8: Full manual smoke test**

Start `pnpm dev`. Navigate every admin page from the Wave 0 list. For each:
- Page loads without errors
- Data renders correctly
- Forms work (create, edit, delete)
- Console is clean
- No "undefined" or missing data

- [ ] **Step 9: Verify success criteria**

Run: `find apps/admin/src/components -name "*.tsx" -exec wc -l {} + | sort -rn | head -20`
Expected: No file over 800 lines

Run: `grep -rn ": any" apps/admin/src/ --include="*.ts" --include="*.tsx" | wc -l`
Expected: ≤ 8 (only Drizzle batch casts)

Run: `grep -r "useToast\|use-toast" apps/admin/src/ -l`
Expected: Zero

Run: `grep -r "@scalius/database/schema" apps/admin/src/components/ -l`
Expected: Zero

- [ ] **Step 10: Final commit**

```bash
git add -A && git commit -m "perf: lazy-load Recharts + TipTap, split tiptap-editor, add content-visibility to lists"
```

---

## Execution Summary

| Wave | Tasks | Agents | Parallelism | Gate |
|------|-------|--------|-------------|------|
| 0 | 1 (verification) | Orchestrator | Sequential | All pages load |
| 1 | 4 (domain splits) + 1 (merge) | 4 parallel | Worktree isolation | `pnpm typecheck` + smoke test |
| 2 | 3 (cross-cutting) + 1 (merge) | 3 parallel | Worktree isolation | `pnpm typecheck` + cleanup grep |
| 3 | 1 (lazy-load + final) | 1 agent | Sequential | All success criteria met |

Total: 11 tasks, 7 subagents, 18 components split, ~163 any types fixed, 2 use-toast files deleted, 14 reloads replaced, ~21 schema imports migrated, 5 DB indexes added, 10 test files created.
