# Authentication & Authorization Audit

**Analysis Date:** 2026-03-20

## Summary

The authentication and authorization system spans three workers (admin, API, storefront) with two distinct auth systems:

1. **Admin auth**: Better Auth (email/password + optional 2FA) with session cookies, managed in `packages/core/src/auth/auth.ts`. Admin users are stored in the `user` table (`packages/database/src/schema/auth.ts`).
2. **Customer auth**: Custom OTP-based auth using Cloudflare KV for session storage, managed in `packages/core/src/modules/customers/customer-auth.service.ts`. Customer sessions are KV-stored (not DB sessions).

RBAC is fully implemented with 82 permissions across 14 categories, 5 system roles, per-user overrides (grant/deny), and enforcement at both the Astro middleware layer (admin) and the Hono middleware layer (API).

**Overall assessment**: The auth system is well-structured with defense-in-depth (RBAC enforced in both admin middleware and API middleware). The most significant security concern is the **token blacklist failing open** when KV is unavailable, which is a known backlog item.

---

## Critical Issues (Security)

### CRIT-1: JWT Token Blacklist Fails Open

- **File:** `apps/api/src/utils/jwt.ts`, line 190-192
- **Code:**
  ```typescript
  } catch (error: unknown) {
    console.error("Error checking token blacklist:", error);
    return false; // Fail open to avoid blocking valid requests
  }
  ```
- **Impact:** When Cloudflare KV is unavailable (outage, timeout, misconfiguration), revoked JWT tokens are **accepted as valid**. A compromised token remains usable until expiry even after explicit revocation.
- **Severity:** HIGH -- KV outages are rare but not impossible, and this is the only mechanism for revoking JWT tokens before expiry.
- **Fix approach:** Change to fail-closed (`return true`) and add a short-circuit cache: store blacklisted token hashes in an in-memory `Set<string>` as a local fallback. When KV write succeeds, mirror to local memory. When KV read fails, check local memory. This provides degraded-but-safe behavior.

### CRIT-2: Temp Password Logged to Console on Email Failure

- **File:** `apps/api/src/routes/admin/auth-management.ts`, line 186
- **Code:**
  ```typescript
  console.log(`IMPORTANT: Temp password for ${email}: ${tempPassword}`);
  ```
- **Impact:** When the invitation email fails to send, the temporary admin password is logged to stdout. In Cloudflare Workers, `console.log` output appears in the Workers dashboard logs and any connected log drain (Logpush, third-party services). This leaks a valid admin credential in plain text.
- **Severity:** HIGH -- Log drains are often accessible to broader teams than the admin console. The password is valid until the user changes it.
- **Fix approach:** Remove the `console.log` entirely. Instead, return the temp password in the API response body (over HTTPS, visible only to the requesting admin) with a clear message that the email failed. The creating admin can then communicate the password directly.

### CRIT-3: Default JWT Secret Accepted in Non-Production

- **File:** `apps/api/src/utils/jwt.ts`, lines 40-41
- **Code:**
  ```typescript
  const secret = env?.JWT_SECRET || ... || "your-jwt-secret-key-change-this-in-production";
  ```
- **Impact:** In development or staging, if `JWT_SECRET` is not set, a hardcoded default is used. The production guard only triggers when `process.env.NODE_ENV === "production"`. Staging environments that do not set `NODE_ENV=production` will silently use the default secret, making all JWTs predictable.
- **Severity:** MEDIUM -- staging/preview environments may contain production-like data.
- **Fix approach:** Log a loud warning in non-production environments when the default secret is used. Better: require JWT_SECRET to always be set and throw unconditionally if missing (matching how `BETTER_AUTH_SECRET` works in `packages/core/src/auth/auth.ts` line 30-32).

### CRIT-4: Setup Endpoint Accessible Independently of Admin Middleware

- **File:** `apps/api/src/app.ts`, line 335
- **Code:**
  ```typescript
  app.route("/setup", authSetupRoutes);
  ```
