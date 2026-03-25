# @scalius/admin-v2 — TanStack Start Admin Dashboard

Modern admin dashboard built with **TanStack Start** (full-stack React framework) deployed as a Cloudflare Worker.

## Tech Stack

- **Framework**: TanStack Start + TanStack Router (file-based routing) + Vite 8
- **Data**: TanStack Query (React Query) with SSR dehydration
- **UI**: React 19 + shadcn/ui + Tailwind CSS v4 + Radix primitives
- **Tables**: TanStack Table with server-side pagination
- **Forms**: React Hook Form + Zod validation
- **Rich Text**: Tiptap editor (images, tables, YouTube, resizable images)
- **DnD**: dnd-kit (sortable lists, collection reorder)
- **Charts**: Recharts (dashboard analytics)
- **Auth**: Better Auth (email/password + optional 2FA)
- **Deployment**: Cloudflare Workers via `@cloudflare/vite-plugin`
- **Port**: 4323 (dev)

## Data Flow Pattern

```
createServerFn (252 functions)
  → queryOptions (78 wrappers, 7 staleTime tiers)
    → ensureQueryData in route loader (prefetch)
      → useSuspenseQuery in component (render)
        → useMutation (126 hooks, cache invalidation + toasts)
```

**Stale-While-Revalidate**: Detail queries use `staleTime: 0` in queryOptions + `staleTime: Infinity` in route loaders. Result: instant navigation (serves cache), background refetch (fresh data within ms).

**List Pages**: No `loaderDeps` (intentional — prevents full-page spinner on search/filter). Component reads `Route.useSearch()` → `useQuery` with `keepPreviousData` → `DataTableLoadingOverlay` shows only over the table area.

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
| `src/routes/admin.tsx` | Admin layout (sidebar, auth guard, RBAC context) |
| `src/lib/api.functions.ts` | 252 server functions (createServerFn) |
| `src/lib/api.queries.ts` | 78 queryOptions with staleTime tiers |
| `src/lib/api.mutations.ts` | 126 mutation hooks with cache invalidation |
| `src/lib/api.server.ts` | HTTP transport layer (service binding / fetch) |
| `src/lib/query-keys.ts` | Centralized query key factory (20 domains) |
| `src/lib/list-helpers.tsx` | Shared search schema, data selector, error component |

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
cd apps/admin-v2 && pnpm dev     # Start on :4323
```

Requires the API worker running on :8787. From repo root: `pnpm dev` starts both.

## Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | Shared database |
| `API` | Service Binding | → scalius-api worker |
| `CACHE` | KV | General caching |
| `SESSION` | KV | Better Auth sessions |
| `SHARED_AUTH_CACHE` | KV | Cross-worker auth |
| `BUCKET` | R2 | Media storage |
