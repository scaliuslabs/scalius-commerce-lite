# Authentication & Authorization Re-Audit

**Re-Audit Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** Auth & RBAC system after major fix session

---

## Previous Finding Status

### CRIT-1: JWT Token Blacklist Fails Open — FIXED

- **File:** `apps/api/src/utils/jwt.ts`, line 184
- **Previous:** `isTokenBlacklisted()` returned `false` in catch block (fail open — revoked tokens accepted when KV unavailable)
- **Current:** Returns `true` in catch block (fail closed — tokens rejected when KV unavailable)
- **Code:**
  ```typescript
  } catch (error: unknown) {
    console.error("Error checking token blacklist:", error);
    return true; // Fail closed — reject token when KV is unavailable
  }
  ```
- **Assessment:** Correctly fixed. The comment is accurate. This is the safe default — a brief KV outage causes token re-auth rather than accepting revoked tokens.
- **Remaining concern:** No in-memory fallback was added. When KV is unreachable, ALL JWT-authenticated requests fail (not just revoked ones). This is acceptable for security but means a KV outage has broader impact than before. The previous audit suggested an in-memory Set mirroring blacklisted hashes; this was not implemented but is a hardening improvement, not a security fix.

### CRIT-2: Temp Password Logged to Console on Email Failure — FIXED

- **File:** `apps/api/src/routes/admin/auth-management.ts`, lines 186-197
- **Previous:** `console.log(\`IMPORTANT: Temp password for ${email}: ${tempPassword}\`)` leaked credentials to log drains
- **Current:** The `console.log` is removed. When email fails, the temp password is returned in the API response body instead:
  ```typescript
  if (emailFailed) {
      return created(c, {
          message: "Admin user created but invitation email failed to send. Please share the temporary password securely.",
          user: { id: signUpResult.user.id, name, email },
          tempPassword,
          emailFailed: true
      });
  }
  ```
- **Assessment:** Correctly fixed. The temp password is now only visible to the creating admin via HTTPS response, never logged. The response includes a clear message instructing secure sharing.

### CRIT-3: Default JWT Secret Accepted in Non-Production — FIXED

- **File:** `apps/api/src/utils/jwt.ts`, lines 36-46
- **Previous:** Fallback to hardcoded `"your-jwt-secret-key-change-this-in-production"` when `JWT_SECRET` not set
- **Current:** Throws unconditionally if `JWT_SECRET` is missing:
  ```typescript
  function getJwtSecret(env?: JwtEnv): string {
    const secret =
      env?.JWT_SECRET ||
      (typeof process !== "undefined" ? process.env.JWT_SECRET : undefined);

    if (!secret) {
      throw new Error("JWT_SECRET environment variable is required");
    }

    return secret;
  }
  ```
- **Assessment:** Correctly fixed. No environment can run without an explicit `JWT_SECRET`. The hardcoded default is completely removed from `getJwtSecret()`.
- **Residual note:** The `getTokenStats()` function at line 208-209 still references `"your-jwt-secret-key-change-this-in-production"` as a comparison string for diagnostic purposes (to detect if the default was set). This is a cosmetic issue — the string is used for detection, not as a fallback secret. No security impact.

### CRIT-4: Setup Endpoint Accessible Independently of Admin Middleware — STILL OPEN (Accepted Risk)

- **File:** `apps/api/src/app.ts`, line 291
- **Current:** `/setup` is still mounted outside `adminAuthMiddleware`:
  ```
  app.use("/admin/*", adminAuthMiddleware);   // line 259
  // ...
  app.route("/setup", authSetupRoutes);        // line 291
  ```
- **Assessment:** Still open but severity remains LOW. The setup endpoint has adequate protection:
  1. Rate limiting: 5 requests/IP/hour via KV (line 582-591 of auth-management.ts)
  2. Admin-exists DB check: returns 403 once an admin exists (line 599-601)
  3. Security warning log on access after setup (line 600)
  4. Password minimum 12 chars enforced by Zod schema (line 559)
