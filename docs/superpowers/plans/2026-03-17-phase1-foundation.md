# Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish shared infrastructure (middleware, layout, hooks, error boundaries, type strictness) so Phase 2 and Phase 3 have consistent patterns to follow.

**Architecture:** Split monolithic files into focused modules. Create reusable hooks for data fetching and error handling. Tighten TypeScript strictness. Extract inline scripts to importable modules.

**Tech Stack:** Astro 6, React 19, TypeScript 5.9, Hono, Better Auth, Tailwind v4, shadcn/ui

**Spec:** `docs/superpowers/specs/2026-03-17-admin-refactoring-design.md` — Phase 1 (sections 1.1–1.7)

**Parallel Groups:**
- Group A (Tasks 1–2): Middleware splitting + TypeScript strictness
- Group B (Tasks 3–4): AdminLayout splitting + SideBar splitting
- Group C (Tasks 5–7): Shared hooks + Error boundaries + Inline script extraction

Groups A, B, C can execute in parallel. All must complete before Phase 2 starts.

---

## Chunk 1: Group A — Middleware + TypeScript Strictness

### Task 1: Middleware Splitting

**Files:**
- Read: `apps/admin/src/middleware.ts` (352 lines — the source of truth)
- Create: `apps/admin/src/middleware/auth.ts`
- Create: `apps/admin/src/middleware/rbac.ts`
- Create: `apps/admin/src/middleware/admin-detection.ts`
- Create: `apps/admin/src/middleware/csp.ts`
- Create: `apps/admin/src/middleware/cache-invalidation.ts`
- Create: `apps/admin/src/middleware/index.ts`
- Delete: `apps/admin/src/middleware.ts` (after migration)

**Context:** The admin middleware handles 6 concerns in one 352-line function. Each concern communicates via `context.locals`. The Astro `sequence()` function composes them.

- [ ] **Step 1: Read the full middleware.ts**

Read `apps/admin/src/middleware.ts` completely. Identify the 6 concern boundaries:
1. CF env detection + DB/KV/storage init (lines ~99-120)
2. Session extraction from Better Auth (lines ~136-154)
3. Admin user existence check with memory+KV cache (lines ~49-96)
4. Permission loading + RBAC checks (lines ~160-323)
5. CSP header injection (lines ~325-336)
6. Hono cache invalidation (lines ~338-346)

- [ ] **Step 2: Create `apps/admin/src/middleware/auth.ts`**

Extract:
- CF env detection and DB/KV/storage initialization
- Better Auth session extraction (`auth.api.getSession()`)
- Setting `context.locals.session`, `context.locals.user`
- The `isCfEnv` detection logic

This module must run FIRST because all other middleware depends on `context.locals.user` and DB being initialized.

Target: under 100 lines.

- [ ] **Step 3: Create `apps/admin/src/middleware/admin-detection.ts`**

Extract:
- `hasAdminUsers()` function with its memory cache (`memoryHasAdminUsers`) and KV fallback
- Setup redirect logic (redirect to `/auth/setup` if no admins exist)
- Login redirect logic (redirect to `/admin` if already logged in)

Target: under 100 lines.

- [ ] **Step 4: Create `apps/admin/src/middleware/rbac.ts`**

Extract:
- Permission loading from DB (`getUserPermissions()`, `isSuperAdmin()`)
- RBAC auto-seeding (`autoSeedRbacIfNeeded()`)
- Route-level permission checking (protected API patterns, `getRoutePermission()`)
- Page-level permission checking (`hasPageAccess()`)
- 2FA enforcement (redirect to `/auth/two-factor` if not verified)
- Setting `context.locals.permissions`, `context.locals._isSuperAdmin`

This is the largest module. Target: under 150 lines (acceptable exception to 100-line guideline given RBAC complexity).

- [ ] **Step 5: Create `apps/admin/src/middleware/csp.ts`**

Extract the CSP middleware (currently lines ~325-336):
```typescript
import { defineMiddleware } from "astro:middleware";
import { setPageCspHeader } from "@scalius/core/middleware-helper/csp-handler";

export const cspMiddleware = defineMiddleware(async (context, next) => {
  await next();
  const pathname = new URL(context.request.url).pathname;
  if (!pathname.startsWith("/api/")) {
    try {
      const env = /* get env from context */;
      await setPageCspHeader(context.request, context.response.headers, env);
    } catch (e) {
      console.error("[CSP] Error:", e);
    }
  }
});
```

