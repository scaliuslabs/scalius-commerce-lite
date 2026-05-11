# Admin Shell / Data Audit

## Scope

- Ownership audited: `apps/admin-v2` shell, routing, auth integration, server functions, query/mutation plumbing, proxy routes, shared hooks/stores/types that shape the admin app's data flow.
- Focus areas:
  - Router/root/layout behavior
  - Auth/session handling and RBAC boundaries
  - `createServerFn` transport layer and query/mutation wrappers
  - API proxy routes and Cloudflare binding usage
  - Cache invalidation and app-shell performance characteristics
- Out of scope:
  - Deep domain review of individual admin screens except where a screen reveals a shell/data-plumbing defect
- Verification approach:
  - Traced the browser -> TanStack Start -> server function / server route -> Cloudflare binding / API worker path
  - Cross-checked the admin shell against the API auth middleware and RBAC route-permission map
  - Reviewed with `tanstack-start` guidance and Workers binding best-practice guidance in mind
  - Attempted targeted admin typecheck (`pnpm --filter @scalius/admin-v2 typecheck` / `tsc --noEmit`), but it did not finish within the audit window, so findings below are based on direct code inspection rather than a completed typecheck pass

## How The Admin App Works End To End

1. Router/bootstrap
   - `apps/admin-v2/src/router.tsx` creates a per-router `QueryClient`, installs default query behavior, and wires `setupRouterSsrQueryIntegration()` so TanStack Router and TanStack Query can stream/dehydrate together.
   - `apps/admin-v2/src/routes/__root.tsx` renders the HTML shell, global CSS, favicon, theme init script, and `<Scripts />`.

2. Authenticated admin shell
   - `apps/admin-v2/src/routes/admin.tsx` is the layout route for the entire admin subtree.
   - Its `beforeLoad` calls `adminRouteGuard()` from `apps/admin-v2/src/lib/auth.fns.ts`.
   - `adminRouteGuard()` initializes Cloudflare bindings, reads the Better Auth session through `apps/admin-v2/src/lib/auth.server.ts`, loads RBAC permissions through `apps/admin-v2/src/middleware/rbac.server.ts`, and returns user/permission context.
   - `AdminLayout` then wraps the subtree in `PermissionProvider`, renders the sidebar/header shell, and initializes Firebase notifications via `useFirebaseInit()`.

3. Data loading pattern
   - Route loaders usually prewarm React Query caches with `queryClient.ensureQueryData(...)`.
   - Components then read the same query via `useSuspenseQuery()` or `useQuery()`.
   - Query definitions live in `apps/admin-v2/src/lib/api.queries.ts`.
   - The server-call surface lives in `apps/admin-v2/src/lib/api.functions.ts`, which exposes a very large set of `createServerFn()` wrappers over the API worker.
   - Mutation hooks live in `apps/admin-v2/src/lib/api.mutations.ts`, where success handlers invalidate query prefixes via centralized keys from `apps/admin-v2/src/lib/query-keys.ts`.

4. Server-side transport
   - `apps/admin-v2/src/lib/api.server.ts` is the server-only transport layer for server functions.
   - It forwards cookies / authorization headers from the current request, then talks to the API worker either:
     - through the `API` Cloudflare service binding in production, or
     - through `PUBLIC_API_BASE_URL` / localhost in fallback mode.
   - It unwraps the standard `{ success, data }` API envelope before returning values to server functions.

5. Proxy/server routes
   - `apps/admin-v2/src/routes/api/v1/admin/$.ts` is the browser-facing admin proxy route. It forwards same-origin `/api/v1/admin/*` requests to the API worker.
   - `apps/admin-v2/src/routes/api/auth/$.ts` hosts the Better Auth handler on the admin worker for same-origin auth flows.
   - `apps/admin-v2/src/routes/api/scanner-token.tsx` is a local admin-worker route backed by KV for the scanner pairing flow.
   - `apps/admin-v2/src/routes/firebase-messaging-sw[.]js.tsx` dynamically builds the FCM service worker script by fetching public Firebase config from the API worker.

6. Backend enforcement boundary
   - The API worker's admin routes are protected by `apps/api/src/middleware/admin-auth.ts`.
   - That middleware independently validates session/JWT/scanner auth, loads effective permissions, and applies route-level RBAC from `packages/core/src/auth/rbac/route-permissions.ts`.
   - This means the admin UI is not the final authority; the API is.

## Findings

### High