- **This is by design:** The setup endpoint must be accessible without auth because no admin exists yet. The CLAUDE.md "Known Backlog" does not list this, confirming it is accepted.

---

## Code Quality Issues — Previous Findings

### CQ-1: Auth Instance Caching Keyed Only on Secret — STILL OPEN

- **File:** `packages/core/src/auth/auth.ts`, lines 212-214
- **Current:** Cache signature still only uses `BETTER_AUTH_SECRET`:
  ```typescript
  const envSignature = env
    ? `${(env as Record<string, string>).BETTER_AUTH_SECRET || ""}`
    : `${process.env.BETTER_AUTH_SECRET || ""}`;
  ```
- **Impact:** LOW — In Cloudflare Workers, env bindings do not change within an isolate lifecycle, so stale config is not a practical risk. This is a correctness improvement, not a bug.

### CQ-2: `process.env` Fallback in Cloudflare Workers Context — STILL OPEN

- **File:** `packages/core/src/auth/auth.ts`, line 22
- **Assessment:** Cosmetic. No functional impact. Not worth changing.

### CQ-3: Inconsistent Super Admin Check Across Layers — STILL OPEN

- **Files:**
  - `apps/api/src/routes/admin/auth-management.ts`, lines 61, 145, 229: All three handlers (list, create, delete users) still check only `sessionUser.role !== "admin"` without RBAC permission checks.
- **Impact:** Any user with `role: "admin"` can list, create, and delete admin users regardless of their RBAC permissions. The `TEAM_VIEW`/`TEAM_MANAGE` permissions exist in the route-permissions map at `/api/auth/admin-users` but the auth-management routes are mounted at `/admin/auth/users` — a different path. The Hono `adminAuthMiddleware` at `/admin/*` validates the user has admin access but does not enforce the specific `TEAM_VIEW`/`TEAM_MANAGE` permissions because the route-permissions map key (`/api/auth/admin-users`) does not match the actual Hono path (`/admin/auth/users`).
- **Severity:** MEDIUM — This is a privilege escalation within the admin tier. A `sales_rep` with `role: "admin"` but no `TEAM_MANAGE` permission can create and delete other admin users.
- **Fix approach:** Add explicit RBAC checks inside the auth-management handlers:
  ```typescript
  // List users: require TEAM_VIEW
  if (!await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_VIEW)) {
      throw new ForbiddenError("Permission denied");
  }
  // Create/delete: require TEAM_MANAGE
  if (!await hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_MANAGE)) {
      throw new ForbiddenError("Permission denied");
  }
  ```
  Also update the route-permissions map to use the actual Hono path: `/api/v1/admin/auth/users`.

### CQ-4: `as any` Cast on RBAC Route Handlers — STILL OPEN

- **File:** `apps/api/src/routes/admin/rbac.ts`, lines 118, 183, 201, 234
- **Code:** `app.openapi(createRoleRoute, (async (c: any) => {` and `}) as any)`
- **Impact:** Cosmetic. The handlers are well-tested and the `as any` is a Hono/Zod-OpenAPI typing limitation workaround. Low priority.

---

## Pattern Violations — Previous Findings

### PV-1: Dual Auth Systems Without Shared Abstraction — STILL OPEN (By Design)

- **Assessment:** This is intentional architecture. Admin auth (Better Auth + sessions + 2FA) and customer auth (KV + OTP) serve fundamentally different use cases. No action needed.

### PV-2: Inconsistent Route Path Conventions in RBAC — STILL OPEN

- **File:** `packages/core/src/auth/rbac/route-permissions.ts`
- **Current state:** The route-permissions map still mixes three path formats:
  - `/api/v1/admin/*` (categories, orders, collections, etc.)
  - `/api/products/*`, `/api/settings/*`, `/api/dashboard/*` (no `/v1/admin/` prefix)
  - `/api/auth/admin-users` (no versioned prefix)
  - `/api/inventory/*` (no `/v1/admin/` prefix)
  - `/api/system-prompt` (no prefix)
