# Auth & RBAC System

Complete authentication and role-based access control for the Scalius Commerce admin dashboard. Two independent auth systems: Better Auth for admin users, D1-backed OTP challenges plus D1 hashed-token sessions for storefront customers.

## Architecture Overview

```
Admin Auth Flow:
  Browser --> TanStack Start route guard --> Direct D1 session-cookie lookup
                                             |
                                             v
                                       RBAC Permission Load
                                             |
                                             v
                                       Page/API Route Guard

API Worker Auth Flow (service bindings / external apps):
  Request --> Hono admin-auth middleware --> Better Auth Cookie OR Scanner Cookie
                                             |
                                             v
                                       2FA gate + RBAC Permission Check via route-permissions.ts

Customer Auth Flow (storefront):
  Browser --> storefront /api/customer-auth/* proxy --> API /customer-auth/send-otp --> D1 OTP challenge
  Browser --> storefront /api/customer-auth/* proxy --> API /customer-auth/verify   --> D1 token-hash session (cs_tok cookie)
```

## Files

### Core Auth

| File | Purpose |
|------|---------|
| `auth.ts` | `createAuth()` / `getAuth()` -- Better Auth factory with Drizzle adapter, email/password, 2FA (TOTP + email OTP), admin plugin. Cached per runtime auth signature: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `PUBLIC_API_BASE_URL`, and `STOREFRONT_URL`. |
| `admin-setup.ts` | D1-backed first-admin setup coordination. Owns the singleton setup claim, setup attempt rate limit, and guarded admin promotion/claim completion helper used by `/api/v1/setup`. |
| `scanner-token-claims.ts` | D1-backed scanner QR-token claim helpers. Minting stores only a token hash, exchange atomically consumes an unexpired/unconsumed claim before a scanner KV session is written, and scheduled maintenance prunes expired/old claims. |
| `index.ts` | Barrel re-export of `createAuth`, `getAuth`, `Auth` type, and setup coordination helpers. |

### RBAC

| File | Purpose |
|------|---------|
| `rbac/types.ts` | TypeScript types: `PermissionName`, `UserPermissionContext`, `PermissionCheckResult`, `ProtectedRouteConfig`, `SystemRole`, `PermissionGroup`, `PermissionCategory`, `PermissionMetadata`, `RoleWithPermissions`, `UserPermissionOverride` |
| `rbac/permissions.ts` | `PERMISSIONS` constant (81 permissions across 14 categories), `PERMISSION_METADATA` record, helper functions (`getPermissionsByCategory`, `getAllPermissions`, `getAllPermissionNames`, `isSensitivePermission`) |
| `rbac/helpers.ts` | Core RBAC engine: `getUserPermissions()` (L1 Map + L2 KV + D1 batch query), `hasPermission()`, `hasAnyPermission()`, `hasAllPermissions()`, `checkPermissionDetailed()`, `getUserPermissionContext()`, `isSuperAdmin()`, `hasAdminAccess()`, role/permission CRUD (`assignRoleToUser`, `removeRoleFromUser`, `setUserPermissionOverride`, `removeUserPermissionOverride`, `getAllRolesWithPermissions`, `getRolePermissions`), `clearPermissionCache()`, `clearAllPermissionCache()` |
| `rbac/page-permissions.ts` | Maps admin page routes to required permissions. Static map for exact routes, regex array for dynamic routes (e.g., `/admin/products/[id]/edit`). `getPagePermission()` and `hasPageAccess()` functions. |
| `rbac/route-permissions.ts` | Maps API route patterns to required permissions per HTTP method. Glob-style wildcard matching. `getRoutePermission()` function. `ROUTE_PERMISSIONS` record. |
| `rbac/auto-seed.ts` | `autoSeedRbacIfNeeded()` -- seeds all 81 permissions and 5 system roles on first admin access. Sets first `role=admin` user as super admin. Runs once per isolate lifecycle (in-memory flag) and uses a versioned six-hour Cloudflare KV marker when a `CACHE` binding is supplied so fresh isolates can skip the expensive seed-current D1 batch. |
| `rbac/api-protection.ts` | Higher-order functions for wrapping API route handlers: `withPermission()`, `withAnyPermission()`, `withAllPermissions()`, `withSuperAdmin()`. Also `checkPermissionForApi()`, `checkAnyPermissionForApi()`, `checkAllPermissionsForApi()` helpers, and `unauthorizedResponse()` / `forbiddenResponse()` factory functions. These are Astro-style wrappers; the Hono API uses middleware instead. |
| `rbac/index.ts` | Barrel re-export of all RBAC modules. |

