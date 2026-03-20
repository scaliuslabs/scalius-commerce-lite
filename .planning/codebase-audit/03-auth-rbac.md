# Auth & RBAC Security Audit

**Auditor:** Claude Opus 4.6 (1M context)
**Date:** 2026-03-20
**Scope:** Authentication config, RBAC, admin middleware/pages, customer auth, storefront auth
**Files Reviewed:** 30+ files across packages/core, apps/admin, apps/api, apps/storefront

---

## Summary

The authentication and RBAC system is well-architected with clear separation between admin auth (Better Auth + optional JWT), customer auth (OTP-based via KV), and a granular permission model with 78 permissions across 14 categories. The layered middleware pipeline in the admin app (auth -> admin-detection -> rbac -> csp) is sound, and the API worker has its own independent enforcement layer via `adminAuthMiddleware`. There are no critical vulnerabilities that would allow unauthenticated access to protected resources. However, there are several hardening opportunities around default secrets, token blacklist failure modes, permission cache consistency, and the setup endpoint.

**Overall Security Posture:** Solid with known gaps

---

## Strengths

### 1. Clean Admin/Customer Auth Separation
Admin auth uses Better Auth (email/password + optional TOTP 2FA) with session cookies, while customer auth uses a completely separate OTP-based system with KV-backed sessions and its own cookie (`cs_tok`). The two systems share zero state, preventing confused-deputy attacks.

### 2. Defense-in-Depth RBAC Enforcement
RBAC is enforced at **two independent layers**:
- **Admin middleware pipeline** (`apps/admin/src/middleware/rbac.ts`): Checks page-level and API-route-level permissions before requests reach the API worker.
- **API worker middleware** (`apps/api/src/middleware/admin-auth.ts`): Re-checks permissions independently using the same `route-permissions.ts` map. Even if the admin proxy is bypassed, the API worker enforces access control.

### 3. Comprehensive Permission Model
78 permissions across 14 categories with proper metadata (displayName, description, resource, action, isSensitive). The `PERMISSIONS` constant object provides type-safe references. The model supports:
- Role-based permissions (union of all assigned roles)
- User-level permission overrides (explicit grants AND denials)
- Super admin bypass
- Sensitive permission flagging

### 4. Well-Designed Auto-Seeding
`autoSeedRbacIfNeeded()` runs once per isolate lifecycle with zero DB cost after the initial check. Five built-in roles (super_admin, manager, sales_rep, content_editor, product_specialist) with sensible permission assignments. The first admin is automatically promoted to super admin.

### 5. Rate Limiting Throughout
- Better Auth: 5 sign-in attempts/minute, 3 password resets/5 minutes, 5 2FA attempts/minute
- Customer OTP: IP-based (5 requests/10 minutes), per-identifier cooldown (2 minutes between sends), per-OTP attempt limit (5 max)
- Setup endpoint: 5 attempts/IP/hour via KV

### 6. Constant-Time Token Comparison
The API token endpoint (`apps/api/src/routes/auth.ts`) uses `timingSafeCompare()` with SHA-256 hashing, preventing timing side-channel attacks.

### 7. Secure Cookie Configuration
Customer auth cookies use `HttpOnly`, `Secure`, and appropriate `SameSite` settings (Lax for same-origin proxy, None for cross-origin production). The storefront proxy correctly rewrites cookies from the API worker to strip `Domain` attributes and downgrade `SameSite=None` to `SameSite=Lax`.

### 8. Cryptographically Secure OTP Generation
`generateOtpCode()` uses `crypto.getRandomValues()` with modular arithmetic, producing uniformly distributed 6-digit codes.

---

## Issues

### CRITICAL

**(None identified.)**

No paths were found that allow unauthenticated access to admin resources, privilege escalation, or session hijacking.

### MAJOR

#### M1. Default Secrets in Development Could Leak to Production

**Files:**
- `apps/api/src/routes/auth.ts:57-59`
- `apps/api/src/utils/jwt.ts:28`

