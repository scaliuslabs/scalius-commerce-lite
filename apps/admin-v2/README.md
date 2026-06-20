# @scalius/admin-v2 — TanStack Start Admin Dashboard

Modern admin dashboard built with **TanStack Start** (full-stack React framework) deployed as a Cloudflare Worker.

## Tech Stack

- **Framework**: TanStack Start + TanStack Router (file-based routing) + Vite 8
- **Data**: TanStack Query (React Query) with SSR dehydration
- **UI**: React 19 + shadcn/ui + Tailwind CSS v4 + Radix primitives
- **Tables**: TanStack Table with server-side pagination
- **Forms**: React Hook Form + Zod validation
- **Rich Text**: Sanitized read-only previews with deferred Tiptap editor loading (images, tables, YouTube, resizable images)
- **DnD**: dnd-kit (sortable lists, collection reorder)
- **Charts**: Recharts (dashboard analytics)
- **Auth**: Better Auth (email/password + optional 2FA)
- **Deployment**: Cloudflare Workers via `@cloudflare/vite-plugin`
- **Port**: 4323 (dev)

## Data Flow Pattern

```
typed domain server functions
  → queryOptions wrappers (7 staleTime tiers)
    → ensureQueryData in route loader (prefetch)
      → useSuspenseQuery in component (render)
        → domain mutation hooks (cache invalidation + toasts)
```

The exact number of server functions, query wrappers, and mutation hooks changes often. Use fresh `rg` scans when counts matter instead of copying numbers into code review or audit notes.

**Stale-While-Revalidate**: Detail queries use `staleTime: 0` in queryOptions + `staleTime: Infinity` in route loaders. Result: instant navigation (serves cache), background refetch (fresh data within ms).

**List Pages**: URL-search-driven list routes declare `loaderDeps`, map validated deps with `mapParams()`, and prefetch the same query keys rendered by components. Component-level loading overlays should stay scoped to the table area.

**Loader Boundaries**: Route loaders should wait only for data needed to make the first paint correct. Products waits for the primary list, while category options and stats prefetch in the browser. Dashboard summary uses `warmRouteQuery()`: cold SSR waits for correct metrics, but client transitions prefetch and show `DashboardSummaryLoading` instead of blocking navigation or flashing fake zero values. Cache settings and inventory render stable loading states and use client-only prefetches for default reads instead of blocking navigation.

**Idle Tab Behavior**: The global QueryClient keeps warm data for 30 minutes but does not refetch every stale active query on window focus or network reconnect. The `/admin` route-context cache keeps already-verified auth/RBAC shell context fresh for 1 minute and stale-while-revalidated for up to 4 hours, so returning to an idle tab does not block the first in-app navigation on guard reads. UI paths that change the current user's profile, 2FA/security state, session, or permissions must call `refreshAdminRouteContext(router)`. Only truly realtime screens opt in to `refetchOnWindowFocus` / `refetchOnReconnect`, which prevents long-idle dashboard tabs from stampeding the API when the merchant returns. Orders list auto-refresh is merchant-controlled and pauses while `document.hidden`; when the tab becomes visible again it performs one explicit refresh and resets the countdown.

**Auth Guard Performance**: Auth/setup/2FA success paths use TanStack Router navigation instead of full document reloads so the hydrated app survives post-login transitions. The setup guard caches only positive "admin exists" D1 reads for a short isolate TTL; missing-admin results are not cached. Empty-cookie auth routes skip Better Auth binding initialization and session lookup: `getSessionInfo()` / `redirectIfAuthenticated()` return `null`, `loginPageGuard()` renders login after setup detection, and `adminRouteGuard()` redirects to `/auth/login` before RBAC work. `adminRouteGuard()` reuses the fresh Better Auth `user.isSuperAdmin` field when loading RBAC context, avoiding a duplicate super-admin D1 read while preserving a fallback query if the auth payload omits the field.

**Order Detail Polling**: Order detail polls order and shipment data every 30 seconds for webhook-driven updates, but it intentionally inherits the global focus/reconnect defaults. Do not re-add focus or reconnect refetches there; the interval is enough, and idle-tab resume should not refresh the old order while the merchant navigates away.

**Read Timeout Behavior**: Admin read-only API transport (`GET`/`HEAD`) is bounded by `ADMIN_API_READ_TIMEOUT_MS` in `src/lib/admin-api-timeout.ts`, including slow JSON/text body reads. Write methods and POST-based streams are deliberately unbounded so committed mutations and long-running widget/AI/import operations are not reported as timed-out guesses.

**Checkout Readiness Preview**: The Checkout Flow panel reads `/api/v1/admin/settings/checkout-readiness` through the dashboard admin proxy in the browser and keeps the typed server-function path only for server-side execution. This avoids turning a transient TanStack server-function transport/referrer failure into a scary delivery-setup warning. If the status read still fails, the amber panel must describe it as an admin status refresh failure and surface the API error while public checkout continues to fail closed from the API checkout-readiness policy.