### Database Schema

| File | Tables |
|------|--------|
| `packages/database/src/schema/auth.ts` | `user`, `session`, `account`, `verification`, `twoFactor` including Better Auth's `verified` column |
| `packages/database/src/schema/rbac.ts` | `permissions`, `roles`, `rolePermissions`, `userRoles`, `userPermissions` |

## Better Auth Configuration

- **Provider**: Email/password only (no OAuth)
- **Min password length**: 12 characters (enforced consistently: Better Auth config, API `changePasswordSchema`, admin frontend `ChangePasswordForm`, and `SetupForm`)
- **Email verification**: Disabled (`requireEmailVerification: false`)
- **Session TTL**: 7 days, updated daily, cookie cache 5 minutes
- **Rate limiting**: 5 sign-in attempts/min, 3 password resets/5min, 5 2FA attempts/min, session checks unlimited
- **IP detection**: `cf-connecting-ip` then `x-forwarded-for`, IPv6 /64 subnet grouping
- **Trusted origins**: `BETTER_AUTH_URL` + `STOREFRONT_URL`
- **Password resets**: Better Auth revokes existing sessions after password reset.
- **Email callbacks**: `sendVerificationEmail`, `sendResetPassword`, and 2FA `sendOTP` all dynamically import `sendEmail` from `../integrations/email` to avoid circular dependencies. All templates use `escapeHtml()` from `@scalius/shared/html-escape`.

### Plugins

1. **twoFactor**: TOTP (6 digits, 30s period) + email OTP (5 min expiry) + 10 backup codes (10 chars each)
2. **admin**: `defaultRole: "user"`, `adminRoles: ["admin"]`

### Auth Client (admin frontend)

`apps/admin-v2/src/lib/auth-client.ts` -- `createAuthClient()` with `twoFactorClient` (redirects to `/auth/two-factor`) and `adminClient` plugins. Exports `signIn`, `signUp`, `signOut`, `useSession`, `getSession`, `twoFactor`, `admin`.

## RBAC System

### Permission Resolution Order

1. Super admin (`user.isSuperAdmin = true`) -- gets ALL permissions unconditionally
2. User-level overrides (grant or deny from `user_permissions` table)
3. Role-based permissions (union of all assigned roles via `user_roles` + `role_permissions`)

### 81 Permissions Across 14 Categories

| Category | Count | Sensitive |
|----------|-------|-----------|
| Products | 7 | `permanent_delete` only |
| Categories | 6 | `permanent_delete` only |
| Collections | 6 | No |
| Orders | 8 | No |
| Customers | 6 | No |
| Discounts | 5 | All 5 |
| Pages | 5 | No |
| Widgets | 5 | No |
| Media | 4 | No |
| Attributes | 4 | No |
| Analytics | 4 | No |
| Settings | 16 | `general.*`, `delivery_providers.*`, `fraud_checker.*` |
| Team | 3 | `view`, `manage`, `manage_roles` |
| Dashboard | 2 | No |

### 5 System Roles (auto-seeded)

| Role | Permissions | Notes |
|------|-------------|-------|
| `super_admin` | All 81 | System role, cannot modify permissions |
| `manager` | All except `permanent_delete`, `orders.refund`, `delivery_providers.edit`, `fraud_checker.edit`, `team.manage_roles` | System role |
| `sales_rep` | Dashboard, products/categories/collections (view), orders (full CRUD + shipments), customers (view/create/edit/history), discounts (view) | System role |
| `content_editor` | Dashboard, pages/widgets (full CRUD), media (full), collections (view/edit/toggle), settings (header/footer/seo) | System role |
| `product_specialist` | Dashboard, products (full except permanent_delete), categories (full except permanent_delete), collections (full), attributes (full), media (view/upload) | System role |