Target: ~20 lines.

- [ ] **Step 6: Create `apps/admin/src/middleware/cache-invalidation.ts`**

Extract the cache invalidation middleware (currently lines ~338-346):
```typescript
import { defineMiddleware } from "astro:middleware";
import { invalidateHonoCacheIfNeeded } from "@/lib/middleware-helper/hono-cache-invalidator";

export const cacheInvalidationMiddleware = defineMiddleware(async (context, next) => {
  await next();
  await invalidateHonoCacheIfNeeded(context);
});
```

Target: ~15 lines.

- [ ] **Step 7: Create `apps/admin/src/middleware/index.ts`**

Compose all middleware in explicit order:
```typescript
import { sequence } from "astro:middleware";
import { authMiddleware } from "./auth";
import { adminDetectionMiddleware } from "./admin-detection";
import { rbacMiddleware } from "./rbac";
import { cspMiddleware } from "./csp";
import { cacheInvalidationMiddleware } from "./cache-invalidation";

export const onRequest = sequence(
  authMiddleware,
  adminDetectionMiddleware,
  rbacMiddleware,
  cspMiddleware,
  cacheInvalidationMiddleware,
);
```

- [ ] **Step 8: Delete `apps/admin/src/middleware.ts`**

Remove the old monolithic file. Astro will pick up `middleware/index.ts` automatically.

- [ ] **Step 9: Verify**

Run: `pnpm typecheck`
Expected: PASS (zero type errors)

Manually verify: admin login flow, RBAC permission filtering, setup page redirect.

- [ ] **Step 10: Commit**

```bash
git add apps/admin/src/middleware/ && git add apps/admin/src/middleware.ts
git commit -m "refactor: split admin middleware into focused modules (auth, rbac, csp, cache)"
```

---

### Task 2: TypeScript Strictness

**Files:**
- Modify: `packages/tsconfig/base.json`
- Modify: `eslint.config.js`
- Modify: Various files across all workspaces (to fix new type errors)

**Context:** Enabling `noUncheckedIndexedAccess` adds `| undefined` to all indexed access (`arr[i]`, `obj[key]`). This surfaces 150-250 type errors. ESLint `no-explicit-any` goes from `off` to `warn`.

- [ ] **Step 1: Enable `noUncheckedIndexedAccess`**

In `packages/tsconfig/base.json`, add after line 4 (`"strict": true`):
```json
"noUncheckedIndexedAccess": true,
```

- [ ] **Step 2: Run typecheck to see the damage**

Run: `pnpm typecheck 2>&1 | head -100`
Expected: 150-250 new errors, mostly `Type 'X | undefined' is not assignable to type 'X'`

- [ ] **Step 3: Fix errors in `packages/shared/`**

Fix all `noUncheckedIndexedAccess` errors in the shared package. Common pattern:
```typescript
// Before:
const item = arr[0];
doSomething(item.prop);

// After:
const item = arr[0];
if (item) doSomething(item.prop);
```

Run: `pnpm typecheck --filter @scalius/shared`

- [ ] **Step 4: Fix errors in `packages/database/`**

Same pattern. Run: `pnpm typecheck --filter @scalius/database`

- [ ] **Step 5: Fix errors in `packages/core/`**

Largest package — expect 30-50 errors. Focus on:
- Array access in service functions
- Map/record access patterns
- `db.batch()` result access

DO NOT fix `db.batch() as any` casts — these are a Drizzle D1 limitation.

Run: `pnpm typecheck --filter @scalius/core`

- [ ] **Step 6: Fix errors in `apps/api/`**

Run: `pnpm typecheck --filter @scalius/api`

- [ ] **Step 7: Fix errors in `apps/admin/`**

Largest app — expect 50-80 errors. Focus on:
- Component array access (`.map()` callbacks, array destructuring)
- Loader return value access
- Form data access

Run: `pnpm typecheck --filter @scalius/admin`

- [ ] **Step 8: Fix errors in `apps/storefront/`**

Run: `pnpm typecheck --filter @scalius/storefront`

- [ ] **Step 9: Change ESLint any rule to warn**

In `eslint.config.js` line 48, change:
```javascript
"@typescript-eslint/no-explicit-any": "off",
```
to:
```javascript
"@typescript-eslint/no-explicit-any": "warn",
```

- [ ] **Step 10: Verify full build**