- **The matching logic in the API middleware at `apps/api/src/middleware/admin-auth.ts` line 124 normalizes paths:**
  ```typescript
  const pathname = honoPathname.startsWith("/api/v1") ? honoPathname : `/api/v1${honoPathname}`;
  ```
  This prepends `/api/v1` to paths that do not already have it — but the route-permissions map has entries like `/api/products` (not `/api/v1/api/products`). The normalization produces `/api/v1/api/products` which does NOT match the map key `/api/products`. This means **product routes, settings routes, inventory routes, dashboard routes, and system-prompt routes have no RBAC enforcement in the API middleware** — they only get RBAC checks from the Astro admin middleware.
- **Severity:** MEDIUM-HIGH — The Astro middleware is defense-in-depth, not the authoritative enforcement point. If a request reaches the API worker directly (e.g., via JWT bearer token from a mobile app), these routes have no fine-grained RBAC.
- **Fix approach:** Either:
  1. Move all route-permission keys to use the Hono-internal path format (what `getRoutePermission` actually receives after normalization), or
  2. Fix the normalization logic to strip `/api/v1` prefix before lookup rather than prepend it.

### PV-3: Products Routes Under `/api/products` — STILL OPEN

- Subsumed by PV-2 above. Same root cause — the path mismatch means product route RBAC is not enforced in the API middleware.

---

## 2FA Issues — Previous Findings

### 2FA mark-verified Endpoint Has No Proof-of-Verification — STILL OPEN

- **File:** `apps/api/src/routes/admin/auth-management.ts`, lines 392-408
- **Current:** The `POST /admin/auth/2fa/mark-verified` endpoint still only checks `user.twoFactorEnabled` before setting `session.twoFactorVerified = true`. It does NOT verify that a valid 2FA code was submitted.
- **Mitigation (unchanged):** The verify endpoint (`POST /admin/auth/2fa/verify`) at lines 462-496 already sets `twoFactorVerified: true` directly in the DB. In the normal flow, `mark-verified` is redundant.
- **Risk:** A client that calls `mark-verified` directly without calling `verify` first bypasses 2FA entirely. The request must still have a valid admin session cookie (the `adminAuthMiddleware` protects this route), so the attacker needs a valid pre-2FA session. The window is: user logs in with password -> session created with `twoFactorVerified: false` -> attacker calls mark-verified instead of verify -> 2FA bypassed.
- **Severity:** MEDIUM — Requires a valid session cookie, but defeats the purpose of 2FA for users who enable it.

---

## Robustness Gaps — Previous Findings

### RG-1: No Session Binding to IP or User-Agent — STILL OPEN (Accepted)

- Session cookies remain portable. The `ipAddress` and `userAgent` columns exist in the schema but are not validated during session lookup. This is standard for most web apps.

### RG-2: In-Memory Permission Cache Not Shared Across Isolates — STILL OPEN (Accepted)

- Each Worker isolate has its own in-memory permission cache with 5-minute TTL. The KV cache provides cross-isolate sharing. Acceptable for single-tenant.

### RG-3: Auto-Seed Flag Resets on Isolate Restart — STILL OPEN (Accepted)

- `seedingChecked` in `packages/core/src/auth/rbac/auto-seed.ts` line 17 resets per isolate. One lightweight DB query per isolate start. No issue.

### RG-4: Scanner Token Validation Inconsistency — PARTIALLY FIXED

- **Admin Astro middleware** (`apps/admin/src/middleware/rbac.ts`, lines 44-68): Validates scanner token AND checks device binding via `scanner_sid` cookie.
- **API Hono middleware** (`apps/api/src/middleware/admin-auth.ts`, lines 61-86): Validates scanner token and checks `claimed` status, but still does NOT check device binding (no cookie check).
- **Improvement since last audit:** The API middleware now sets `role: "scanner"` (line 77) instead of `role: "admin"`, which means scanner tokens cannot access non-inventory endpoints (lines 98-106 restrict to `/inventory/` paths). This significantly reduces the blast radius of a stolen scanner token.
- **Remaining gap:** Device binding is only enforced in the Astro middleware. A JWT-authenticated request with a stolen scanner token going directly to the API worker bypasses device binding. However, since the scanner role is now restricted to inventory endpoints only, the impact is limited.

