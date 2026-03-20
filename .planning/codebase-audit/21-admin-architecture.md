# Audit 21 -- Admin App Architecture

**Scope:** `apps/admin/` -- middleware chain, layouts, loaders, lib, worker, page structure, component patterns, state management, type safety.

**Reviewed files:** 35+ files across middleware/, layouts/, lib/, pages/, loaders/, types/, contexts/, store/, hooks/, plus package.json, astro.config.mjs, worker.ts, env.d.ts.

---

## 1. Middleware Chain

**Composition (middleware/index.ts):**
```
auth -> admin-detection -> rbac -> csp -> cache-invalidation
```

Uses Astro's `sequence()` -- clean, explicit ordering.

### auth.ts
- Detects Cloudflare environment vs process.env with a probe-based heuristic (`(cfEnv as any)?.ASSETS || ...`).
- Initializes DB, KV, and R2 storage via `Promise.all` (good).
- Extracts Better Auth session and populates `context.locals.session`, `context.locals.user`.
- Stores `_env` on locals for downstream middleware.
- Calls `setRequestHeaders()` to stash request headers for SSR loaders (more on this below).
- Skips session extraction for non-admin API routes and Better Auth routes.

### admin-detection.ts
- Checks whether admin users exist (with memory + KV cache).
- Redirects to `/auth/setup` if no admins, `/auth/login` if unauthenticated.
- Handles 2FA redirect logic correctly.
- Memory cache (`memoryHasAdminUsers`) persists per isolate -- acceptable for single-tenant.

### rbac.ts
- Auto-seeds RBAC permissions on first load.
- Loads user permissions into `context.locals.permissions` (a `Set<string>`).
- Enforces API route protection with pattern matching (`protectedApiPatterns`).
- Enforces page-level access via `hasPageAccess()`.
- Has special scanner-token path for inventory endpoints.
- Supports `permission`, `anyOf`, and `allOf` requirement shapes.

### csp.ts
- Injects Content-Security-Policy headers on non-API responses.
- Duplicates the CF env detection logic from auth.ts.

### cache-invalidation.ts
- Post-response middleware: detects admin writes, triggers cache purges.
- Uses `waitUntil()` for background invalidation (non-blocking).
- KV-based debounce (2s window) prevents redundant purges.

**Verdict:** Well-structured five-stage pipeline. Each middleware has a single responsibility. Error handling is defensive -- middleware failures log but don't crash responses.

### Issues

| ID | Severity | Description |
|----|----------|-------------|
| MW-1 | Low | CF env detection duplicated in auth.ts and csp.ts. Both do the same `(cfEnv as any)?.ASSETS` probe. Could extract to a shared helper, but impact is minimal (two call sites). |
| MW-2 | Medium | `setRequestHeaders()` in api-server.ts uses a module-level `let _requestHeaders`. On Cloudflare Workers, a single isolate can handle concurrent requests. If two requests overlap, one can overwrite the other's headers. In practice this is unlikely for a single-tenant admin dashboard, but architecturally it is a shared-mutable-state bug. The correct fix is to pass headers through `context.locals` or use `AsyncLocalStorage`. |
| MW-3 | Low | Every middleware does `return (await next()) || new Response()` as a null guard. This is defensive against Astro edge cases but the `|| new Response()` produces a bare 200 with no body, which could mask bugs in development. |
| MW-4 | Info | `protectedApiPatterns` in rbac.ts uses a flat list of regex patterns. This works but will grow linearly as domains are added. Not a problem at current scale (~17 patterns). |

---

## 2. API Proxy (admin -> API service binding)

**File:** `pages/api/v1/[...path].ts`

The admin proxy is the critical bridge between browser-side React components and the API worker.

### Mechanism
- Production: Cloudflare Service Binding (`env.API.fetch()`) -- zero-latency, no network hop.
- Dev: HTTP forward to `localhost:8787`.
- Applies `unwrapStandardizedResponse()` to transform the API envelope.

### Envelope Unwrapping
The API returns `{ success: true, data: T }`. The proxy transforms this to `{ success: true, ...T }` when T is a non-null, non-array object. This flattening allows admin components to read entity fields at the top level (legacy compat).