Run: `pnpm typecheck`
Expected: PASS (zero errors)

Run: `pnpm build`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add packages/tsconfig/base.json eslint.config.js
git add -u  # all modified files
git commit -m "chore: enable noUncheckedIndexedAccess, ESLint any to warn"
```

---

## Chunk 2: Group B — Layout + SideBar Splitting

### Task 3: AdminLayout Splitting

**Files:**
- Read: `apps/admin/src/layouts/AdminLayout.astro` (621 lines)
- Create: `apps/admin/src/layouts/components/AdminHeader.astro`
- Create: `apps/admin/src/layouts/components/AdminNav.ts`
- Create: `apps/admin/src/layouts/components/AdminSpinner.astro`
- Create: `apps/admin/src/layouts/components/ThemeInit.astro`
- Create: `apps/admin/src/layouts/components/UserContext.astro`
- Create: `apps/admin/src/layouts/components/FirebaseInit.astro`
- Create: `apps/admin/src/lib/client/nav-progress.ts`
- Modify: `apps/admin/src/layouts/AdminLayout.astro` (rewrite to ~80 line orchestrator)

- [ ] **Step 1: Read AdminLayout.astro completely**

Read all 621 lines. Map each section to its target file:
- Lines 1-66: Frontmatter (imports, auth check, redirect, props) → stays in AdminLayout
- Lines 68-125: Nav types + `hasNavPermission()` + nav sections data → `AdminNav.ts`
- Lines 126-252: Nav section definitions (Commerce, Sales, Settings items) → `AdminNav.ts`
- Lines 253-258: HTML head + title → stays in AdminLayout
- Lines 260-279: Theme init script → `ThemeInit.astro`
- Lines 280-292: Page structure open tags → stays in AdminLayout
- Lines 293-332: Header (breadcrumb, toggles, user menu) → `AdminHeader.astro`
- Lines 334-352: Main content area + slot → stays in AdminLayout
- Lines 354-357: Toasters → stays in AdminLayout
- Lines 359-434: Spinner CSS → `AdminSpinner.astro`
- Lines 436-535: Nav progress script → `lib/client/nav-progress.ts`
- Lines 537-573: Sidebar control script → stays inline (tiny, binds events)
- Lines 575-587: User context script → `UserContext.astro`
- Lines 589-619: Firebase init script → `FirebaseInit.astro`

- [ ] **Step 2: Create `AdminNav.ts`**

Pure TypeScript module. Extract:
- `NavSubItem` and `NavItem` interfaces
- `NavSection` interface
- `hasNavPermission()` function
- `getFilteredNavSections()` function that takes permissions Set + isSuperAdmin boolean, returns filtered NavSection[]
- All nav section definitions (Commerce, Sales, Settings)

This file has NO Astro dependencies — pure TS.

- [ ] **Step 3: Create `ThemeInit.astro`**

Extract the theme detection script (lines 260-279). MUST use `is:inline` attribute.
```astro
<script is:inline>
  // Theme FOUC prevention — runs before first paint
  (function() {
    const theme = localStorage.getItem("theme") || "light";
    // ... rest of theme detection logic
  })();
</script>
```

- [ ] **Step 4: Create `AdminHeader.astro`**

Extract lines 293-332: sticky header with breadcrumb, dark mode toggle, cache nuke button, user menu, sidebar toggle buttons.

Props: `{ user, breadcrumbItems }`

- [ ] **Step 5: Create `AdminSpinner.astro`**

Extract lines 359-434: CSS for loading spinner + overlay markup.

No props needed — purely visual.

- [ ] **Step 6: Create `UserContext.astro`**

Extract lines 575-587: script that sets `window.__USER_ID__`, `window.__USER_PERMISSIONS__`, `window.__IS_SUPER_ADMIN__`.

Props: `{ userId, permissions, isSuperAdmin }` — uses Astro `define:vars`.

- [ ] **Step 7: Create `FirebaseInit.astro`**

Extract lines 589-619: `requestIdleCallback` lazy-load of Firebase FCM.

No props — self-contained.

- [ ] **Step 8: Extract nav progress to `lib/client/nav-progress.ts`**

Extract lines 436-535 into a module that exports `initNavProgress()`. The AdminLayout calls this function from a small inline script.

- [ ] **Step 9: Rewrite AdminLayout.astro as orchestrator**

Replace the 621-line file with ~80 lines that imports and composes all extracted components:

```astro
---
import AdminHeader from "./components/AdminHeader.astro";
import AdminSpinner from "./components/AdminSpinner.astro";
import ThemeInit from "./components/ThemeInit.astro";
import UserContext from "./components/UserContext.astro";
import FirebaseInit from "./components/FirebaseInit.astro";
import SideBar from "@/components/admin/adminLayout/SideBar.astro";
import { getFilteredNavSections } from "./components/AdminNav";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
// ... auth check, redirect, breadcrumb generation
const navSections = getFilteredNavSections(permissions, isSuperAdmin);
---
<html>
<head>...</head>
<body>
  <ThemeInit />
  <SideBar navSections={navSections} currentPath={path} />
  <div class="admin-main">
    <AdminHeader user={user} breadcrumbItems={breadcrumbItems} />
    <main><AdminSpinner /><slot /></main>
  </div>
  <Toaster client:idle />
  <SonnerToaster client:idle />
  <UserContext userId={userId} permissions={permissionsArray} isSuperAdmin={isSuperAdmin} />
  <FirebaseInit />
