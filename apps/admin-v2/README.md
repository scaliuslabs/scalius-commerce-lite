# @scalius/admin-v2 — Admin dashboard

A static single-page app (Vite + TanStack Router). It has no Worker, Wrangler
config, secrets, or bindings of its own: `vite build` writes `dist/`, and the
API Worker (`scalius-api`) serves that directory from its `ASSETS` binding on
the dashboard hostname, together with Better Auth (`/api/auth/*`), the scanner
cookie exchange (`/api/scanner-token`), and the API (`/api/v1/*`); see
`apps/api/src/dashboard/`. Build and deploy from the repository root; the API
build builds this app first. See the [root README](../../README.md).

```bash
pnpm dev:admin   # from the repo root: API :8787 + dashboard :4323
```

`pnpm dev` here runs Vite on :4323 and proxies `/api/v1`, `/api/auth`, and
`/api/scanner-token` to the API Worker on :8787 (`SCALIUS_DEV_ADMIN_PORT` and
`SCALIUS_DEV_API_PORT` change both; see the root README "Parallel local
stacks"), so development and production
see the same same-origin paths. Run `pnpm dev:setup` first to create the API's
`.dev.vars`, apply local D1 migrations, and create the default local admin.

## Stack

TanStack Router (file-based routes) + Vite 8 · TanStack Query · TanStack Table
with server-side pagination · React 19 · shadcn/ui + Tailwind CSS v4 + Radix ·
React Hook Form + Zod · Tiptap · dnd-kit · Recharts · Better Auth client.

## Runtime

- `index.html` is a blank shell; `src/main.tsx` resolves the first route
  (including its session guard and any redirect) before rendering, so protected
  content never flashes for a signed-out visitor.
- The API Worker fills in the runtime dashboard base path (a `<meta>` tag plus
  every root-relative asset URL), so one build serves any prefix
  (`src/lib/dashboard-base-path.ts`).
- Public origins, the optional customer cookie domain, and extra CORS origins are
  merchant settings edited in Settings → System → Platform
  (`PlatformSettingsBuilder.tsx`, backed by
  `GET`/`PUT /api/v1/admin/settings/platform`).

## Data flow

```
generated SDK call (@scalius/api-client/sdk) unwrapped once by apiData() (src/lib/api.ts)
  → queryOptions wrappers (src/lib/api-query-options/)
    → ensureQueryData in the route loader (prefetch)
      → useSuspenseQuery in the component
        → domain mutation hooks (src/lib/api-mutations/) with invalidation + toasts
```

Each domain module declares its own `staleTime` constant — 30s for order and
inventory lists, 2min for catalog lists and dashboard, 10min for form options and
lookups, 30min for settings, 1hr for setup status. The QueryClient default is
`ADMIN_QUERY_STALE_TIME_MS` (10s) in `src/lib/admin-query-client.ts`. Counts of
query wrappers and mutation hooks change often — scan with `rg` rather than
copying numbers.

**Transport**: `src/lib/api.ts` points the generated SDK client at one fetch:
same-origin `<base>/api/v1/*` with `credentials: "same-origin"` (production: the
API Worker on the dashboard host; `vite dev`: the Vite proxy to `:8787`). It
returns the raw `{ success, data }` envelope, which `apiData()` unwraps;
request/response types come from `@scalius/api-client/types`.

**Stale-while-revalidate**: detail queries use `staleTime: 0` in queryOptions and
`staleTime: Infinity` in route loaders, so navigation serves cache and refetches
in the background.

**List pages**: URL-search-driven list routes declare `loaderDeps`, map validated
deps with `mapParams()`, and prefetch the same query keys the components render.
Keep loading overlays scoped to the table area.

**Loader boundaries**: a route loader should wait only for the data that makes
the first paint correct. Products waits for the primary list while category
options and stats prefetch in the browser. Dashboard summary uses
`warmRouteQuery()` — a cold load waits for correct metrics, transitions show
`DashboardSummaryLoading` instead of blocking or flashing zeros. Dashboard
activity (90-day charts) loads after browser idle with a timeout fallback.

**Idle tabs**: the QueryClient keeps warm data for 30 minutes but does not
refetch stale active queries on window focus or reconnect. The `/admin`
route-context cache keeps verified auth/RBAC shell context fresh for 1 minute and
stale-while-revalidated for up to 4 hours. Any path that changes the current
user's profile, 2FA state, session, or permissions must call
`refreshAdminRouteContext(router)`. Only truly realtime screens opt into
`refetchOnWindowFocus` / `refetchOnReconnect`. Orders-list auto-refresh is
merchant-controlled, pauses while `document.hidden`, and performs one explicit
refresh on return. Order detail polls order and shipment data every 30 seconds
and deliberately inherits the global focus/reconnect defaults — do not re-add
focus or reconnect refetches there.

**Auth guards**: auth, setup, and 2FA success paths navigate with TanStack Router
rather than full document reloads. The login form must not pass a Better Auth
`callbackURL` when it also navigates after success. Every guard decision in
`src/lib/auth-guards.ts` comes from one read of
`GET <base>/api/auth/dashboard-session` (admin exists, signed-in user, 2FA
state, and RBAC permissions once every sign-in gate has passed):
`adminRouteGuard()` redirects to `/auth/login` without a session,
`mustChangePassword` to `/auth/forgot-password`, and `mustEnrollTwoFactor` to
`/auth/setup-2fa`. The guards only redirect; the admin API enforces the same
gates on every call.

**Navigation performance**: the sidebar intent-preloads only the seven principal
read-only list routes whose loaders and components share exact query keys. After
the first render, idle work warms permission-visible route *code* with
`router.loadRouteChunk()` — never loaders or API reads — capped at two route
chains (one on 3G) and paused for Save Data, 2G, offline, hidden, and page-hide.
The router keeps the current screen mounted during navigation and shows a
non-blocking progress rail only after 180 ms. `useServerTable()` suppresses only
the immediate duplicate within a five-second intent-prefetch grace period;
invalidated data and ordinary route returns must still revalidate. Do not
speculatively warm adjacent Orders or Customers pages or bulk-sync protected
data. See [docs/PERFORMANCE-RELEASE.md](../../docs/PERFORMANCE-RELEASE.md) before
changing router pending behavior, adopting Table v9, adding virtualization, or
broadening preload behavior.

**Client bundle safety**: keep the framework's `$initial` Rolldown group unsplit —
a size cap can divide a strongly connected ESM graph and crash the app before
login is interactive. Production builds reject reciprocal static chunk imports;
preserve that gate when changing bundle grouping. Generated JS and CSS live under
`/assets/immutable/` with Vite content hashes and one-year immutable headers;
HTML, source maps, and copied stable public assets must stay outside that
namespace.

**Read timeouts**: read-only API transport (`GET`/`HEAD`) is bounded by
`ADMIN_API_READ_TIMEOUT_MS` in `src/lib/admin-api-timeout.ts`, including slow
body reads. Write methods are deliberately unbounded so committed mutations and
long imports are not reported as timed-out guesses.

**Scroll restoration**: the shell registers the nested `#admin-main-scroll`
container with TanStack Router scroll restoration.
`useAdminNestedScrollRestoration()` resets to top on normal client navigation and
restores the saved position only on Back/Forward. Do not add ad hoc
route-change `scrollTo()` effects; extend the helper instead.

**Settings drafts**: drafts keep the current values and the acknowledged server
baseline together. Save responses preserve fields edited since submission; query
refreshes preserve fields changed from the prior baseline while adopting
untouched server values. Each top-level field, including nested settings, is
compared as one value. Reset returns to the latest acknowledged baseline, and
navigation stays guarded while dirty or saving. Checkout Flow additionally
rebases field-wise on save acknowledgments and revision conflicts, pausing
background synchronization during saves and conflict resolution.

**Checkout readiness preview**: the Checkout Flow panel reads
`/api/v1/admin/settings/checkout-readiness`, so a transient transport failure
does not become a false delivery-setup warning. If the read still fails, the
panel must describe it as an admin status
refresh failure while public checkout continues to fail closed from the API
policy.

## Pages

**Auth**: setup, login, two-factor, forgot/reset password.

**Admin** (60+ routes): dashboard · products (list, create, edit, variants,
images, SEO) · orders (list, create, edit, shipments, payments, invoices) ·
categories · collections · customers · discounts · promotions · pages/CMS ·
articles · attributes · inventory · media manager · analytics · abandoned
checkouts · navigation · settings (account, agent access, cache, checkout,
delivery providers, fraud checker, hero sliders, Meta conversions, notifications,
taxes, theme, general) · invoice PDFs · scanner/QR app.

Order detail supports provider shipments and manual fulfillment.
`ManualFulfillmentDialog` posts the selected unshipped item IDs to the orders
admin API, invalidates order detail and shipments, and computes
final-shipment intent from the remaining fulfillable items. The refresh action is
shown only for provider-backed shipments. If a provider shipment is created but
local finalization needs repair, the recovery notice exposes an RBAC-gated
`Repair shipment` action that reconciles local order and inventory state from
persisted shipment evidence without creating another provider shipment.

Scanner QR token minting is a privileged same-origin admin action: it requires an
authenticated session with 2FA already verified when 2FA is enabled, then
`products.view` plus `products.edit` RBAC or super-admin access before any KV
token is written.

## Key files

| File | Purpose |
|------|---------|
| `index.html` | Blank shell; the API Worker fills in the base path |
| `src/main.tsx` | Entry: resolves the first route, then renders |
| `src/router.tsx` | Router config (base path, scroll restoration, errors) |
| `src/routes/__root.tsx` | Root layout and providers |
| `src/routes/admin.tsx` | Admin layout, auth guard, RBAC context |
| `src/lib/auth-guards.ts` | Route guards over `/api/auth/dashboard-session` |
| `src/lib/admin-query-client.ts` | QueryClient defaults (idle-tab/reconnect policy) |
| `src/lib/admin-route-context.ts` | Stale-while-revalidate auth/RBAC shell context |
| `src/lib/api.ts` | SDK client transport + `apiData()` envelope unwrapping |
| `src/lib/api-query-options/` | Domain queryOptions with per-domain staleTime |
| `src/lib/api-mutations/` | Domain mutation hooks with cache invalidation |
| `src/lib/admin-api-timeout.ts` | Read-only API timeout helper |
| `src/lib/query-keys.ts` | Centralized query key factory |
| `src/lib/list-helpers.tsx` | Shared list search schemas and selectors |
| `src/lib/route-error.tsx` | Route-level error boundary |

## Shared hooks and components

| File | Purpose |
|------|---------|
| `hooks/use-entity-form-submit.ts` | Form submit with invalidation + navigation |
| `hooks/use-settings-form.ts` | Settings forms (query + mutation + state sync) |
| `components/admin/shared/FormContainer.tsx` | Form wrapper + UnsavedChangesGuard |
| `components/admin/shared/UnsavedChangesGuard.tsx` | `useBlocker` + `beforeunload` |
| `components/admin/shared/StatusBadges.tsx` | Order/payment/shipment badges |
| `components/admin/shared/LoadingFallback.tsx` | Suspense fallbacks + skeletons |
| `components/admin/shared/SortableList.tsx` | dnd-kit abstraction |
| `components/admin/data-table/` | DataTable, `useServerTable`, column factories |

Product descriptions import the real Tiptap editor in the product-form chunk;
while `useEditor()` initializes, `TiptapEditor` shows a disabled toolbar plus
sanitized content so the surface never looks broken. Lower-priority rich fields
use `DeferredTiptapEditor` to keep Tiptap out of non-editor route bundles.
