Analyse the entire codebase deeply. Understand every app, package, module, data flow, integration, and convention. Read the CLAUDE.md, module READMEs, the design spec at docs/superpowers/specs/2026-03-17-admin-refactoring-design.md and the plans at docs/superpowers/plans/ to understand what was already done and what's remaining.

Our codebase is a Turborepo monorepo (Astro SSR admin + Hono API + Astro SSR storefront, all Cloudflare Workers). Two massive sessions were just completed — a hardening session (33 commits fixing critical bugs, API standardization, schema hardening) and a refactoring session (Phase 1 Foundation + Phase 2 Migration). Check memory for full context.

Phase 1 (Foundation) is done: middleware split into 6 modules, AdminLayout split from 621 to 139 lines, SideBar split from 984 to 399 lines, shared apiGet/apiPost/useApi hooks created, error boundary infrastructure built, inline scripts extracted (eval eliminated), noUncheckedIndexedAccess enabled with 114 type errors fixed, ESLint any rule set to warn.

Phase 2 (Migration) is done but IT WAS PAINFUL. All 9 admin loaders were migrated from direct DB access to API calls. 12 new API endpoints were created. Dashboard was migrated to its own API endpoint. Security fixes landed (Zod validation, rate limiting, global db imports fixed). BUT — the migration caused a cascade of production bugs because the API response shapes didn't match what the admin components expected. The admin has a proxy at pages/api/v1/[...path].ts that unwraps { success, data: T } → { success, ...T } for backward compatibility, and many components were accessing json.data which became undefined after unwrapping. We also found that some API routes used "data:" as a field name inside ok() payloads which collided with the envelope. We fixed it by renaming to entity names (shippingMethods, locations, attributes, etc.) but it took multiple rounds of production debugging.

CRITICAL LESSONS FROM THE LAST SESSION THAT YOU MUST INTERNALIZE:

1. NEVER do band-aid fixes. Always understand the root pattern causing the issue, analyze the big picture, and fix it for good so it never happens again. One proper fix prevents entire categories of future bugs.

2. Before changing ANY code, build a complete mental model of the blast radius. Trace the full data flow: API route → admin proxy (unwraps envelope) → loader (transforms data) → Astro page (destructures) → React component (renders). A "simple" field rename in an API route breaks every consumer. A loader migration breaks every page that destructures the old shape.

3. The response envelope is the #1 source of production bugs in this codebase. The API returns { success, data: T }. The admin proxy unwraps object T to { success, ...T }. Arrays stay wrapped as { success, data: [...] }. Client-side fetch calls go through the proxy. SSR loaders call the API directly via service binding. These two paths produce DIFFERENT response shapes. You must understand which path each consumer uses.

4. When dispatching subagents, treat them as your equals. They have 1M context too. Give them the FULL picture — all parameters, all constraints, all downstream effects, all the headaches. Partial context leads to correct-in-isolation but broken-in-integration code. The loader migration bugs happened because subagents implemented changes without understanding the full data flow across all layers.

5. NEVER deploy or claim work is done without testing every affected page, form, and interaction end-to-end. "Typecheck passes" and "pages return 200" are NOT sufficient. You must verify data renders correctly, forms submit correctly, error states show proper messages, and browser console has no errors. Start dev servers, use Chrome, click everything.

6. There are still 30 type-only imports from @scalius/database/schema in admin components (OrderStatus enum, DeliveryShipment type, etc.). These don't break at runtime but create wrong dependency chains. The proper fix is local type definitions in admin or SDK types — not just suppressing the imports.

This session's focus: Phase 3 Refinement — complete the codebase preparation for rapid feature development at scale.

Priority 1: Component Splitting

The admin app has 8 components over 1,000 lines and 7 more over 500 lines. These are monolithic components mixing data fetching, state management, UI rendering, and business logic. Split them following container/presentational pattern. Each split creates a container (data fetching via useApi, state management, callbacks), presentational children (pure render, props only), and a custom hook if state logic is complex.