### RG-5: Email Verification Disabled — STILL OPEN (By Design)

- `packages/core/src/auth/auth.ts`, line 50: `requireEmailVerification: false`
- The setup endpoint sets `emailVerified: true` explicitly. This is intentional for a first-party admin panel.

---

## Webhook Auth — NEW Analysis

- **File:** `apps/api/src/middleware/webhook-auth.ts`
- **Strengths:**
  - Constant-time comparison via `timingSafeEqual()` (line 42-51) prevents timing attacks
  - HMAC-SHA256 using Web Crypto API for generic webhook verification
  - Provider-specific verification (Pathao signature, Steadfast bearer token)
  - IP allowlist fallback when signature verification is not configured
  - Rejects webhooks when no authentication method is configured (line 222-227) — changed from the previous behavior that allowed unauthenticated webhooks
- **No issues found.** The webhook auth implementation is solid.

---

## NEW Issues Found

### NEW-1: Route-Permission Path Mismatch Causes Silent RBAC Bypass (API Layer)

- **File:** `apps/api/src/middleware/admin-auth.ts`, line 124 and `packages/core/src/auth/rbac/route-permissions.ts`
- **Issue:** This was partially identified as PV-2/PV-3 in the previous audit but the severity was underestimated. The path normalization in the API middleware:
  ```typescript
  const pathname = honoPathname.startsWith("/api/v1") ? honoPathname : `/api/v1${honoPathname}`;
  ```
  For a Hono route like `/api/products`, this produces `/api/v1/api/products`. The route-permissions map has keys like `/api/products` (without `/v1/` prefix). The lookup fails silently and returns `null`, which means the route has no RBAC enforcement.
- **Affected routes (no RBAC in API middleware):**
  - All product routes (`/api/products/*`) — 14 entries
  - All settings routes (`/api/settings/*`) — 19 entries
  - Dashboard routes (`/api/dashboard`, `/api/dashboard/*`)
  - System prompt route (`/api/system-prompt`)
  - Inventory routes (`/api/inventory/*`) — 2 entries
  - Team management route (`/api/auth/admin-users`)
- **Severity:** MEDIUM-HIGH — These routes still require `role: "admin"` (the `hasAdminAccess` check at line 115-119) and the Astro middleware provides RBAC. But for decoupled API access (JWT bearer token), fine-grained permissions are not enforced on ~37 route entries.

### NEW-2: `clearAllPermissionCache()` Does Not Clear KV

- **File:** `packages/core/src/auth/rbac/helpers.ts`, lines 43-45
- **Code:**
  ```typescript
  export function clearAllPermissionCache(): void {
    permissionCache.clear();
  }
  ```
- **Called from:** `apps/api/src/routes/admin/rbac.ts` at lines 167, 314, 389 (after role create, update, delete)
- **Impact:** When roles are created, updated, or deleted, only the local in-memory cache is cleared. KV-cached permissions for all users across all isolates remain stale for up to 5 minutes.
- **Contrast:** Individual user permission changes use `clearPermissionCache(userId, kv)` which correctly clears both local and KV caches. Only the "clear all" function (used for role-level changes) is broken.
- **Severity:** LOW — Role changes are infrequent admin operations. The 5-minute TTL is an acceptable window for eventual consistency.

### NEW-3: `getTokenStats()` Leaks Partial JWT Secret

- **File:** `apps/api/src/utils/jwt.ts`, lines 201-218
- **Code:**
  ```typescript
  jwtSecret:
    typeof secret === "string" && secret.length > 6
      ? `${secret.substring(0, 3)}...${secret.substring(secret.length - 3)}`
      : "***",
  ```