### Permission Caching

- **L1**: In-memory `Map<userId, {permissions, timestamp}>` per Worker isolate, 5-minute TTL
- **L2**: Cloudflare KV (`rbac:perms:{userId}`), 5-minute TTL
- **Read order**: `getUserPermissions(db, userId, kv)` uses KV as the cross-isolate source of truth when KV is supplied, then refreshes from D1 on KV miss. Stale local memory must not override a missing/cleared KV entry.
- **D1 batch query**: All 3 queries (user lookup, role permissions, user overrides) run in a single `db.batch()` call
- **Cache invalidation**: `clearPermissionCache(userId, kv)` deletes both L1 and L2. `clearAllPermissionCache()` clears local Map only (no KV prefix deletion).
- **Mutation rule**: RBAC mutation routes must delete affected per-user KV entries with `clearPermissionCache(userId, kv)`. `clearAllPermissionCache()` is useful only for the current isolate and must not be treated as cross-isolate invalidation.

## Admin Middleware Pipeline

The TanStack admin app now uses route/server-function guards rather than the old Astro middleware chain.

### 1. Auth Helpers

- `apps/admin-v2/src/lib/admin-session.server.ts` is the hot route-guard path. It verifies the Better Auth session cookie HMAC with `BETTER_AUTH_SECRET`, then verifies the active session/user directly through D1 with expiry and ban predicates. Raw or tampered token prefixes must never reach the D1 lookup.
- `apps/admin-v2/src/lib/auth.server.ts` remains the Better Auth integration boundary for `/api/auth/*`, 2FA verification paths, and auth operations that need Better Auth itself. Do not pull it back into normal `/admin` guard reads.

### 2. Admin Detection Guards (`apps/admin-v2/src/lib/auth.fns.ts`)

- `/auth/login`: Redirects to `/auth/setup` if no admin users exist. Redirects to `/admin` if already authenticated (with 2FA check).
- `/admin/*`: Redirects to `/auth/setup` if no admin users exist. Redirects to `/auth/login` if unauthenticated. Redirects to `/auth/two-factor` if 2FA enabled but session not verified.
- Loads the current session through the direct D1 helper and returns serializable user/session context for TanStack route guards.

### 3. RBAC Loader (`apps/admin-v2/src/middleware/rbac.server.ts`)

- Returns immediately for a known super admin before importing Cloudflare env, database helpers, or core RBAC modules.
- Calls `autoSeedRbacIfNeeded(db, kv)` before non-super-admin permission loads; keep the KV binding wired so seed-current checks are not repeated by every fresh isolate.
- Loads user permissions via `getUserPermissions()` and returns permission arrays to the route context
- Checks `isSuperAdmin()` and `hasAdminAccess()`
- **Page-level protection**: `/admin` route guard checks `hasPageAccess()` and redirects to `/admin/access-denied` on failure. Exceptions: `/admin/access-denied` and `/admin/settings/account` are always accessible.

## API Worker Auth (Hono)

### Admin Auth Middleware (`apps/api/src/middleware/admin-auth.ts`)

Authentication strategy:
1. **Better Auth session cookie** -- tries first (for dashboard frontend requests via service binding)
2. **Scanner session cookie** -- created only after the admin worker atomically consumes a D1 scanner QR-token claim; limited to exact scanner workflow endpoints

Then validates:
- 2FA-enabled admin sessions must have `session.twoFactorVerified = true`, except exact 2FA completion endpoints (`GET /2fa/info`, `POST /2fa/verify`, `POST /2fa/complete-verification`, `POST /2fa/method`).
- User must have at least one RBAC permission. Super admins receive all permissions through `getUserPermissions()`; do not fall back to legacy `user.role`.
- Fine-grained route permission check via `getRoutePermission()`. Unmapped admin routes fail closed, including for super admins.
- Scanner sessions use only the scanner allowlist and never inherit the minting admin's role or permissions.
- Scanner QR token single-use state lives in `scanner_token_claims`, not KV. KV stores only the post-claim `scanner:session:*` payload with `claimTokenHash`.

