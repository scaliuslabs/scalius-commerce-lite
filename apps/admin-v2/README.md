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

**Idle Tab Behavior**: The global QueryClient keeps warm data for 30 minutes but does not refetch every stale active query on window focus. Only truly realtime screens opt in to `refetchOnWindowFocus`, which prevents long-idle dashboard tabs from stampeding the API when the merchant returns.

**Scroll Restoration**: The admin shell uses TanStack Router's scroll restoration for the nested `#admin-main-scroll` container with instant behavior. The `useAdminNestedScrollRestoration()` helper snapshots that container before route loads, resets it to top on normal client navigation, and restores the saved position only on browser Back/Forward. Do not add ad hoc route-change `scrollTo()` effects in the layout; extend the helper or register additional scroll containers with router scroll restoration instead.

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

## Key Files

| File | Purpose |
|------|---------|
| `src/router.tsx` | Router config + QueryClient + SSR integration |
| `src/routes/__root.tsx` | Root route (HTML shell, CSS, providers) |
| `src/routes/admin.tsx` | Admin layout (sidebar, SSR auth guard, RBAC context) |
| `src/lib/api-functions/` | Typed domain server-function slices |
| `src/lib/api-query-options/` | Narrow domain queryOptions with staleTime tiers |
| `src/lib/api-mutations/` | Domain mutation hooks with cache invalidation |
| `src/lib/api.mutations.ts` | Compatibility re-export barrel for mutation hooks |
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