</body>
</html>
```

- [ ] **Step 10: Verify**

Run: `pnpm typecheck`
Expected: PASS

Manually verify: admin pages load with correct layout, sidebar, header, theme toggle, loading spinner.

- [ ] **Step 11: Commit**

```bash
git add apps/admin/src/layouts/ apps/admin/src/lib/client/nav-progress.ts
git commit -m "refactor: split AdminLayout.astro (621→~80 lines) into focused components"
```

---

### Task 4: SideBar Splitting

**Files:**
- Read: `apps/admin/src/components/admin/adminLayout/SideBar.astro` (984 lines)
- Create: `apps/admin/src/components/admin/adminLayout/sidebar/sidebar-state.ts`
- Create: `apps/admin/src/components/admin/adminLayout/sidebar/sidebar-events.ts`
- Create: `apps/admin/src/components/admin/adminLayout/sidebar/sidebar-active.ts`
- Create: `apps/admin/src/components/admin/adminLayout/sidebar/sidebar-scroll.ts`
- Create: `apps/admin/src/components/admin/adminLayout/sidebar/sidebar.css`
- Modify: `apps/admin/src/components/admin/adminLayout/SideBar.astro` (rewrite to ~200 lines)

- [ ] **Step 1: Read SideBar.astro completely**

Read all 984 lines. Map the script sections (lines 397-840) to target modules:
- Storage keys + read/write helpers → `sidebar-state.ts`
- Collapse state + submenu persistence → `sidebar-state.ts`
- Path matching + active state logic → `sidebar-active.ts`
- Scroll save/restore → `sidebar-scroll.ts`
- Event binding + Astro lifecycle hooks → `sidebar-events.ts`
- All CSS (inline styles + scoped styles) → `sidebar.css`

- [ ] **Step 2: Create `sidebar-state.ts`**

Extract:
- `STORAGE_KEYS` constant
- `readStorage()` / `writeStorage()` helpers
- `getSavedSubmenuStates()` / `saveSubmenuStates()`
- `setSidebarCollapsed()` / `toggleSidebarCollapse()`
- `setSubmenuOpen()` / `setSubmenuOpenInstant()` / `syncOpenSubmenuHeights()`
- `isSubmenuOpen()` helper
- `window.__adminSidebarState` initialization

Fix: Align submenu collapse timeout from 300ms to 350ms (match CSS transition).

- [ ] **Step 3: Create `sidebar-active.ts`**

Extract:
- `isExactPathMatch()` / `isPrefixPathMatch()`
- `parentContainsActiveSubItem()` / `isParentItemActive()`
- `applyActiveStates()` — sets `.is-active` class and `aria-current="page"`
- `restoreSubmenuStates()` — opens submenus based on active path + saved state

Fix: Unify mobile and desktop path matching to both use `isPrefixPathMatch`.

- [ ] **Step 4: Create `sidebar-scroll.ts`**

Extract:
- `saveScrollPosition()` / `restoreScrollPosition()`
- `revealSettingsSubmenu()` — auto-scroll after Settings expand
- Scroll event listener with 150ms debounce

- [ ] **Step 5: Create `sidebar-events.ts`**

Extract:
- `bindSubmenuToggleHandlers()` — click delegation for submenu toggles
- `bindScrollPersistence()` — scroll listener binding
- `bindGlobalListeners()` — custom events, Astro lifecycle hooks
- `initializeSidebar()` — main init function
- Auto-invoke logic (DOMContentLoaded or requestAnimationFrame)

Imports and orchestrates the other 3 modules.

Fix: Remove reference to non-existent `#sidebar-collapse` element (line 625 in original).