- **Impact:** The `/api/v1/setup` route is mounted outside the `adminAuthMiddleware` block. While it has its own guard (checks if admin already exists), this means the setup endpoint is always reachable over the network. The rate limit (5 attempts/IP/hour via KV) is the only protection against brute-force if the admin-exists check somehow fails.
- **Severity:** LOW -- The double-check (DB query for existing admins + rate limiting) provides adequate protection. The setup endpoint correctly returns 403 once an admin exists, and the rate limiter prevents abuse.
- **Current mitigation:** Rate limiting (5/IP/hour), admin-exists DB check, security warning log.

---

## Code Quality Issues

### CQ-1: Auth Instance Caching Keyed Only on Secret

- **File:** `packages/core/src/auth/auth.ts`, lines 210-227
- **Code:**
  ```typescript
  const envSignature = env
    ? `${(env as Record<string, string>).BETTER_AUTH_SECRET || ""}`
    : `${process.env.BETTER_AUTH_SECRET || ""}`;
  ```
- **Impact:** The `getAuth()` cache signature only includes `BETTER_AUTH_SECRET`. If `BETTER_AUTH_URL`, `STOREFRONT_URL`, or database bindings change while the secret stays the same (e.g., switching between preview and production in the same Worker), the cached auth instance will use stale configuration.
- **Fix approach:** Include `BETTER_AUTH_URL` and `STOREFRONT_URL` in the signature. In Cloudflare Workers, env bindings do not typically change within an isolate lifecycle, so this is low-risk in practice.

### CQ-2: `process.env` Fallback in Cloudflare Workers Context

- **File:** `packages/core/src/auth/auth.ts`, line 22
- **Code:**
  ```typescript
  return process.env[key];
  ```
- **Impact:** `process.env` is undefined in Cloudflare Workers. The `getEnvVar` function tries it as a fallback. While this does not crash (the optional chaining before `process` would throw if not guarded, but the try/catch in callers handles it), it is misleading. The actual env binding always comes from the `env` parameter in production.
- **Severity:** Cosmetic -- no functional impact due to the check `if (env && key in env)` running first.

### CQ-3: Inconsistent Super Admin Check Across Layers

- **Files:**
  - `apps/admin/src/middleware/rbac.ts`, line 87-88: Checks `isSuperAdmin` via helper + checks `user.role === "admin"` + checks `permissions.size > 0`
  - `apps/api/src/middleware/admin-auth.ts`, line 115: Checks `user.role === "admin"` + checks `userPerms.size > 0`
  - `apps/api/src/routes/admin/auth-management.ts`, line 61: Only checks `sessionUser.role !== "admin"`
- **Impact:** The auth-management routes (`/admin/auth/users` list, create, delete) check only `role === "admin"` and do NOT check RBAC permissions. A user with `role: "admin"` but no `TEAM_MANAGE` permission can still list/create/delete admin users. The RBAC routes (`/admin/rbac/*`) correctly check specific permissions.
- **Fix approach:** Replace the `sessionUser.role !== "admin"` checks in `auth-management.ts` with proper RBAC permission checks (`TEAM_VIEW` for listing, `TEAM_MANAGE` for create/delete). Super admin bypass is already handled by `getUserPermissions()` returning all permissions.

### CQ-4: `as any` Cast on `createRoleRoute` Handler

- **File:** `apps/api/src/routes/admin/rbac.ts`, lines 118, 183
- **Code:**
  ```typescript
  app.openapi(createRoleRoute, (async (c: any) => {
  ```
- **Impact:** The `as any` cast disables type checking on the Hono context, hiding potential type mismatches in the route handler. This pattern appears on `createRoleRoute` and `getRoleRoute`.
- **Fix approach:** Use the proper typed handler signature or extract the validated input with explicit types.

---

## Pattern Violations

### PV-1: Dual Auth Systems Without Shared Abstraction