1. Account settings replaces the real admin auth context with a fake user and the full permission catalog, so the page can expose privileged UI to the wrong user and cannot represent the current user correctly.
   - Files:
     - `apps/admin-v2/src/routes/admin/settings/account.tsx:24-39`
     - `apps/admin-v2/src/components/admin/AccountSettingsWithPermissions.tsx:22-30`
     - `apps/admin-v2/src/components/admin/account-settings/AccountSettingsContainer.tsx:25-28`
     - `apps/admin-v2/src/components/admin/account-settings/ProfileHeader.tsx:28-29`
     - `apps/admin-v2/src/components/admin/account-settings/AdminUsersManager.tsx:95-99`
     - `apps/admin-v2/src/components/admin/account-settings/AdminUsersManager.tsx:248-284`
   - Why this matters:
     - The `/admin/settings/account` route does not reuse the authenticated user and permissions already provided by `/admin`.
     - Instead it synthesizes `userData` with `id: ""`, `name: "Admin"`, and `email: ""`, then builds a new `PermissionProvider` from `rbacPermissionsQueryOptions()`, which returns the global permission definitions rather than the current user's grants.
     - That nested provider shadows the correct provider from `apps/admin-v2/src/routes/admin.tsx`.
   - User-visible impact:
     - Profile header starts from fake data and cannot faithfully show or refresh the current user's real name/email/image.
     - Self-identity checks are wrong because `currentUserId` is blank, so "You" labeling and self-protection UI are broken.
     - Permission-gated tabs inside account settings are evaluated against the full permission catalog, not the authenticated user's actual grants.
   - Security / control impact:
     - The page can show management actions to users who should not see them. The API may still reject the action, but the shell is presenting incorrect authority.

2. Frontend admin access rules diverge from backend RBAC, and the shell never enforces page-level authorization, so direct URLs can reach pages the API will later reject.
   - Files:
     - `apps/admin-v2/src/lib/auth.fns.ts:148-167`
     - `apps/admin-v2/src/routes/admin.tsx:12-20`
     - `apps/api/src/middleware/admin-auth.ts:109-143`
     - `apps/admin-v2/src/components/admin/layout/AdminNav.ts:261-283`
     - `apps/admin-v2/src/routes/admin/access-denied.tsx:1-25`
   - Why this matters:
     - `adminRouteGuard()` returns `hasAdminAccess`, but does not enforce it before entering the shell.
     - Its access calculation still treats `userRole === "admin"` as sufficient.
     - The API middleware explicitly does the opposite: it does not trust the legacy role fallback and requires actual effective permissions.
   - Resulting conflict:
     - A user can be admitted into the admin shell by the frontend guard but rejected by the API on first real data call.
     - Navigation filtering is mostly handled by the sidebar, not the route layer, so direct deep links are not turned into `/admin/access-denied`; they usually collapse into generic route errors instead.
   - This is both a business-logic conflict and a UX failure:
     - the client says "allowed enough to enter"
     - the API says "not actually authorized"

### Medium

3. The list-route prefetch pattern warms default query keys instead of the URL-specific query key the page will actually render, so filtered/deep-linked entries pay an avoidable second fetch and lose the intended loader benefit.
   - Files:
     - `apps/admin-v2/src/routes/admin/products/index.tsx:76-90`
     - `apps/admin-v2/src/routes/admin/products/index.tsx:238-249`
     - `apps/admin-v2/src/routes/admin/categories/index.tsx:52-59`
     - `apps/admin-v2/src/routes/admin/orders/index.tsx:67-76`
     - `apps/admin-v2/src/routes/admin/customers/index.tsx:50-57`
     - `apps/admin-v2/src/routes/admin/discounts/index.tsx:45-52`
   - Why this matters:
     - These routes intentionally avoid `loaderDeps`, but they also hardcode `defaultApiParams = mapParams(searchSchema.parse({}))` inside the loader.
     - On a first hit to something like `/admin/products?page=5&search=shoe`, the loader prefetches the default list, then the component mounts and issues a second query for the actual URL state.
   - Impact:
     - extra request on cold deep links
     - wasted cache entries
     - route-level `ensureQueryData()` only partially delivers on "prefetch before render"
   - This repeats across most major list pages, so it is a structural pattern, not a one-off.

4. `ssr: false` on the `/admin` layout turns the entire admin app into a client-gated subtree on initial load, which undercuts the SSR/query-integration architecture and creates an avoidable auth/data waterfall.
   - Files:
     - `apps/admin-v2/src/routes/admin.tsx:12-19`
     - `apps/admin-v2/src/router.tsx:63-89`
   - Why this matters:
     - The router is configured for SSR-aware TanStack Query dehydration.
     - But the entire `/admin` subtree opts out of SSR.
     - On a cold request, the browser must:
       - load the shell JS
       - call `adminRouteGuard()` via server-function RPC
       - only then continue into child route data loading
   - Consequences:
     - slower first-load path for the admin area
     - server-side redirects are deferred until after client boot
     - the SSR/query integration mainly helps only after the SPA is already alive
   - This may be an intentional tradeoff, but it is a real architecture cost and should be documented as such.