- [ ] **Step 6: Create `sidebar.css`**

Extract all styles:
- Inline FOUC prevention styles (lines 38-83)
- Sidebar transition animations (lines 842-870)
- Submenu animations (lines 862-880)
- Active state styles (lines 882-940)
- Scrollbar styling (lines 942-955)
- FOUC pre-collapsed styles (lines 957-983)

Fix: Replace `max-height: 600px` on `.submenu-container:not(.hidden)` with `max-height: none`.

- [ ] **Step 7: Rewrite SideBar.astro as template-only**

~200 lines: frontmatter (imports, props, storefrontUrl fetch) + HTML template for desktop sidebar + mobile sidebar + overlay. No inline scripts or styles — all imported from modules.

```astro
---
import "./sidebar/sidebar.css";
// ... props, imports
---
<aside id="desktop-sidebar" ...>
  <!-- nav sections, logo, store link -->
</aside>
<div id="sidebar-overlay" ...></div>
<aside id="mobile-sidebar" ...>
  <!-- mobile nav -->
</aside>
<script>
  import { initializeSidebar } from "./sidebar/sidebar-events";
  initializeSidebar();
</script>
```

- [ ] **Step 8: Verify**

Run: `pnpm typecheck`
Expected: PASS

Manually verify: sidebar collapse, submenu expand/collapse, active state highlighting, mobile sidebar toggle, scroll persistence across page navigations.

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/components/admin/adminLayout/
git commit -m "refactor: split SideBar.astro (984→~200 lines) into focused modules"
```

---

## Chunk 3: Group C — Hooks, Error Boundaries, Script Extraction

### Task 5: Shared Data Fetching

**Files:**
- Create: `apps/admin/src/lib/api-fetch.ts`
- Create: `apps/admin/src/hooks/use-api.ts`
- Create: `apps/admin/src/types/window.d.ts`

- [ ] **Step 1: Create `apps/admin/src/types/window.d.ts`**

Global Window type extensions used across the admin:
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
  }
}
```

- [ ] **Step 2: Create `apps/admin/src/lib/api-fetch.ts`**

SSR-side API fetching for Astro pages (replaces loader DB calls in Phase 2):