Error responses are also flattened: `{ success: false, error: { code, message } }` becomes `{ success: false, error: "message string", errorCode: "CODE" }`.

### Dev Mode Bypass (Known Issue)
Vite's dev proxy in `astro.config.mjs` intercepts `/api/v1/*` and forwards directly to the API worker, **bypassing** the admin proxy entirely. This means:
- Dev: browser receives raw `{ success, data: T }` envelope
- Prod: browser receives unwrapped `{ success, ...T }` envelope

This is documented and handled in `api-browser.ts` which normalizes both shapes. But it creates a divergence between dev and prod behavior that has been the #1 production bug pattern (per CLAUDE.md memory).

### Issues

| ID | Severity | Description |
|----|----------|-------------|
| PX-1 | High | Dev/prod response shape divergence. The Vite proxy bypasses the admin proxy in dev, so client code must handle two envelope shapes. This is working but fragile -- any new client-side fetch that forgets to normalize will break in one environment. |
| PX-2 | Low | `@ts-ignore` on line 129 for `duplex: "half"`. TypeScript doesn't know about this Fetch API option. Minor, but could use a typed override. |
| PX-3 | Info | The proxy passes through `ctx.request.body` as a stream. For service binding this is optimal (zero-copy). For dev HTTP forwarding, the `duplex: "half"` is required and correctly set. |

---

## 3. Loader Pattern

**Directory:** `src/loaders/admin/` -- 10 domain-specific loader files.

### Pattern
1. Astro page frontmatter calls a loader function: `const data = await getProductsIndexData(...)`.
2. Loader calls `apiGet<T>()` from `api-server.ts`.
3. `apiGet` fetches from the API worker (service binding in prod, HTTP in dev).
4. `apiGet` unwraps the `{ success, data: T }` envelope and returns `T`.
5. Loader transforms dates (API returns timestamps, loaders convert to `Date` objects).
6. Loader returns a shaped object that the Astro page destructures and passes as props to React components.

This is a clean separation:
- **Page**: URL param parsing + layout choice
- **Loader**: API calls + data transformation
- **Component**: Pure React with props

### Parallel Fetching
Loaders use `Promise.all` for independent API calls (e.g., `getProductsIndexData` fetches categories, products, and stats in parallel). Good practice.

### Error Handling
Loaders use `.catch(() => null)` for detail fetches and redirect to list pages on null. This is a reasonable pattern for edit pages where the entity might not exist.

### Issues

| ID | Severity | Description |
|----|----------|-------------|
| LD-1 | Medium | `getOrderFormProducts()` in orders.ts fetches ALL products (limit: 999) then fetches each product's detail individually via `Promise.all`. This creates N+1 API calls. For a store with 500 products, this is 501 requests on order form load. Should use a batch endpoint or include variant data in the list response. |
| LD-2 | Low | Date conversion logic is repeated across every loader (products, orders, etc.). A utility like `convertTimestamps()` could reduce duplication. |
| LD-3 | Info | Loaders import types from `@/types/api-responses` (admin-owned types). This is correct -- decouples admin from `@scalius/database/schema`. But `orders.ts` also imports `OrderListItem` from `@scalius/core/modules/orders`, breaking this boundary. |

---

## 4. Component Organization

### Directory Structure
```
src/components/
  admin/              # Domain components
    adminLayout/      # Sidebar (Astro + vanilla JS)
    product-form/     # Multi-file: types.ts, sections, variants/
    product-list/     # List component
    order-form/       # Multi-file with context
    order-list/       # List + pagination
    categories/       # CRUD
    collections-list/ # List + hooks
    attributes-manager/ # Manager + hooks
    pages-list/       # List + hooks
    widget-list/      # List + hooks
    widgets/          # Widget form
    media-manager/    # Complex: api/, components/, hooks/, utils/, types/
    discount/         # Discount form
    settings/         # Settings builders
    header-builder/   # Header config
    footer-builder/   # Footer config
    navigation/       # Nav builder
    shared/           # AdminListPagination, PageSection
  auth/               # Login, 2FA, UserMenu
  ui/                 # shadcn/ui primitives
```