- **Admin auth:** Better Auth sessions stored in D1 (`session` table), cookies managed by Better Auth library.
- **Customer auth:** Custom KV-based sessions (`cust_session:` prefix), custom cookie (`cs_tok`), custom OTP flow.
- **Impact:** Two separate session management systems, two different cookie patterns, two rate limiting approaches. Changes to auth patterns must be applied twice.
- **Note:** This may be intentional -- admin auth needs full-featured session management (2FA, impersonation, role management) while customer auth is deliberately lightweight (OTP-only, KV sessions, no password).

### PV-2: Inconsistent Route Path Conventions in RBAC

- **File:** `packages/core/src/auth/rbac/route-permissions.ts`
- **Issue:** Routes use mixed path conventions:
  - Some use `/api/v1/admin/` prefix: `/api/v1/admin/categories`, `/api/v1/admin/orders`
  - Some use `/api/` prefix: `/api/products`, `/api/settings/stripe`, `/api/dashboard`
  - Some use no versioned prefix: `/api/auth/admin-users`
- **Impact:** The `getRoutePermission()` function must handle both patterns. The admin-auth middleware normalizes paths (line 124: `const pathname = honoPathname.startsWith("/api/v1") ? honoPathname : \`/api/v1${honoPathname}\``), but the route-permissions map contains both formats. A new route using the wrong format would silently have no RBAC enforcement.
- **Fix approach:** Standardize all route-permission keys to use the `/api/v1/admin/` prefix. Update the matching logic to strip `/api/v1` from the Hono path before lookup, not prepend it.

### PV-3: Products Routes Under `/api/products` Not Under `/api/v1/admin/products`

- **File:** `packages/core/src/auth/rbac/route-permissions.ts`, lines 31-74
- **Issue:** Product route permissions are mapped to `/api/products/*` (no `/v1/admin/` prefix), while all other admin routes use `/api/v1/admin/*`. This mismatch exists because the products admin routes were initially at `/api/products` and later the convention shifted to `/api/v1/admin/`.
- **Impact:** The route-permission lookup works because both the admin middleware and the route-permissions map use the same `/api/products` format, but it is inconsistent with all other domains.

---

## RBAC Analysis

### Architecture

The RBAC system is well-designed with a clear separation:

1. **Permission definitions:** `packages/core/src/auth/rbac/permissions.ts` -- 82 permissions in 14 categories, each with metadata (displayName, description, resource, action, category, isSensitive).
2. **Schema:** `packages/database/src/schema/rbac.ts` -- 5 tables (permissions, roles, rolePermissions, userRoles, userPermissions) with proper FK cascades and unique constraints.
3. **Resolution logic:** `packages/core/src/auth/rbac/helpers.ts` -- Batched D1 queries with 2-tier cache (in-memory + KV, 5-minute TTL).
4. **Route enforcement:** `packages/core/src/auth/rbac/route-permissions.ts` -- Comprehensive mapping of API routes to permissions.
5. **Page enforcement:** `packages/core/src/auth/rbac/page-permissions.ts` -- Admin page routes to permissions.
6. **Auto-seeding:** `packages/core/src/auth/rbac/auto-seed.ts` -- Seeds 82 permissions + 5 system roles on first access.
7. **UI:** `PermissionGate.tsx`, `PermissionContext.tsx`, `RolesManagement.tsx`, `UserPermissionEditor.tsx`.

### Permission Resolution Order

1. Super admin --> ALL permissions
2. Collect role-based permissions (union of all assigned roles)
3. Apply user-level overrides: grants add, denials remove
4. Cache result in memory + KV (5-minute TTL)

### System Roles

| Role | Description | Permission Count |
|------|-------------|-----------------|
| `super_admin` | All permissions | 82 |
| `manager` | All except permanent_delete, sensitive delivery/fraud, role management | ~70 |
| `sales_rep` | Orders, customers, product viewing | 15 |
| `content_editor` | Pages, widgets, media, collections, content settings | 19 |
| `product_specialist` | Products, categories, collections, attributes, media | 22 |

### RBAC Enforcement Points