The 1,000+ line monsters: CategoryList (1,441), DeliveryLocationsManager (1,419), AccountSettings (1,419), CheckoutLanguagesManager (1,392), ProductList (1,386), DiscountList (1,367), ShippingMethodsManager (1,270).

The 500-900 line components: OrderList (804), MetaConversionsManager (835), BulkVariantGenerator (707), HeroSliderManager (662), CollectionForm (653), PaymentGatewaysManager (510), VariantManager (521).

When splitting, use the useApi hook created in Phase 1 for data fetching. Use the PageSection error boundary wrapper for each major section. Follow existing patterns from components that are already well-organized (like the product-form/ directory with 39 focused files).

Priority 2: Type Safety

Eliminate ~130 any type usages across admin components. Work by category not file-by-file:
- Error handlers (~60): catch (error: any) → catch (error) + instanceof Error check
- API response types (~30): create apps/admin/src/types/api-responses.ts with proper interfaces
- Component props (~20): icon: any → React.ComponentType<{ className?: string }>
- Window globals (~10): already have types/window.d.ts, ensure all usages reference it
- Drizzle batch casts (~8): keep as-is with eslint-disable comment (upstream limitation)
- Customer service errors: replace Object.assign(new Error(), {statusCode}) with proper ApiError classes

Also move the 30 type imports from @scalius/database/schema to local admin type definitions. Create types that mirror the schema types but are owned by the admin app, not the database package.

Priority 3: Performance & Developer Experience

- React.memo on ~12 list row components (CategoryRow, ProductRow, DiscountRow, etc.) — they re-render on every parent state change
- Lazy-load Recharts (~300KB, only on dashboard), TipTap (~800KB, only in widget/page editor)
- Extend the React.lazy pattern from CheckoutSettingsPage/GeneralSettingsPage to all settings tabs
- Replace 5+ window.location.reload() calls with useApi refetch()
- Standardize on sonner toast everywhere, delete the custom use-toast.ts hook (192 lines)
- Replace Math.random() with nanoid for ID generation
- Remove duplicate schema definitions from pages.service.ts and widgets.service.ts (keep only in .validation.ts)
- Fix getDashboardStats — already done, but verify it works correctly with realistic data

Priority 4: Test Infrastructure

Set up vitest in the private tests/ directory (gitignored). Write tests for the exact bugs we fixed:
- Order lifecycle (create → pay → fulfill → deliver → return → cancelled → reactivate)
- Inventory CAS (reserve/deduct/release with concurrent access)
- Payment processing atomicity across all 4 gateways
- COD idempotency
- Refund validation (cumulative limits)
- Discount validation (usage limits, per-customer caps)
- Response envelope verification (all routes return correct shape)

Priority 5: Database Indexes

Add missing indexes for frequently queried tables: media (folder_id, deleted_at), delivery_providers (type), analytics (type), product_attributes (slug). Generate migration 0025.

IMPORTANT CONSTRAINTS:

- Always verify with pnpm typecheck (NOT pnpm build — esbuild strips types without checking)
- Tests are private (gitignored tests/ directory) — only core team maintains them
- SDK regeneration is still deferred until API surface fully stabilizes
- Scanner mobile app is a separate session — don't work on it
- The storefront app is clean (zero violations) — don't touch it unless specifically asked
- Each merchant deploys on their own Cloudflare account (single-tenant)
- In a few months a separate team starts building a new admin SPA — the current Astro admin will eventually be replaced. Everything must go through the API.

Before you start making ANY changes, start the dev servers (pnpm dev), open Chrome, and verify every single admin page loads correctly with no console errors. If anything is broken from the previous session, fix it FIRST before starting new work. The previous session left some pages untested and bugs kept appearing in production. Don't repeat that mistake.

use the superpowers brainstorming skill