### Naming Conventions
- Domain components: PascalCase with domain prefix (e.g., `ProductForm`, `OrderView`, `CategoryToolbar`)
- List components use barrel exports: `index.ts` re-exports the main component
- Complex domains have sub-directories: `hooks/`, `components/`, `utils/`, `types/`
- Shared components live in `components/admin/shared/`

### Patterns
- **List pages**: Toolbar + Table + Pagination + Statistics + DeleteDialog
- **Form pages**: Form component with section sub-components
- **Index files**: Barrel re-exports for cleaner imports
- **Hooks**: Domain-specific hooks co-located with their component (e.g., `attributes-manager/hooks/`)

### Issues

| ID | Severity | Description |
|----|----------|-------------|
| CO-1 | Low | Inconsistent sub-directory naming: `product-form/` uses `variants/` sub-dir with its own barrel, `order-form/` uses flat files with a context. `media-manager/` has the most structure (api/, hooks/, utils/, types/). No single "canonical" pattern. |
| CO-2 | Info | Some domains have both `categories/` (component) and `categories/index.ts` (barrel). Others like `OrderView.tsx` are single-file. The split correlates with complexity, which is reasonable. |
| CO-3 | Low | Pagination is duplicated: `AdminListPagination` in shared/ plus domain-specific ones like `AttributePagination`, `CollectionPagination`, `PagePagination`, `OrderListPagination`. These likely have similar logic and could be consolidated. |

---

## 5. State Management

### Approaches Used
1. **Nanostores** (`orderStore.ts`): Atoms + computed map for order form calculations. Framework-agnostic, works with Astro's island architecture. Used via `@nanostores/react`.
2. **React Context** (`PermissionContext.tsx`): Permissions and super-admin status.
3. **Window globals** (`UserContext.astro`): `__USER_ID__`, `__USER_PERMISSIONS__`, `__IS_SUPER_ADMIN__` set via inline script.
4. **Module-level singletons**: Currency data in `use-currency.ts`, request headers in `api-server.ts`.
5. **URL state**: List pages read search params from URL (page, sort, search, category).

### Permission Flow
```
Server (middleware) -> Astro locals -> UserContext.astro (window globals) -> PermissionContext.tsx (React context) -> usePermissions() hook
```

The `usePermissions()` hook has a clever fallback: it tries React context first, then falls back to reading `window.__USER_PERMISSIONS__` directly. This means components work whether or not they're wrapped in `<PermissionProvider>`.

### Issues

| ID | Severity | Description |
|----|----------|-------------|
| SM-1 | Low | `orderStore.ts` is the only nanostores usage. The rest of the app uses React hooks and context. This isn't wrong (nanostores works well for cross-island state in Astro), but it's a single outlier. |
| SM-2 | Medium | Window globals (`__USER_PERMISSIONS__`, `__IS_SUPER_ADMIN__`) are not typed at the assignment site. The `UserContext.astro` inline script uses `define:vars` which injects values but has no type checking. The consumer side (`PermissionContext.tsx`) declares the Window interface extension correctly. |
| SM-3 | Low | `use-currency.ts` uses a module-level singleton with listener pattern. This is well-implemented (deduplicates fetch, uses localStorage as L1 cache), but the pattern is unique in the codebase -- every other hook is a standard React hook. |

---

## 6. Client-Side vs Server-Side API

### api-server.ts (SSR)
- Used by loaders in Astro page frontmatter.
- Calls API worker directly via service binding (prod) or HTTP (dev).
- Unwraps `{ success, data: T }` envelope, returns `T`.
- Forwards auth cookies from `_requestHeaders` (set by middleware).

### api-browser.ts (Client)
- Used by React components after hydration.
- Calls through the admin proxy (`/api/v1/admin/*`).
- Handles both envelope shapes (raw and proxy-unwrapped).
- Exports: `clientGet`, `clientPost`, `clientPut`, `clientDelete`, `unwrapApiResponse`.

### api-helpers.ts
- `extractApiError()`: Normalizes both error shapes to a string.
- `unwrapEnvelope()`: Extracts `data` from raw envelope. Used by `use-currency.ts`.