```typescript
const API_BASE = "/api/v1/admin";

async function apiFetch<T>(
  method: string,
  path: string,
  options?: { body?: unknown; params?: Record<string, string> }
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`, "http://localhost");
  if (options?.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.pathname + url.search, {
    method,
    credentials: "include",
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  const json = await res.json();

  if (!res.ok || json.success === false) {
    const msg = json.error?.message || json.error || json.message || `API error ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  // Admin proxy unwraps { success, data: T } → { success, ...T }
  // Strip the success flag, return everything else
  const { success, ...data } = json;
  return data as T;
}

export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  return apiFetch<T>("GET", path, { params });
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>("POST", path, { body });
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>("PUT", path, { body });
}

export async function apiDelete(path: string): Promise<void> {
  await apiFetch<void>("DELETE", path);
}
```

- [ ] **Step 3: Create `apps/admin/src/hooks/use-api.ts`**

Client-side React hook for admin components:

```typescript
import { useState, useEffect, useCallback, useRef } from "react";

interface UseApiOptions<T> {
  initialData?: T;
  enabled?: boolean;
  params?: Record<string, string>;
  onSuccess?: (data: T) => void;
  onError?: (error: string) => void;
}

interface UseApiReturn<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
}

export function useApi<T>(path: string, options: UseApiOptions<T> = {}): UseApiReturn<T> {
  const { initialData, enabled = true, params, onSuccess, onError } = options;
  const [data, setData] = useState<T | null>(initialData ?? null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!initialData && enabled);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    if (!enabled) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setIsLoading(true);
    setError(null);

    try {
      const url = new URL(`/api/v1/admin${path}`, window.location.origin);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== "") url.searchParams.set(k, v);
        }
      }

      const res = await fetch(url.pathname + url.search, {
        credentials: "include",
        signal: abortRef.current.signal,
      });
      const json = await res.json();

      if (!res.ok || json.success === false) {
        const msg = json.error?.message || json.error || json.message || "Request failed";
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }

      const { success, ...result } = json;
      setData(result as T);
      onSuccess?.(result as T);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "An error occurred";
      setError(message);
      onError?.(message);
    } finally {
      setIsLoading(false);
    }
  }, [path, enabled, JSON.stringify(params)]);

  useEffect(() => {
    if (enabled && !initialData) fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  return { data, error, isLoading, refetch: fetchData };
}
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Verify runtime**

Add a temporary test in any admin page (e.g. `admin/index.astro`) that uses `apiGet`:
```typescript
const result = await apiGet<{ totalProducts: number }>("/products/stats");
console.log("apiGet test:", result);
```
Verify it fetches data correctly. Remove after confirming.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/lib/api-fetch.ts apps/admin/src/hooks/use-api.ts apps/admin/src/types/window.d.ts
git commit -m "feat: add shared API fetching (apiGet/apiPost/apiPut/apiDelete + useApi hook)"
```

---

### Task 6: Error Boundary Infrastructure

**Files:**
- Modify: `apps/admin/src/components/admin/ErrorBoundary.tsx`
- Create: `apps/admin/src/components/admin/shared/PageSection.tsx`

- [ ] **Step 1: Enhance ErrorBoundary.tsx**

The existing `ErrorBoundary.tsx` (79 lines) is functional but `handleReset` does `window.location.reload()`. Add an `onReset` callback prop so callers can choose the reset behavior:

```typescript
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onReset?: () => void;  // NEW: optional custom reset handler
}
```

In `handleReset`:
```typescript
handleReset = () => {
  this.setState({ hasError: false, error: null });
  if (this.props.onReset) {
    this.props.onReset();
  } else {
    window.location.reload();
  }
};
```

- [ ] **Step 2: Create `PageSection.tsx`**

A convenience wrapper that combines ErrorBoundary with consistent styling:

```typescript
import React from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PageSectionProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onReset?: () => void;
  className?: string;
}

function DefaultFallback({ error, onReset }: { error?: Error; onReset: () => void }) {
  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          <CardTitle className="text-lg text-destructive">Something went wrong</CardTitle>
        </div>
        <CardDescription>This section encountered an error. Other sections are unaffected.</CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-3 rounded bg-muted p-2 font-mono text-xs text-muted-foreground">
            {error.message}
          </p>
        )}
        <Button onClick={onReset} variant="outline" size="sm" className="gap-2">
          <RefreshCw className="h-3 w-3" /> Try Again
        </Button>
      </CardContent>
    </Card>
  );
}

export function PageSection({ children, fallback, onReset, className }: PageSectionProps) {
  return (
    <div className={className}>
      <ErrorBoundary fallback={fallback} onReset={onReset}>
        {children}
      </ErrorBoundary>
    </div>
  );
}
```

Note: The `DefaultFallback` won't work directly with the class-based ErrorBoundary since it needs error state. For now, `PageSection` uses ErrorBoundary's built-in fallback. A more sophisticated version can be added later when components are split in Phase 3.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Verify runtime**

Temporarily wrap one component (e.g., `DashboardStats` in `admin/index.astro`) with `<PageSection>`. Then temporarily add `throw new Error("test")` inside that component. Verify:
- The error boundary catches it and shows the error card
- The "Try Again" button resets the error state
- Other page sections are unaffected

Remove the test throw after confirming.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/admin/ErrorBoundary.tsx apps/admin/src/components/admin/shared/PageSection.tsx
git commit -m "feat: enhance ErrorBoundary with onReset, add PageSection wrapper"
```

---

### Task 7: Inline Script Extraction

**Files:**
- Create: `apps/admin/src/lib/client/product-actions.ts`
- Create: `apps/admin/src/lib/client/variant-scroll.ts`
- Create: `apps/admin/src/lib/client/shipment-actions.ts`
- Create: `apps/admin/src/lib/client/discount-form-loader.ts`
- Create: `apps/admin/src/lib/client/fraud-checker-actions.ts`
- Modify: `apps/admin/src/pages/admin/products/new.astro`
- Modify: `apps/admin/src/pages/admin/products/[id]/edit.astro`
- Modify: `apps/admin/src/pages/admin/orders/[id]/index.astro`
- Modify: `apps/admin/src/pages/admin/discounts/new.astro`
- Modify: `apps/admin/src/pages/admin/settings/fraud-checker/index.astro`

- [ ] **Step 1: Read all 5 pages with inline scripts**

Read each page completely. For each, identify:
- What the inline script does
- What window globals it sets
- What DOM elements it queries
- What API endpoints it calls

- [ ] **Step 2: Extract `product-actions.ts`**

Read `products/new.astro` fully. Extract the `handleSubmit` string + `eval()` + navigation helper into:

```typescript
// apps/admin/src/lib/client/product-actions.ts
import { toast } from "sonner";

export function initProductNewPage() {
  // The handleSubmit function that was previously eval'd
  async function handleSubmit(data: Record<string, unknown>) {
    // ... existing submit logic from the inline script
  }

  // Expose for the form component
  (window as Window & { handleSubmit?: typeof handleSubmit }).handleSubmit = handleSubmit;

  // Navigation helper
  (window as Window & { navigateToProductEdit?: (id: string) => void }).navigateToProductEdit = (id: string) => {
    window.location.href = `/admin/products/${id}/edit`;
  };
}
```

Then in `products/new.astro`, replace the inline script with:
```astro
<script>
  import { initProductNewPage } from "@/lib/client/product-actions";
  initProductNewPage();
</script>
```

**Critical:** This eliminates the `eval()` call entirely.

- [ ] **Step 3: Extract `variant-scroll.ts`**

Read `products/[id]/edit.astro` fully. Extract the variant scroll state management:

```typescript
// apps/admin/src/lib/client/variant-scroll.ts
export function initVariantScroll() {
  // ... existing scroll state logic
}
```

- [ ] **Step 4: Extract `shipment-actions.ts`**

Read `orders/[id]/index.astro` fully. Extract `window.shipmentActions`:

```typescript
// apps/admin/src/lib/client/shipment-actions.ts
export function initShipmentActions() {
  window.shipmentActions = {
    createShipment: async (orderId: string, providerId: string, options?: Record<string, unknown>) => {
      // ... existing createShipment logic
    },
    checkShipmentStatus: async (shipmentId: string) => {
      // ... existing checkStatus logic
    },
    deleteShipment: async (shipmentId: string) => {
      // ... existing delete logic
    },
  };
}
```

- [ ] **Step 5: Extract `discount-form-loader.ts`**

Read `discounts/new.astro` fully. This is the most complex extraction (220 lines with ReactDOM.createRoot). Extract:

```typescript
// apps/admin/src/lib/client/discount-form-loader.ts
export function initDiscountFormLoader() {
  // ... existing form loading logic with lazy component imports
}
```

- [ ] **Step 6: Extract `fraud-checker-actions.ts`**

Read `settings/fraud-checker/index.astro` fully. Extract `window.fraudCheckerActions`:

```typescript
// apps/admin/src/lib/client/fraud-checker-actions.ts
export function initFraudCheckerActions() {
  window.fraudCheckerActions = {
    saveProvider: async (provider: Record<string, unknown>) => { /* ... */ },
    deleteProvider: async (id: string) => { /* ... */ },
    testProvider: async (id: string) => { /* ... */ },
  };
}
```

- [ ] **Step 7: Update all 5 Astro pages**

Replace each page's inline script block with a small import + init call. Each page's inline script should be under 5 lines.

- [ ] **Step 8: Verify**

Run: `pnpm typecheck`
Expected: PASS

Manually verify each page:
- Create new product (no eval, form submits correctly)
- Edit product (variant scroll works)
- View order (shipment actions work)
- Create discount (form type selector loads correct form)
- Fraud checker settings (save/delete/test work)

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/lib/client/ apps/admin/src/pages/admin/
git commit -m "refactor: extract inline scripts from 5 Astro pages, eliminate eval()"
```

---

## Phase 1 Completion Verification

After all 7 tasks complete:

- [ ] **Full typecheck:** `pnpm typecheck` — must pass with zero errors
- [ ] **Full build:** `pnpm build` — must succeed
- [ ] **Smoke test:** Admin login, navigate all major pages, verify no regressions
- [ ] **Confirm middleware works:** Auth, RBAC, CSP headers, cache invalidation
- [ ] **Confirm layout works:** Header, sidebar, theme toggle, loading spinner
- [ ] **Confirm scripts work:** Product create, order view, discount create, fraud checker

Phase 1 is complete. Phase 2 (Migration) plan will be written separately.