1. **Admin Astro middleware** (`apps/admin/src/middleware/rbac.ts`): Enforces both API route permissions and page-level permissions. Runs for every admin request.
2. **API Hono middleware** (`apps/api/src/middleware/admin-auth.ts`): Enforces route permissions for all `/admin/*` API requests. This is the true enforcement point since the API worker is the authority.
3. **UI** (`PermissionGate.tsx`): Client-side gating of UI elements. This is cosmetic -- the API middleware is the actual enforcement.

### RBAC Gaps

- **Auth management routes skip RBAC:** The routes at `apps/api/src/routes/admin/auth-management.ts` (list/create/delete admin users) check only `role === "admin"`, not RBAC permissions. Any user with `role: "admin"` can manage all users regardless of their RBAC permissions. The `TEAM_VIEW`/`TEAM_MANAGE` permissions exist but are only enforced in route-permissions for `/api/auth/admin-users`, which is a different path than `/api/v1/admin/auth/users`.
- **Cache invalidation is local-only for `clearAllPermissionCache()`:** The `clearAllPermissionCache()` function at `packages/core/src/auth/rbac/helpers.ts` line 43-45 only clears the in-memory cache. It does not clear KV-cached permissions. When roles are updated, other Worker isolates continue using stale KV-cached permissions for up to 5 minutes.
- **Auto-seed is N+1:** The `seedPermissions()` function in `auto-seed.ts` inserts each permission individually (82 separate INSERT statements). The `seedRoles()` function has similar N+1 behavior for role-permission assignments. This only runs once per deployment, so the impact is minimal.

---

## Customer Auth Analysis

### Architecture

Customer auth uses a completely separate, KV-based system:

- **OTP generation:** `packages/core/src/modules/customers/customer-auth.service.ts` -- `generateOtpCode()` uses `crypto.getRandomValues()` (cryptographically secure).
- **OTP storage:** Stored in KV with key `cust_otp:{identifier}`, 5-minute TTL, max 5 attempts.
- **Session storage:** KV with key `cust_session:{token}`, 30-day TTL, token is `nanoid(48)`.
- **Transport:** Pluggable via `packages/core/src/modules/customers/otp-transport.ts` (email, SMS, WhatsApp).
- **Cookie:** `cs_tok`, HttpOnly, Secure, configurable SameSite (None in prod, Lax in dev).

### Strengths

- OTP codes are 6-digit, cryptographically generated, not logged.
- Rate limiting: 5 OTP requests per IP per 10 minutes, 2-minute cooldown between sends per identifier.
- OTP attempts limited to 5 per code, with automatic deletion on expiry or max attempts.
- Phone numbers normalized to E.164 before storage/lookup.
- Account takeover prevention: phone number uniqueness check during registration.

### Concerns

- **Session tokens not rotated:** Once created, a customer session token is valid for 30 days without rotation. If stolen, the attacker has a 30-day window.
- **No session invalidation on profile changes:** `updateCustomerProfile()` updates the session data but does not invalidate other sessions for the same customer. A customer cannot "log out everywhere."
- **KV dependency:** If KV is unavailable, both OTP verification and session validation fail completely (no fallback). This is different from the JWT blacklist fail-open pattern -- customer auth correctly fails closed.

---

## 2FA Analysis

### Architecture

2FA uses Better Auth's `twoFactor` plugin with two methods:

1. **TOTP:** Standard authenticator app (6-digit, 30-second period).
2. **Email OTP:** 6-digit code sent via email (5-minute expiry).

The `twoFactorMethod` column on the `user` table tracks the preferred method. The `twoFactorVerified` flag on the `session` table tracks whether the current session has completed 2FA.

### Flow

1. User logs in with email/password --> session created with `twoFactorVerified: false`
2. Admin middleware (`apps/admin/src/middleware/admin-detection.ts`) checks `user.twoFactorEnabled && !session.twoFactorVerified` --> redirects to `/auth/two-factor`
3. User enters TOTP code or email OTP --> verified via Better Auth API
4. Custom endpoint `POST /api/v1/admin/auth/2fa/mark-verified` sets `session.twoFactorVerified = true`
5. Subsequent requests pass the 2FA check in middleware.