### Separation Quality
The separation is clean and well-documented. Comments explain the dev/prod divergence explicitly. Both modules export the same verb-based API surface (`get`, `post`, `put`, `delete`).

### Issues

| ID | Severity | Description |
|----|----------|-------------|
| API-1 | Low | `api-browser.ts` always sets `Content-Type: application/json` for POST/PUT. This means file uploads from client-side would need to bypass this utility (and they do -- media-manager has its own API module). Not a bug, but worth noting. |
| API-2 | Info | `sdk.ts` is a thin re-export of `@scalius/api-client`. It exists but appears unused in the audit scope -- loaders use `api-server.ts` directly, client code uses `api-browser.ts`. The SDK may be used in other places or is a future integration point. |
| API-3 | Medium | The `_requestHeaders` in `api-server.ts` (MW-2 above) is the only shared mutable state in the SSR path. All other SSR code uses `context.locals` correctly. |

---

## 7. Auth Flow

```
1. Request arrives at Cloudflare Worker (worker.ts)
2. Astro handles routing, middleware chain runs:
   a. authMiddleware: extracts Better Auth session -> locals.session, locals.user
   b. adminDetectionMiddleware: redirects to /auth/setup or /auth/login if needed
   c. rbacMiddleware: loads permissions -> locals.permissions, enforces access
3. Astro page renders:
   a. AdminLayout.astro: reads locals.user, redirects if null (defense-in-depth)
   b. Generates nav sections filtered by permissions
   c. Sets window globals via UserContext.astro
4. React components hydrate:
   a. PermissionContext reads window globals
   b. Components use usePermissions() for UI gating
   c. API calls go through api-browser.ts -> admin proxy -> API worker
   d. API worker has its own auth layer (the admin proxy forwards cookies)
```

### Auth Client (lib/auth-client.ts)
- Uses `better-auth/react` with `twoFactorClient` and `adminClient` plugins.
- Auth endpoints live on the admin worker (same-origin), not the API worker.
- Exports `signIn`, `signUp`, `signOut`, `useSession`, `twoFactor`, `admin`.

### Issues

| ID | Severity | Description |
|----|----------|-------------|
| AU-1 | Info | Defense-in-depth: AdminLayout.astro checks `user`/`session` and redirects even though middleware already handles this. This is correct -- layout is the last gate. |
| AU-2 | Low | `AdminLayout.astro` line 41 uses `(user as any).isSuperAdmin`. The `BetterAuthUser` type in env.d.ts defines `isSuperAdmin?: boolean | null`, so this cast is unnecessary -- it should just be `user.isSuperAdmin ?? false`. |

---

## 8. Page Templates

### Patterns Observed

**Dashboard (index.astro):**
```
Frontmatter: call loader -> destructure
Layout: AdminLayout
Body: hydrated React components with server-fetched props
```

**List page (products/index.astro):**
```
Frontmatter: parse URL search params -> call loader with params -> destructure
Layout: AdminLayout
Body: single React list component with all data as props
```

**Edit page (products/[id]/edit.astro):**
```
Frontmatter: extract route param -> call loader -> null check + redirect -> destructure
Layout: AdminLayout
Body: React form + variant manager, both with server-fetched props
Script: page-specific client script (variant scroll)
```

**Create page (products/new.astro):**
```
Frontmatter: fetch form options (categories) -> build default values
Layout: AdminLayout
Body: React form with defaults + categories
Script: page-specific client script
```

### Page Count
47 `.astro` pages under `pages/admin/`, covering: dashboard, products, categories, attributes, collections, media, pages (CMS), widgets, orders, abandoned checkouts, customers, discounts, analytics, inventory, settings (general, theme, account, notifications, hero-sliders, checkout, delivery-providers, fraud-checker, meta-conversion, cache), access-denied.

### Hydration Strategies
- `client:idle` -- most interactive components (forms, lists, stats). Hydrates after main thread is idle.
- `client:visible` -- below-fold components (recent orders, quick actions). Hydrates when scrolled into view.
- `client:load` -- critical interactive components (notification dropdown, toast portal).

Good use of selective hydration.

### Issues