**Finding:** The API token route falls back to `"default-api-token-change-in-production"` and the JWT utility falls back to `"your-jwt-secret-key-change-this-in-production"`. While the JWT utility has a production guard that throws on the default secret, the API token route does **not** have an equivalent guard:

```typescript
const API_TOKEN =
    c.env.API_TOKEN ||
    process.env.API_TOKEN ||
    "default-api-token-change-in-production";
```

If `API_TOKEN` is not set in the Cloudflare environment, the API worker will silently accept the hardcoded default token in production.

**Risk:** An attacker who knows the default string can generate system-level JWT tokens via `GET /api/v1/auth/token`.

**Recommendation:** Add a production guard identical to the JWT secret guard. Throw an error if the default API token is used when `NODE_ENV === "production"`.

---

#### M2. Token Blacklist Fails Open

**File:** `apps/api/src/utils/jwt.ts:166-178`

**Finding:** `isTokenBlacklisted()` returns `false` on any error:

```typescript
} catch (error: unknown) {
    console.error("Error checking token blacklist:", error);
    return false; // Fail open to avoid blocking valid requests
}
```

If KV is temporarily unavailable, **all** revoked tokens would be accepted.

**Risk:** A revoked JWT (e.g., after an admin is deactivated or password changed) could still be used during KV outages.

**Recommendation:** Fail closed for security-sensitive operations. At minimum, fail closed for admin routes while optionally failing open for non-admin routes. Consider a dual check: in-memory blacklist + KV blacklist.

---

#### M3. Email Verification Disabled for Admin Accounts

**File:** `packages/core/src/auth/auth.ts:49`

```typescript
requireEmailVerification: false,
```

Combined with `apps/api/src/routes/admin/auth-management.ts:155-156`:

```typescript
await db.update(user).set({ role: "admin", emailVerified: true })
```

Admin accounts created via the user management API have `emailVerified` forced to `true`. While this is deliberate for the invite flow (admin creates user, sends email with temp password), it means admin accounts never verify email ownership.

**Risk:** If an admin creates a user with an email they don't control, that email's "owner" has no recourse and the account holder has admin access tied to an unverified email.

**Recommendation:** Consider requiring email verification for admin accounts created via the invite flow. The temp password email itself could serve as a verification mechanism if the link includes a verification token.

---

#### M4. Setup Endpoint Accessible Post-Deployment if DB is Wiped

**File:** `apps/api/src/routes/admin/auth-management.ts:541-585`

**Finding:** The setup endpoint at `/api/v1/setup` is mounted **outside** the `adminAuthMiddleware` block (line 335 of `app.ts`). It checks `adminExists` at runtime. If the database is reset in production (e.g., D1 migration failure, manual wipe), the setup endpoint becomes publicly accessible again.

**Risk:** An attacker could create a super admin account on a production system with a wiped database.

**Recommendation:** Add an environment variable guard (e.g., `ALLOW_SETUP=true`) that must be explicitly set for the setup endpoint to be active. This prevents accidental re-exposure after DB resets.

---

### MINOR

#### m1. Inconsistent Route Prefix in Route Permissions Map

**File:** `packages/core/src/auth/rbac/route-permissions.ts`

**Finding:** The `ROUTE_PERMISSIONS` map mixes path prefixes:
- Some routes use `/api/products` (lines 31-73) -- legacy format without `/v1/admin/`
- Most admin routes use `/api/v1/admin/categories` (lines 79+)
- Settings routes use `/api/settings/...` (lines 412+)

The `getRoutePermission()` in `admin-auth.ts` normalizes paths (line 140: `const pathname = honoPathname.startsWith("/api/v1") ? honoPathname : /api/v1${honoPathname}`), but this fragile normalization could miss edge cases.

**Recommendation:** Migrate all route permission entries to use the canonical `/api/v1/admin/...` prefix. Remove legacy `/api/products` and `/api/settings/` entries.

---

#### m2. OTP Code Comparison is Not Constant-Time

**File:** `packages/core/src/modules/customers/customer-auth.service.ts:308`

```typescript
if (stored.code !== code) {
```

String equality (`!==`) is not constant-time. While the practical risk is low (6-digit numeric codes with attempt limits), it's a defense-in-depth gap.