### JWT Auth Middleware (`apps/api/src/middleware/auth.ts`)

Simpler JWT-only middleware for non-admin service-token routes (`/auth/token`, `/auth/me`, etc.). Admin APIs intentionally do not accept JWT Bearer fallback; they require live Better Auth session truth for revocation, ban/deleted status, and 2FA.

### Service-to-Service Token (`apps/api/src/routes/auth.ts`)

`GET /api/v1/auth/token` -- exchanges `X-API-Token` header for a JWT with `role: "system"`. Uses constant-time comparison. The token grants system-level access. Other `/api/v1/auth/*` routes are service token helpers, Firebase config, token revocation, current-token info, and token stats; they are not Better Auth endpoints.

## Auth Pages (Admin Frontend)

| Page | Purpose |
|------|---------|
| `/auth/login` | Sign-in form. Redirects to setup if no admins exist, to admin if already logged in. |
| `/auth/setup` | First admin user creation. Blocked if any admin already exists or setup has already completed. D1-backed rate limit and setup claim prevent concurrent bootstrap races. Seeds RBAC. |
| `/auth/two-factor` | 2FA verification form. Shows if session exists but `twoFactorVerified` is false. |
| `/auth/setup-2fa` | Optional 2FA setup page. Redirects if 2FA already enabled. |
| `/auth/forgot-password` | Password reset request form. |
| `/auth/reset-password` | Password reset confirmation with token. |
| `/auth/index` | Redirects to `/auth/login`. |
| `/admin/access-denied` | Shown when RBAC denies page access. Link back to dashboard. |

## Customer Auth (Storefront)

Completely separate from Better Auth. OTP verification uses short-lived D1 challenges; customer sessions remain JWT-free D1 rows keyed by an HMAC hash of the `cs_tok` cookie value.

| Constant | Value |
|----------|-------|
| Cookie name | `cs_tok` |
| Session TTL | 30 days |
| OTP TTL | 5 minutes |
| OTP resend cooldown | 2 minutes |
| Max OTP attempts | 5 per code |
| IP rate limit | 5 requests/10min |

### Flow

1. `sendOtp()` -- validates identifier, normalizes phone to E.164, checks site settings/customer-auth policy, validates delivery transport before mutating challenge state, rate limits by trusted client IP through D1 `customer_auth_otp_rate_limits`, generates a 6-digit OTP, stores only an HMAC hash plus pinned contact metadata in `customer_auth_otp_challenges`, and returns queue payload with `deliveryKey` and `otpExpiresAt` for async delivery
2. `/send-otp` sends the payload to `AUTH_OTP_QUEUE`; if queue handoff fails, it deletes the exact D1 OTP challenge by `otpKey` + `deliveryKey` and returns retryable `503`
3. Queue delivery claims `auth_otp_delivery_receipts`, skips terminal/expired attempts, and records provider refs/status for email, SMS, or WhatsApp delivery
4. `verifyOtp()` -- normalizes identifier to E.164, atomically consumes correct D1 OTP challenges or increments wrong-code attempts, creates/finds customer in DB, creates a D1 session row with only the token HMAC, returns `CustomerSession` with the raw token for the `cs_tok` cookie
5. `getCustomerBySession()` -- hashes the cookie token, reads `customer_sessions`, joins the live `customers` row, and rejects expired/revoked/deleted-customer sessions
6. `deleteCustomerSession()` -- revokes the D1 session row; scheduled maintenance deletes expired and old revoked rows
7. `updateCustomerProfile()` -- updates the customer DB record and returns a fresh customer/session projection from D1

Phone numbers normalized to E.164 format via `libphonenumber-js`. New customer records auto-created on first successful OTP verification.

## API Endpoints