| ID | Severity | Description |
|----|----------|-------------|
| PG-1 | Low | Relative imports in pages: `../../layouts/AdminLayout.astro`, `../../../components/admin/product-list`. Some pages use `@/` alias, others use relative paths. Inconsistent but functional. |
| PG-2 | Info | View transitions via `<ClientRouter />` in AdminLayout. The `transition:name` and `transition:animate` attributes are used for smooth SPA-like navigation. The nav-progress system intercepts link clicks for loading states. |

---

## 9. Type Safety

### Actual `any` Count: 27 occurrences across 20 files

This is **significantly better** than the "~250 any types" mentioned in CLAUDE.md. The backlog item appears outdated.

### Breakdown of Remaining `any` Usages
- **env.d.ts**: 1 (JSX IntrinsicElements -- unavoidable)
- **Cloudflare env probing**: 3 (auth.ts, csp.ts, hono-cache-invalidator.ts -- `(cfEnv as any)?.ASSETS`)
- **AdminLayout.astro**: 3 (window globals for sidebar, `user as any` for isSuperAdmin)
- **SideBar.astro**: 2 (likely similar window/DOM typing)
- **Firebase init**: 2 (third-party SDK typing)
- **Component-level**: ~16 spread across 10 component files (form handling, API responses)

### Type Infrastructure
- `env.d.ts`: Comprehensive -- 262 lines declaring Cloudflare binding types, `App.Locals`, Better Auth types.
- `types/api-responses.ts`: 668 lines of admin-owned API response types covering all domains. Well-organized with section comments.
- Type imports use `import type` consistently.

### Issues

| ID | Severity | Description |
|----|----------|-------------|
| TS-1 | Low | The CLAUDE.md claim of "~250 any types" is outdated. Actual count is 27. The backlog item should be updated. |
| TS-2 | Low | 3 of the 27 `any` usages are for CF env probing (`(cfEnv as any)?.ASSETS`). These could be replaced with a typed helper: `function isCfEnv(e: unknown): e is Env`. |
| TS-3 | Info | `types/api-responses.ts` duplicates shapes from the database schema. This is intentional (decoupling), but means changes to the DB schema must be reflected here manually. The SDK (`@scalius/api-client/types`) would eventually replace these if regenerated. |
| TS-4 | Low | `orders.ts` loader imports `OrderListItem` from `@scalius/core/modules/orders`, breaking the otherwise clean boundary where admin only uses `@/types/api-responses`. |

---

## 10. LLM-Friendliness

### Can an LLM easily add a new admin page + component?

**Yes, with high confidence.** The patterns are consistent and well-documented.

### Recipe for Adding a New Admin Page

1. **Create loader** in `src/loaders/admin/{domain}.ts`:
   - Import `apiGet` from `@/lib/api-server`
   - Import types from `@/types/api-responses`
   - Export async function that calls API and transforms data

2. **Create page** in `src/pages/admin/{domain}/index.astro`:
   - Parse URL search params
   - Call loader
   - Wrap in `<AdminLayout>`
   - Render React component with `client:idle`

3. **Create component** in `src/components/admin/{domain}/`:
   - React component receiving server-fetched data as props
   - Use `clientGet`/`clientPost` from `api-browser.ts` for client-side actions
   - Use `usePermissions()` for permission gating

4. **Add types** to `src/types/api-responses.ts` if new shapes are needed.

5. **Add nav item** to `src/layouts/components/AdminNav.ts`:
   - Add to appropriate section with icon and permission requirement.

6. **RBAC**: Add route pattern to `rbac.ts` `protectedApiPatterns` if new API paths are needed.

### Strengths for LLM Comprehension
- Consistent file naming (`index.astro` for list, `[id]/edit.astro` for edit, `new.astro` for create)
- Loader pattern abstracts API complexity from pages
- `api-server.ts` and `api-browser.ts` have clear JSDoc comments explaining the envelope contract
- AdminNav.ts is self-documenting (declarative nav structure with permissions)
- CLAUDE.md has a "How-To Recipes" section for adding entities

### Weaknesses for LLM Comprehension
- Dev/prod envelope divergence requires understanding three files (admin proxy, api-server, api-browser) to get right
- No single "template" file to copy from -- the pattern must be inferred from multiple examples
- Permission constants come from `@scalius/core/auth/rbac/permissions` (cross-package reference)