**Scroll Restoration**: The admin shell uses TanStack Router's scroll restoration for the nested `#admin-main-scroll` container with instant behavior. The `useAdminNestedScrollRestoration()` helper snapshots that container before route loads, resets it to top on normal client navigation, and restores the saved position only on browser Back/Forward. Do not add ad hoc route-change `scrollTo()` effects in the layout; extend the helper or register additional scroll containers with router scroll restoration instead.

**Order Fulfillment**: Order detail supports provider shipments and own-courier/manual fulfillment. `ManualFulfillmentDialog` posts selected unshipped item IDs to the typed orders server-function slice, invalidates order detail + shipments, and computes final-shipment intent from the remaining fulfillable items. Manual shipment history rows can show courier/tracking/note metadata, but the refresh action is only shown for provider-backed shipments.

## staleTime Tiers

| Tier | Duration | Used For |
|------|----------|----------|
| REALTIME | 10s | Cache stats |
| FAST | 30s | Orders, inventory |
| MODERATE | 2min | Product/category/discount lists, dashboard |
| SLOW | 5min | Product stats, media, widget history |
| LOOKUP | 10min | Form options, attributes, admin users |
| CONFIG | 30min | All settings (35+ queries) |
| STATIC | 1hr | Setup status |

## Pages

**Auth**: Setup, Login, Two-Factor, Forgot/Reset Password

**Admin** (60+ pages):
- Dashboard (stats, recent orders, charts)
- Products (list, create, edit, view, variants, images, SEO)
- Orders (list, create, edit, view, shipments, payments, invoices, auto-refresh)
- Categories, Collections (with DnD reorder), Customers (with history)
- Discounts (amount off products, amount off order, free shipping)
- Pages/CMS (with Tiptap rich editor), Widgets (with AI generation + history)
- Attributes (inline edit), Inventory, Media Manager (folders, upload, move)
- Analytics (tracking scripts), Abandoned Checkouts
- Settings (12+ tabs: general, checkout, payments, delivery, notifications, auth, theme, cache, etc.)
- Invoice PDF generation, Scanner/QR app

Scanner QR token minting is a privileged same-origin admin action. It requires an authenticated admin session with 2FA already verified when 2FA is enabled, then `products.view` plus `products.edit` RBAC or super-admin access before any KV token is written.

## Key Files

| File | Purpose |
|------|---------|
| `src/router.tsx` | Router config + SSR integration |
| `src/lib/admin-query-client.ts` | QueryClient defaults for idle-tab/reconnect policy |
| `src/lib/admin-route-context.ts` | Stale-while-revalidate admin shell auth/RBAC context |
| `src/lib/auth.fns.ts` | Auth/setup guards, positive admin-exists cache, admin RBAC context server functions |
| `src/middleware/rbac.server.ts` | Server-only RBAC loading with auto-seed and optional fresh super-admin shortcut |
| `src/routes/__root.tsx` | Root route (HTML shell, CSS, providers) |
| `src/routes/admin.tsx` | Admin layout (sidebar, SSR auth guard, RBAC context) |
| `src/lib/api-functions/` | Typed domain server-function slices |
| `src/lib/api-query-options/` | Narrow domain queryOptions with staleTime tiers |
| `src/lib/api-mutations/` | Domain mutation hooks with cache invalidation |
| `src/lib/api.mutations.ts` | Compatibility re-export barrel for mutation hooks |
| `src/lib/admin-api-timeout.ts` | Read-only API timeout helper shared by server functions and proxy |
| `src/lib/api.server.ts` | HTTP transport layer (service binding / fetch) |
| `src/lib/query-keys.ts` | Centralized query key factory |
| `src/lib/list-helpers.tsx` | Shared list search schemas and data selectors |
| `src/lib/route-error.tsx` | Shared route-level error boundary component |

## Shared Hooks & Components

| File | Purpose |
|------|---------|
| `hooks/use-entity-form-submit.ts` | Generic form submit with invalidation + navigation |
| `hooks/use-delete-handler.ts` | Generic delete with query invalidation |
| `hooks/use-settings-form.ts` | Settings forms (useQuery + useMutation + state sync) |
| `components/admin/shared/FormContainer.tsx` | Form wrapper + UnsavedChangesGuard |
| `components/admin/shared/UnsavedChangesGuard.tsx` | useBlocker + beforeunload |
| `components/admin/shared/StatusBadges.tsx` | Order/Payment/Shipment status badges |
| `components/admin/shared/LoadingFallback.tsx` | Suspense fallbacks + skeletons |
| `components/admin/shared/SortableList.tsx` | dnd-kit abstraction |
| `components/admin/data-table/` | DataTable, useServerTable, column factories |

## Development

```bash
pnpm dev:admin     # From repo root: start API :8787 + admin :4323
```

Run `pnpm dev:setup` first to create local env files, apply D1 migrations, and create the default local admin through `/api/v1/setup`. Use `pnpm dev` from the repo root when you also want the storefront.

## Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | Shared database |
| `API` | Service Binding | → scalius-api worker |
| `CACHE` | KV | General caching |
| `SESSION` | KV | Better Auth sessions |
| `SHARED_AUTH_CACHE` | KV | Cross-worker auth |
| `BUCKET` | R2 | Media storage |