### Auth Management (`/api/v1/admin/auth/`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/users` | List all admin users with roles and overrides |
| POST | `/users` | Create admin user (generates temp password, sends invite email, assigns role; if invite email fails, the temp password is not returned and admins should use password reset) |
| DELETE | `/users/{id}` | Delete admin user (prevents last admin deletion) |
| POST | `/change-password` | Change current user password (12-char minimum) |
| POST | `/update-profile` | Update name and avatar |
| GET | `/2fa/info` | Get current user 2FA status |
| POST | `/2fa/complete-verification` | Complete 2FA after Better Auth verification; requires the verification session token bound to the current session/user |
| POST | `/2fa/method` | Switch between TOTP and email OTP after verifying a code for the target method or proving the same-origin Better Auth `sessionToken` matches the current session/user |
| POST | `/2fa/verify` | Verify TOTP, email OTP, or backup code |
| GET | `/account-security` | Get 2FA method and super admin status |

### Setup (`/api/v1/setup`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Check if any admin user exists |
| POST | `/` | Create first admin (sets as super admin, seeds RBAC) |

`POST /api/v1/setup` uses `admin_setup_rate_limits` for the 5/hour/IP setup throttle and `admin_setup_claims` as the singleton D1 setup authority. Do not move first-admin locking back to Cloudflare KV; KV may cache RBAC seed status, but setup concurrency must be decided by D1 insert/update predicates.

### RBAC (`/api/v1/admin/rbac/`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/roles` | List all roles with permissions |
| POST | `/roles` | Create custom role |
| GET | `/roles/{id}` | Get single role |
| PUT | `/roles/{id}` | Update role (system role permissions immutable) |
| DELETE | `/roles/{id}` | Delete role (blocked if assigned to users, blocked for system roles) |
| POST | `/user-roles` | Assign role to user |
| DELETE | `/user-roles` | Remove role from user |
| POST | `/user-permissions` | Set permission override (grant or deny) |
| DELETE | `/user-permissions` | Remove permission override |
| GET | `/permissions` | List all permissions grouped by category |
| GET | `/my-permissions` | Get current user's effective permissions |

## Known Gaps

1. **2FA is optional, but enabled 2FA is enforced per session**. Users without 2FA can access the admin dashboard. When 2FA is enabled, the admin middleware redirects browser sessions to `/auth/two-factor`, and the API admin middleware rejects unverified sessions except exact 2FA info/verify/complete-verification/method endpoints.

2. **`clearAllPermissionCache()` is local only**: Cross-isolate RBAC invalidation depends on deleting affected `rbac:perms:{userId}` KV entries with `clearPermissionCache(userId, kv)`. Role/permission mutation routes should enumerate affected users and clear those keys; do not rely on local-only broad cache clearing.

3. **Route permission map has mixed path prefixes**: Some entries use `/api/products/*` (legacy prefix), others use `/api/v1/admin/categories/*` (current prefix). The API admin-auth middleware normalizes paths by prepending `/api/v1` if not present. Admin page access is handled separately through the TanStack Start guard and `@scalius/core/auth/rbac/page-permissions`.

4. **Fraud checker is NOT called during checkout or order processing**. It is a standalone admin-only tool for manual phone number lookups. No automated fraud screening exists in the order pipeline.

5. **Customer auth has no 2FA**. Storefront customers authenticate solely via single-factor OTP (email or phone).

6. **Admin user creation depends on invite/password-reset email delivery**. If invite delivery fails, the API reports `emailFailed: true` without returning the temp password; the creating admin should fix email settings or use the password reset flow.

7. **No session revocation on role changes**. When a user's roles or permissions are modified, their existing sessions remain valid. Effective permission checks should refresh after affected KV permission-cache entries are deleted, but sessions themselves are not revoked.

8. **Super admin is set by first-user heuristic**. `autoSeedRbacIfNeeded()` also checks on every isolate start whether the first `role=admin` user (by `createdAt`) is a super admin and sets them if not. This could promote an unintended user if the original super admin is deleted.