### 2FA Concerns

- **mark-verified endpoint has no proof-of-verification:** The `POST /api/v1/admin/auth/2fa/mark-verified` endpoint at `apps/api/src/routes/admin/auth-management.ts` line 382-398 only checks that `user.twoFactorEnabled` is true before setting `session.twoFactorVerified = true`. It does NOT verify that Better Auth actually confirmed a valid code. The 2FA verification happens in a separate `POST /api/v1/admin/auth/2fa/verify` call, and then the client calls mark-verified separately. If a client calls mark-verified directly without calling verify first, the session is marked as 2FA-verified without actual verification.
  - **Mitigation:** The verify endpoint (`/2fa/verify`) also sets `twoFactorVerified: true` directly in the DB (lines 468-477), so in the normal flow the mark-verified call is redundant. However, the mark-verified endpoint still exists and can be called independently.
  - **Fix approach:** Remove the `/2fa/mark-verified` endpoint entirely, or add a server-side flag (e.g., a short-lived KV entry) that records successful verification, and check it in mark-verified.

- **2FA is optional (by design):** CLAUDE.md states "2FA is always optional, but must work flawlessly when enabled." The UI shows "2FA Required" language but does not enforce it -- users can dismiss the setup prompt and continue using the admin dashboard without 2FA.

- **Method change to email bypasses password confirmation:** In `TwoFactorSetup.tsx`, changing from TOTP to email method calls `handleChangeToEmail()` which directly calls the `/2fa/method` API without requiring password re-entry. Only changes from email to TOTP require a password.

---

## Robustness Gaps

### RG-1: No Session Binding to IP or User-Agent

- **Files:** `packages/database/src/schema/auth.ts` (stores `ipAddress`, `userAgent` on session), `packages/core/src/auth/auth.ts` (no validation)
- **Impact:** Session cookies are portable -- stealing a session cookie from one device works on another device with a different IP/UA. The `ipAddress` and `userAgent` columns exist in the schema but are never checked during session validation.
- **Note:** Strict IP binding breaks for users behind load balancers or VPNs. UA binding is more reasonable but can cause false positives.

### RG-2: In-Memory Permission Cache Not Shared Across Isolates

- **File:** `packages/core/src/auth/rbac/helpers.ts`, lines 16-19
- **Impact:** Each Worker isolate has its own in-memory permission cache. After a role change, the KV cache is cleared for the affected user, but all currently-running isolates continue serving stale in-memory permissions until the 5-minute TTL expires. This is acceptable for single-tenant but could cause permission drift under high traffic.

### RG-3: Auto-Seed Flag Resets on Isolate Restart

- **File:** `packages/core/src/auth/rbac/auto-seed.ts`, line 17
- **Code:**
  ```typescript
  let seedingChecked = false;
  ```
- **Impact:** Every new Worker isolate re-checks whether RBAC needs seeding (one DB query). This is a minor performance cost, not a correctness issue, since the seeding logic is idempotent (UNIQUE constraints prevent duplicates).

### RG-4: Scanner Token Validation Inconsistency

- **Files:** `apps/admin/src/middleware/rbac.ts` (lines 44-69) vs `apps/api/src/middleware/admin-auth.ts` (lines 61-86)
- **Impact:** Scanner token validation happens in TWO places:
  1. Admin Astro middleware: validates token, checks device binding via cookie.
  2. API Hono middleware: validates token, checks `claimed` status, but does NOT check device binding.
  This means a scanner request going directly to the API worker (bypassing the admin middleware) is not device-bound.
- **Fix approach:** Move all scanner token validation into the API Hono middleware, which is the authoritative enforcement point.

### RG-5: Email Verification Disabled

- **File:** `packages/core/src/auth/auth.ts`, line 49
- **Code:**
  ```typescript
  requireEmailVerification: false,
  ```
- **Impact:** Admin users can sign up without verifying their email address. The setup endpoint explicitly sets `emailVerified: true` after creation (line 601). This is intentional for a first-party admin panel but worth noting.