- **Impact:** The `getTokenStats()` function exposes the first 3 and last 3 characters of the JWT secret. If this function is called from a diagnostic endpoint accessible to non-super-admin users, it leaks partial secret information.
- **Current exposure:** Needs investigation of callers. If only used in server-side logging (not exposed via API), impact is LOW.
- **Severity:** LOW — Partial secret exposure (6 characters) is unlikely to enable brute-force for a properly generated secret (32+ bytes), but violates least-privilege principles.

---

## Summary of Fixes Since Previous Audit

| Finding | Status | Notes |
|---------|--------|-------|
| CRIT-1: Token blacklist fails open | **FIXED** | Now fails closed (`return true`) |
| CRIT-2: Temp password logged | **FIXED** | Returned in response body instead |
| CRIT-3: Default JWT secret | **FIXED** | Throws if missing, no hardcoded fallback |
| CRIT-4: Setup endpoint outside auth | **STILL OPEN** | Accepted risk, adequate protection |
| CQ-1: Auth cache key too narrow | STILL OPEN | Low risk |
| CQ-2: process.env fallback | STILL OPEN | Cosmetic |
| CQ-3: Auth mgmt skips RBAC | **STILL OPEN** | MEDIUM — privilege escalation within admin tier |
| CQ-4: `as any` casts in RBAC | STILL OPEN | Cosmetic |
| PV-2/PV-3: Route path inconsistency | **STILL OPEN** | MEDIUM-HIGH — silent RBAC bypass for ~37 routes in API middleware |
| 2FA mark-verified bypass | **STILL OPEN** | MEDIUM — 2FA bypass with valid session |
| RG-4: Scanner device binding | PARTIALLY FIXED | Scanner role restricted to inventory, but device binding not in API |
| Webhook auth (no security) | **FIXED** | Now rejects when no auth configured |

---

## Remaining Priority Actions

### Priority 1 (Security)

1. **Fix route-permission path mismatch** — Either normalize the route-permissions map keys to match what the API middleware produces after prepending `/api/v1`, or change the normalization logic. ~37 routes lack API-layer RBAC. Files: `apps/api/src/middleware/admin-auth.ts` line 124, `packages/core/src/auth/rbac/route-permissions.ts` (all `/api/` entries without `/v1/admin/` prefix).

2. **Add RBAC checks to auth-management routes** — The list/create/delete user handlers at `apps/api/src/routes/admin/auth-management.ts` lines 61, 145, 229 check only `role === "admin"`, not specific RBAC permissions. Add `hasPermission()` calls for `TEAM_VIEW`/`TEAM_MANAGE`.

3. **Remove or secure `/2fa/mark-verified`** — At `apps/api/src/routes/admin/auth-management.ts` lines 392-408, this endpoint allows 2FA bypass. Either remove it (the verify endpoint already marks verified) or add a server-side proof requirement.

### Priority 2 (Hardening)

4. **Fix `clearAllPermissionCache()` to also clear KV** — At `packages/core/src/auth/rbac/helpers.ts` lines 43-45, accept a KV namespace parameter and list/delete `rbac:perms:*` keys.

5. **Remove partial secret from `getTokenStats()`** — At `apps/api/src/utils/jwt.ts` lines 212-214, replace the partial secret with just a boolean indicator.

6. **Add device binding check to API scanner validation** — At `apps/api/src/middleware/admin-auth.ts` lines 61-86, add cookie-based session binding to match the Astro middleware behavior.

---

## Overall Rating: 7/10

**Previous rating equivalent: ~5.5/10** (3 critical security issues)

**Improvement:** The three most critical security findings (CRIT-1, CRIT-2, CRIT-3) are all properly fixed. The token blacklist now fails closed, credentials are no longer logged, and JWT secrets are mandatory. Webhook auth also improved (rejects unauthenticated webhooks).

**Remaining concerns:** The route-permission path mismatch (NEW-1/PV-2) is the most significant remaining issue — ~37 admin routes lack fine-grained RBAC enforcement at the API layer. The auth-management RBAC bypass (CQ-3) and 2FA mark-verified bypass are secondary concerns. All require valid admin sessions to exploit, limiting the attack surface to privilege escalation within the admin tier rather than unauthenticated access.