**Recommendation:** Use a constant-time comparison function for OTP verification.

---

#### m3. Permission Cache Inconsistency Window

**File:** `packages/core/src/auth/rbac/helpers.ts:16-20`

The permission cache has two layers:
- In-memory Map (per-isolate, no explicit TTL but uses `CACHE_TTL` of 5 minutes)
- KV cache (cross-isolate, 5-minute TTL)

When permissions are modified via `clearPermissionCache()`, only the current isolate's in-memory cache and the KV entry are cleared. **Other isolates' in-memory caches continue serving stale permissions for up to 5 minutes.**

**Risk:** After revoking a user's permissions, the user could still perform privileged actions on requests hitting other isolates for up to 5 minutes.

**Recommendation:** Document this as a known limitation. For immediate revocation, consider invalidating the user's session entirely (forcing re-authentication) rather than relying on permission cache invalidation.

---

#### m4. Temp Password Logged on Email Failure

**File:** `apps/api/src/routes/admin/auth-management.ts:170-171`

```typescript
console.error("Failed to send invitation email:", emailError);
console.log(`IMPORTANT: Temp password for ${email}: ${tempPassword}`);
```

If the email integration fails, the temporary password is logged in plaintext. On Cloudflare Workers, `console.log` output goes to the Logpush/Tail stream, which may be stored in third-party logging services.