---

## LLM-Friendliness

### Well-Structured Areas

- **RBAC permissions:** Single source of truth in `packages/core/src/auth/rbac/permissions.ts` with comprehensive metadata. Easy for an LLM to find and extend.
- **Route permissions:** Clear mapping in `packages/core/src/auth/rbac/route-permissions.ts`. Adding a new route requires adding one entry.
- **Auth configuration:** Factory pattern in `packages/core/src/auth/auth.ts` is clear and self-contained.
- **Middleware pipeline:** The admin middleware sequence (`auth -> admin-detection -> rbac -> csp -> cache-invalidation`) is explicit in `apps/admin/src/middleware/index.ts`.

### Confusing Areas

- **Two auth middleware stacks:** An LLM working on auth must understand that requests go through BOTH the Astro middleware (admin worker) AND the Hono middleware (API worker via service binding). The RBAC enforcement is duplicated across both, which is intentional defense-in-depth but can confuse when only one is updated.
- **Route path formats:** The mixed `/api/products` vs `/api/v1/admin/products` format in route-permissions makes it non-obvious which format to use for new routes.
- **`isPublicRoute()` bypass:** The function in `apps/admin/src/middleware/route-utils.ts` allows `/api/v1/*` (non-admin) and `/api/auth/*` routes to bypass all admin middleware. This is correct but easy to accidentally route something through the bypass.

---

## Recommended Changes

### Priority 1 (Security)

1. **Fix token blacklist to fail closed** (`apps/api/src/utils/jwt.ts` line 192): Change `return false` to `return true` in the `isTokenBlacklisted` catch block. Add a local in-memory Set as fallback. [CRIT-1]

2. **Remove temp password console.log** (`apps/api/src/routes/admin/auth-management.ts` line 186): Return the temp password in the response body instead of logging it. [CRIT-2]

3. **Remove or secure the `/2fa/mark-verified` endpoint** (`apps/api/src/routes/admin/auth-management.ts` lines 371-398): Either remove it (the verify endpoint already marks verified) or add a server-side proof check. [2FA concern]

### Priority 2 (Correctness)

4. **Add RBAC permission checks to auth-management routes** (`apps/api/src/routes/admin/auth-management.ts`): Replace `sessionUser.role !== "admin"` checks with `hasPermission(db, sessionUser.id, PERMISSIONS.TEAM_VIEW)` for listing and `PERMISSIONS.TEAM_MANAGE` for create/delete. [CQ-3]

5. **Fix KV cache clearing on permission changes**: When `clearAllPermissionCache()` is called in `packages/core/src/auth/rbac/helpers.ts`, also clear the affected users' KV entries. The function currently only clears the local in-memory cache. [RBAC gap]

6. **Standardize route-permission path format** (`packages/core/src/auth/rbac/route-permissions.ts`): Move all product routes to use `/api/v1/admin/products` format. [PV-2, PV-3]

### Priority 3 (Hardening)

7. **Require JWT_SECRET in all environments** (`apps/api/src/utils/jwt.ts`): Remove the default fallback secret. Throw unconditionally if `JWT_SECRET` is not set, matching the `BETTER_AUTH_SECRET` pattern. [CRIT-3]

8. **Unify scanner token validation** in the API middleware only (`apps/api/src/middleware/admin-auth.ts`): Add device binding check (cookie validation) here, remove the duplicate from admin Astro middleware. [RG-4]

9. **Add customer session rotation**: In `packages/core/src/modules/customers/customer-auth.service.ts`, rotate the session token periodically (e.g., on profile update or every 24 hours) to limit the window if a session is stolen. [Customer auth concern]

### Priority 4 (Cleanup)

10. **Remove `as any` casts from RBAC route handlers** (`apps/api/src/routes/admin/rbac.ts` lines 118, 201): Use proper typed handler signatures.

11. **Include more env vars in auth cache signature** (`packages/core/src/auth/auth.ts`): Add `BETTER_AUTH_URL` to the cache key. [CQ-1]