---

## 11. Summary of All Issues

### High Severity
| ID | Description | Recommendation |
|----|-------------|----------------|
| PX-1 | Dev/prod response envelope divergence | Consider removing the Vite proxy override so dev also routes through the admin proxy. This eliminates the dual-envelope problem entirely. The only downside is multipart upload handling in dev, which can be special-cased. |

### Medium Severity
| ID | Description | Recommendation |
|----|-------------|----------------|
| MW-2 | Module-level `_requestHeaders` is shared mutable state | Pass headers through `context.locals` and thread them to loaders via a parameter, or use `AsyncLocalStorage` (available in Workers). |
| LD-1 | N+1 API calls in `getOrderFormProducts()` | Add a `/products/with-variants` batch endpoint or include variant summary in the products list response. |
| API-3 | Same issue as MW-2 | See MW-2 recommendation. |
| SM-2 | Window globals lack type safety at assignment | Minor; the consumer side is typed correctly. Could use a typed setter function. |

### Low Severity
| ID | Description | Recommendation |
|----|-------------|----------------|
| MW-1 | Duplicated CF env detection | Extract to shared helper if more middleware is added. |
| MW-3 | `|| new Response()` null guard could mask bugs | Acceptable defensive pattern. |
| LD-2 | Repeated date conversion in loaders | Extract `convertTimestamps()` utility. |
| LD-3 | orders.ts imports from @scalius/core | Use admin-owned types consistently. |
| CO-1 | Inconsistent component sub-directory structure | Document the "canonical" structure for new domains. |
| CO-3 | Duplicated pagination components | Consolidate to `AdminListPagination` in shared/. |
| SM-1 | Nanostores is a single outlier | Not a problem; works well for the order form use case. |
| SM-3 | Singleton pattern in use-currency unique | Fine as-is; well-implemented. |
| AU-2 | Unnecessary `as any` cast for isSuperAdmin | Remove cast, use direct property access. |
| PG-1 | Mixed relative and alias imports | Standardize on `@/` alias. |
| TS-1 | CLAUDE.md `any` count outdated | Update to reflect actual ~27 count. |
| TS-2 | CF env probing uses `as any` | Replace with typed helper. |
| TS-4 | orders.ts breaks admin type boundary | Switch to admin-owned type. |
| API-1 | api-browser forces JSON content type | Document that file uploads bypass this utility. |

### Info
| ID | Description |
|----|-------------|
| MW-4 | Protected API patterns list will grow linearly |
| PX-3 | Stream pass-through for service binding is optimal |
| AU-1 | Defense-in-depth auth check in layout is correct |
| PG-2 | View transitions and nav-progress well-integrated |
| TS-3 | api-responses.ts duplicates schema shapes (intentional) |
| API-2 | sdk.ts appears unused in current flow |
| CO-2 | Single-file vs directory correlates with complexity |

---

## 12. Architecture Quality Assessment

| Dimension | Rating | Notes |
|-----------|--------|-------|
| Middleware design | Strong | Clean separation, explicit ordering, defensive error handling |
| Data loading | Strong | Loader pattern isolates API calls from pages, good use of parallel fetching |
| Type safety | Good | 27 remaining `any` (down from ~250), comprehensive type declarations |
| Client/server separation | Good | Clear split between api-server and api-browser, well-documented |
| Auth flow | Strong | Multi-layer defense (middleware + layout + RBAC), 2FA support, scanner token |
| Page templates | Strong | Consistent CRUD patterns, good hydration strategy choices |
| Component organization | Good | Domain-scoped with barrel exports, but some structural inconsistency |
| State management | Good | Minimal global state, appropriate tool choices per use case |
| LLM-friendliness | Good | Consistent patterns, good docs, but envelope contract requires multi-file understanding |
| Performance | Good | Selective hydration, parallel fetching, cache invalidation with debounce |

**Overall:** Solid admin architecture for an Astro 6 SSR + React 19 app on Cloudflare Workers. The main architectural risk is the dev/prod envelope divergence (PX-1), which is documented but remains a frequent source of bugs. The `_requestHeaders` shared state (MW-2) is the only concurrency concern.