**Recommendation:** Remove the password logging. Instead, return the temp password in the API response (it's already an admin-only endpoint) and let the admin UI display it.

---

#### m5. `2FA/mark-verified` Endpoint Lacks Independent Verification

**File:** `apps/api/src/routes/admin/auth-management.ts:361-377`

The `POST /admin/auth/2fa/mark-verified` endpoint sets `twoFactorVerified: true` on the session without performing any actual 2FA verification. It only checks that `twoFactorEnabled` is true for the user. This endpoint appears to be called after external verification (e.g., email OTP via Better Auth), but it trusts the caller's claim.

**Risk:** If an attacker can authenticate with the user's password (but not 2FA), they could potentially call this endpoint to mark the session as 2FA-verified, bypassing 2FA entirely. However, this is mitigated by the fact that the endpoint is behind `adminAuthMiddleware`, which requires a valid session.

**Recommendation:** Add a nonce or state token that ties the `mark-verified` call to a specific 2FA challenge. Alternatively, ensure Better Auth's own session state gates access to this endpoint (i.e., only sessions pending 2FA verification can call it).

---

#### m6. Scanner Token Device Binding Bypass Path

**Files:**
- `apps/admin/src/middleware/rbac.ts:46-72`
- `apps/api/src/middleware/admin-auth.ts:62-87`

The admin middleware validates scanner tokens with device binding (checking `scanner_sid` cookie against the KV payload). However, the API worker's `adminAuthMiddleware` only checks if the scanner token is `claimed` -- it does **not** verify device binding:

```typescript
if (payload.claimed) {
    user = { id: `scanner:${payload.adminId}`, ... };
}
```

**Risk:** If a scanner token is intercepted, it can be used from any device on the API worker path (bypassing the admin middleware's device binding check).

**Recommendation:** Add device binding verification to `adminAuthMiddleware` as well. The KV payload already contains `sessionId`; check the `scanner_sid` cookie against it.

---

#### m7. `trustedOrigins` Silently Accepts Undefined Values

**File:** `packages/core/src/auth/auth.ts:194`

```typescript
trustedOrigins: [baseURL, storefrontURL].filter(Boolean) as string[],
```

If neither `BETTER_AUTH_URL`/`PUBLIC_API_BASE_URL` nor `STOREFRONT_URL` is set, `trustedOrigins` becomes an empty array. Better Auth's behavior with an empty trusted origins list should be verified -- it may default to permissive CORS.

**Recommendation:** Validate that at least one trusted origin is present and warn loudly if not.

---

## Pattern Analysis

### Auth Flow Completeness

| Flow | Status | Notes |
|------|--------|-------|
| Admin login (email/password) | Complete | Via Better Auth, session cookies, redirect to /admin |
| Admin 2FA (TOTP) | Complete | Setup, verification, backup codes, method switching |
| Admin 2FA (email OTP) | Complete | Via Better Auth twoFactor plugin |
| Admin password reset | Complete | Email with reset link, token-based verification |
| Admin initial setup | Complete | First-run detection, super admin creation, RBAC seeding |
| Admin invite/create user | Complete | Temp password, email invite, optional role assignment |
| Customer OTP login (email) | Complete | KV-backed OTP with rate limiting, session creation |
| Customer OTP login (phone/SMS) | Partial | Transport defined but SMS provider pending (see TODO in otp-transport.ts) |
| Customer OTP login (WhatsApp) | Complete | WhatsApp Cloud API transport with config validation |
| Customer logout | Complete | Cookie clearing + KV session deletion |
| Customer profile update | Complete | Session-authenticated, KV session refresh |
| JWT service-to-service auth | Complete | Token generation, verification, blacklisting, refresh |

### RBAC Enforcement Points

```
Request Flow:
  Browser -> Admin Middleware Pipeline -> Admin Proxy API -> API Worker

Admin Middleware Pipeline:
  1. authMiddleware     -- Extract Better Auth session
  2. adminDetection     -- Redirect to setup/login if needed
  3. rbacMiddleware     -- Load permissions, enforce page + API route access
  4. cspMiddleware      -- Inject Content-Security-Policy headers

API Worker (independent enforcement):
  1. adminAuthMiddleware -- Verify session OR JWT, load permissions, enforce route access
  2. Route handler      -- Additional role checks (e.g., sessionUser.role !== "admin")
```

Both layers use the same `ROUTE_PERMISSIONS` map and `getRoutePermission()` function, ensuring consistency.

### Permission Resolution Order

```
1. Is super admin?  -> ALL permissions (immediate return)
2. Role-based permissions (union of all assigned roles)
3. User-level overrides:
   - Grants: ADD to effective set
   - Denials: REMOVE from effective set
```

This is a sound model. Denials override grants (explicit deny wins), which is the correct security posture.

### Customer vs Admin Auth Separation

| Aspect | Admin Auth | Customer Auth |
|--------|-----------|---------------|
| Provider | Better Auth | Custom KV-based |
| Session storage | D1 (SQLite) | Cloudflare KV |
| Cookie name | `better-auth.session_token` | `cs_tok` |
| Authentication method | Email/password + optional 2FA | OTP (email/phone/WhatsApp) |
| Session duration | 7 days | 30 days |
| Rate limiting | Better Auth built-in | Custom IP + per-identifier |
| RBAC | Full permission model | None (customer has access to own data) |

The separation is clean. There is no code path where a customer session could be confused with an admin session or vice versa.

---

## Recommendations

### High Priority

1. **Add production guard for `API_TOKEN` default** -- Same pattern as JWT secret guard. Prevents accidental use of hardcoded default in production.

2. **Fail closed on token blacklist errors** -- At least for admin routes. A KV outage should not silently allow revoked tokens.

3. **Add environment variable guard to setup endpoint** -- Require `ALLOW_SETUP=true` to prevent re-exposure after DB resets.

4. **Add device binding to API worker's scanner token validation** -- Parity with admin middleware's device binding check.

### Medium Priority

5. **Migrate route permissions to canonical prefixes** -- Remove legacy `/api/products`, `/api/settings` entries. Use `/api/v1/admin/...` consistently.

6. **Remove temp password logging** -- Return in API response instead of logging to console.

7. **Add independent verification to `2FA/mark-verified`** -- Tie to a specific challenge nonce.

8. **Document permission cache staleness window** -- 5-minute window across isolates is an acceptable trade-off but should be documented for operators.

### Low Priority

9. **Use constant-time comparison for OTP codes** -- Defense in depth.

10. **Validate `trustedOrigins` is non-empty** -- Warn loudly if no origins are configured.

11. **Consider enabling email verification for admin accounts** -- Even if the invite email serves as implicit verification.

---

## LLM-Friendliness Score: 8/10

### What Works Well

- **Centralized permission constants** (`PERMISSIONS` object): An LLM can quickly find any permission by name or domain.
- **Metadata-rich permission definitions**: `displayName`, `description`, `resource`, `action`, `category`, `isSensitive` provide full context without needing to read multiple files.
- **Clear type system**: `PermissionName`, `UserPermissionContext`, `PermissionCheckResult` types make the data flow self-documenting.
- **Route permission map**: The declarative `ROUTE_PERMISSIONS` record is easy to scan and reason about.
- **Page permission map**: Same declarative style for admin page routes.
- **Named system roles**: `super_admin`, `manager`, `sales_rep`, `content_editor`, `product_specialist` are self-explanatory.
- **Single barrel export**: `packages/core/src/auth/rbac/index.ts` re-exports everything, so an LLM only needs one import path.

### What Could Improve

- **Mixed route prefixes** in `ROUTE_PERMISSIONS` (legacy `/api/products` vs modern `/api/v1/admin/...`) require an LLM to understand the normalization logic in `admin-auth.ts`.
- **No explicit "which routes are NOT protected" documentation** -- An LLM must trace through `isProtectedApiRoute()` regex patterns and `app.ts` mount order to determine which routes are public.
- **Permission resolution is split across multiple files** -- `helpers.ts` (resolution logic), `api-protection.ts` (higher-order wrappers), `admin-auth.ts` (API middleware), `rbac.ts` (admin middleware). An LLM needs to read all four to understand the full enforcement picture. A single "how RBAC works" comment block in `helpers.ts` would help.
- **`as any` casts in middleware** reduce type information available to LLMs analyzing the code.

---

## File Reference

| File | Purpose |
|------|---------|
| `packages/core/src/auth/auth.ts` | Better Auth factory, session config, rate limiting, 2FA plugin |
| `packages/core/src/auth/rbac/permissions.ts` | 78 permission constants + metadata |
| `packages/core/src/auth/rbac/types.ts` | TypeScript types for permission model |
| `packages/core/src/auth/rbac/helpers.ts` | Permission resolution, caching, role/override management |
| `packages/core/src/auth/rbac/api-protection.ts` | Higher-order route wrappers for permission checking |
| `packages/core/src/auth/rbac/route-permissions.ts` | API route -> permission mapping |
| `packages/core/src/auth/rbac/page-permissions.ts` | Admin page route -> permission mapping |
| `packages/core/src/auth/rbac/auto-seed.ts` | First-run RBAC seeding logic |
| `packages/core/src/modules/customers/customer-auth.service.ts` | Customer OTP auth business logic |
| `packages/core/src/modules/customers/otp-transport.ts` | OTP delivery transport abstraction |
| `apps/admin/src/middleware/auth.ts` | Session extraction, env initialization |
| `apps/admin/src/middleware/admin-detection.ts` | Setup/login redirects |
| `apps/admin/src/middleware/rbac.ts` | Permission loading, page + API route enforcement |
| `apps/admin/src/middleware/csp.ts` | Content-Security-Policy headers |
| `apps/admin/src/lib/auth-client.ts` | Better Auth React client |
| `apps/admin/src/pages/api/auth/[...all].ts` | Better Auth catch-all handler |
| `apps/api/src/middleware/admin-auth.ts` | API-side auth + RBAC enforcement |
| `apps/api/src/middleware/auth.ts` | JWT auth middleware (legacy routes) |
| `apps/api/src/routes/auth.ts` | JWT token generation, firebase config, token stats |
| `apps/api/src/routes/customer-auth.ts` | Customer auth API endpoints |
| `apps/api/src/routes/admin/auth-management.ts` | Admin user CRUD, 2FA, password, setup |
| `apps/api/src/utils/jwt.ts` | JWT generation, verification, blacklisting |
| `apps/storefront/src/middleware.ts` | Caching middleware (no auth) |
| `apps/storefront/src/lib/api/customer-auth.ts` | Storefront customer auth API client |
| `apps/storefront/src/pages/api/customer-auth/[...path].ts` | Same-origin proxy for customer auth |
| `apps/storefront/src/pages/api/auth/logout.ts` | Same-origin logout proxy |