5. The central admin transport layer is too opaque to the type system and too fragmented to behave as a single reliable data boundary.
   - Files:
     - `apps/admin-v2/src/lib/api.functions.ts:1`
     - `apps/admin-v2/src/lib/api.queries.ts:587-600`
     - `apps/admin-v2/src/components/admin/account-settings/hooks/useAdminUsers.ts:32-97`
     - `apps/admin-v2/src/hooks/use-firebase-init.ts:53-68`
   - Evidence:
     - `api.functions.ts` is `@ts-nocheck` despite being the 2,026-line server-function hub for the admin app.
     - `api.queries.ts` has a raw `fetch()` escape hatch for abandoned checkouts.
     - `useAdminUsers()` bypasses React Query entirely and manages fetch/state manually.
     - `useFirebaseInit()` posts directly with `fetch()` instead of going through the shared transport/mutation layer.
   - Impact:
     - response-shape drift and endpoint contract regressions can compile silently
     - cache invalidation and retry/error behavior differ by feature
     - the team now has multiple data-plumbing dialects inside the same shell

6. The setup/auth bootstrap flow still reflects an older "separate auth DB" mental model even though admin and API Workers point at the same D1, which makes first-user behavior harder to reason about and easier to break later.
   - Files:
     - `apps/admin-v2/src/components/auth/SetupForm.tsx:50-73`
     - `apps/admin-v2/src/routes/api/auth/$.ts:4-8`
     - `apps/admin-v2/wrangler.jsonc:19-25`
     - `apps/api/wrangler.jsonc:18-24`
   - Why this matters:
     - The setup form still runs API-side setup, then separately tries to create the same user in the admin worker with comments claiming each side has its own Better Auth DB.
     - Both workers are configured against the same D1 database in this repo.
   - Current runtime effect:
     - the second sign-up is expected to fail or no-op and is silently swallowed
   - Risk:
     - future auth changes are likely to be made against the wrong ownership model

## Complexity / Performance Notes

- The admin shell is heavily centralized:
  - `api.functions.ts` = 2,026 lines
  - `api.mutations.ts` = 1,800 lines
  - `api.queries.ts` = 907 lines
  - `api-responses.ts` = 714 lines
- That centralization creates consistency in naming and query-key structure, but it also means:
  - one transport-layer mistake can affect dozens of routes
  - type escapes (`@ts-nocheck`, `unknown`, `Record<string, unknown>`) accumulate at the single most important seam
  - onboarding cost is high because ownership boundaries are not obvious inside the shell layer
- The account settings area is currently a local example of shell drift:
  - it ignores the valid parent route context and rebuilds its own user/permission model incorrectly
  - it then adds a second permission provider, creating nested authority models in one screen
- The Cloudflare runtime typing is hand-maintained in `apps/admin-v2/src/env.d.ts:62-230`.
  - That works today, but it diverges from current Workers guidance, which recommends generated Wrangler types instead of manual binding stubs.
- There are still multiple ad-hoc fetch paths in the admin app.
  - That is understandable for exceptional payloads like abandoned-checkouts, but each exception makes auth/cache/error semantics harder to reason about end to end.

## Prioritized Follow-Ups

1. Fix account settings first.
   - Reuse the real `/admin` route context for current user + permissions.
   - Delete the nested `PermissionProvider`.
   - Stop deriving permission grants from `rbacPermissionsQueryOptions()`.
   - Pass the real current user id into `AdminUsersManager`.

2. Make frontend access rules match backend RBAC.
   - Remove the legacy `role === "admin"` fallback from the shell guard or explicitly align the API middleware.
   - Add route-level permission checks for privileged pages, with a deliberate redirect to `/admin/access-denied`.

3. Decide on a single list-route loading strategy.
   - Either add `loaderDeps` and prefetch the real URL-driven query key, or accept purely client-side query loading and remove misleading default-prefetch work.

4. Re-evaluate `ssr: false` on the admin subtree.
   - If the goal is first-load speed, measure the current client waterfall before keeping it.
   - If the goal is simplicity, document that the TanStack Query SSR integration is mainly for later navigations, not cold loads.

5. Shrink and re-type the transport layer.
   - Break `api.functions.ts` into domain files.
   - Remove `@ts-nocheck`.
   - Replace manual fetch/state hooks with React Query where feasible.

6. Clean up runtime binding typing and auth ownership docs.
   - Generate Worker binding types from Wrangler.
   - Update setup/auth comments so they describe the actual shared-D1 model.
