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
| `auth.ts` | `createAuth()` / `getAuth()` -- request-scoped Better Auth factory with Drizzle adapter, email/password, 2FA (TOTP + email OTP), and admin plugin. It must not be cached because the instance closes over the request database adapter and Worker bindings. |
| `admin-setup.ts` | D1-backed first-admin setup coordination. Owns the singleton setup claim, setup attempt rate limit, and guarded admin promotion/claim completion helper used by `/api/v1/setup`. |
| `scanner-token-claims.ts` | D1-backed scanner QR-token claim helpers. Minting stores only a token hash, exchange atomically consumes an unexpired/unconsumed claim before a scanner KV session is written, and scheduled maintenance prunes expired/old claims. |
| `index.ts` | Barrel re-export of `createAuth`, `getAuth`, `Auth` type, and setup coordination helpers. |

### RBAC

| File | Purpose |
|------|---------|
| `rbac/types.ts` | TypeScript types: `PermissionName`, `UserPermissionContext`, `PermissionCheckResult`, `ProtectedRouteConfig`, `SystemRole`, `PermissionGroup`, `PermissionCategory`, `PermissionMetadata`, `RoleWithPermissions`, `UserPermissionOverride` |
| `rbac/permissions.ts` | `PERMISSIONS` constant (78 permissions across 13 categories), `PERMISSION_METADATA` record, helper functions (`getPermissionsByCategory`, `getAllPermissions`, `getAllPermissionNames`, `isSensitivePermission`) |
| `rbac/helpers.ts` | Core RBAC engine: `getUserPermissions()` (KV + authoritative database batch query), `hasPermission()`, `hasAnyPermission()`, `hasAllPermissions()`, `checkPermissionDetailed()`, `getUserPermissionContext()`, `isSuperAdmin()`, `hasAdminAccess()`, role/permission CRUD (`assignRoleToUser`, `removeRoleFromUser`, `setUserPermissionOverride`, `removeUserPermissionOverride`, `getAllRolesWithPermissions`, `getRolePermissions`), and `clearPermissionCache()` |
| `rbac/page-permissions.ts` | Maps admin page routes to required permissions. Static map for exact routes, regex array for dynamic routes (e.g., `/admin/products/[id]/edit`). `getPagePermission()` and `hasPageAccess()` functions. |
| `rbac/route-permissions.ts` | Maps API route patterns to required permissions per HTTP method. Glob-style wildcard matching. `getRoutePermission()` function. `ROUTE_PERMISSIONS` record. |
| `rbac/auto-seed.ts` | `autoSeedRbacIfNeeded()` -- seeds permissions and five system roles during first-admin setup, and reconciles changed code-owned definitions in idempotent database batches. API middleware schedules reconciliation outside the request critical path and uses a versioned six-hour Cloudflare KV marker; it never shares database I/O across Worker requests. |
| `rbac/api-protection.ts` | Higher-order functions for wrapping API route handlers: `withPermission()`, `withAnyPermission()`, `withAllPermissions()`, `withSuperAdmin()`. Also `checkPermissionForApi()`, `checkAnyPermissionForApi()`, `checkAllPermissionsForApi()` helpers, and `unauthorizedResponse()` / `forbiddenResponse()` factory functions. These are Astro-style wrappers; the Hono API uses middleware instead. |
| `rbac/index.ts` | Barrel re-export of all RBAC modules. |

### Database Schema

| File | Tables |
|------|--------|
| `packages/database/src/schema/auth.ts` | `user`, `session`, `account`, `verification`, `twoFactor` including Better Auth's `verified` column and invited-admin onboarding flags |
| `packages/database/src/schema/rbac.ts` | `permissions`, `roles`, `rolePermissions`, `userRoles`, `userPermissions` |

## Better Auth Configuration

- **Provider**: Email/password only (no OAuth)
- **Min password length**: 12 characters (enforced consistently: Better Auth config, API `changePasswordSchema`, admin frontend `ChangePasswordForm`, and `SetupForm`)
- **Email verification**: Disabled (`requireEmailVerification: false`)
- **Session TTL**: 7 days, updated daily, cookie cache 5 minutes
- **Rate limiting**: 5 sign-in attempts/min, 3 password resets/5min, 5 2FA attempts/min, session checks unlimited
- **IP detection**: `cf-connecting-ip` then `x-forwarded-for`, IPv6 /64 subnet grouping
- **Trusted origins**: `BETTER_AUTH_URL` + `STOREFRONT_URL`
- **Password resets**: Better Auth revokes existing sessions after password reset and clears `user.mustChangePassword` only after the reset token is consumed.
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

### 78 Permissions Across 13 Categories

| Category | Count | Sensitive |
|----------|-------|-----------|
| Products | 7 | `permanent_delete` only |
| Categories | 6 | `permanent_delete` only |
| Collections | 6 | No |
| Orders | 8 | No |
| Customers | 6 | No |
| Discounts | 5 | All 5 |
| Pages | 5 | No |
| Media | 4 | No |
| Attributes | 4 | No |
| Analytics | 4 | No |
| Settings | 18 | `general.*`, `delivery_providers.*`, `fraud_checker.*`, `taxes.*` |
| Team | 3 | `view`, `manage`, `manage_roles` |
| Dashboard | 2 | No |

### 5 System Roles (auto-seeded)

| Role | Permissions | Notes |
|------|-------------|-------|
| `super_admin` | All 78 | System role, cannot modify permissions |
| `manager` | All except `permanent_delete`, `orders.refund`, `delivery_providers.edit`, `fraud_checker.edit`, `team.manage_roles` | System role |
| `sales_rep` | Dashboard, products/categories/collections (view), orders (full CRUD + shipments), customers (view/create/edit/history), discounts (view) | System role |
| `content_editor` | Dashboard, pages (full CRUD), media (full), collections (view/edit/toggle), settings (header/footer/seo) | System role |
| `product_specialist` | Dashboard, products (full except permanent_delete), categories (full except permanent_delete), collections (full), attributes (full), media (view/upload) | System role |

### Permission Caching

- **Shared cache**: Cloudflare KV (`rbac:perms:{userId}`), 5-minute TTL
- **Read order**: `getUserPermissions(db, userId, kv)` reads KV first, then refreshes from the authoritative database on a miss. It intentionally has no isolate-local user cache, so binding changes and revocations cannot be hidden by stale process memory.
- **D1 batch query**: All 3 queries (user lookup, role permissions, user overrides) run in a single `db.batch()` call
- **Cache invalidation**: `clearPermissionCache(userId, kv)` deletes the affected shared KV entry.
- **Mutation rule**: RBAC mutation routes enumerate affected users and delete their per-user KV entries. There is no isolate-local authority cache to clear.

## Admin Middleware Pipeline

The TanStack admin app now uses route/server-function guards rather than the old Astro middleware chain.

### 1. Auth Helpers

- `apps/admin-v2/src/lib/admin-session.server.ts` is the hot route-guard path. It verifies the Better Auth session cookie HMAC with `BETTER_AUTH_SECRET`, then verifies the active session/user directly through D1 with expiry and ban predicates. Raw or tampered token prefixes must never reach the D1 lookup.
- `apps/admin-v2/src/lib/auth.server.ts` remains the Better Auth integration boundary for `/api/auth/*`, 2FA verification paths, and auth operations that need Better Auth itself. Do not pull it back into normal `/admin` guard reads.

### 2. Admin Detection Guards (`apps/admin-v2/src/lib/auth.fns.ts`)

- `/auth/login`: Redirects to `/auth/setup` if no admin users exist. Redirects already-authenticated users to password setup, 2FA setup, 2FA verification, or `/admin` depending on live D1 session/user state.
- `/admin/*`: Redirects to `/auth/setup` if no admin users exist, `/auth/login` if unauthenticated, `/auth/forgot-password` if `mustChangePassword` is true, `/auth/setup-2fa` if invited-admin 2FA enrollment is still required, or `/auth/two-factor` if 2FA is enabled but the session is not verified.
- Loads the current session through the direct D1 helper and returns serializable user/session context for TanStack route guards.

### 3. RBAC Loader (`apps/admin-v2/src/middleware/rbac.server.ts`)

- Returns immediately for a known super admin before importing Cloudflare env, database helpers, or core RBAC modules.
- Loads user permissions via `getUserPermissions()` and returns permission arrays to the route context. It never seeds or repairs roles on the page-request critical path.
- Checks `isSuperAdmin()` and `hasAdminAccess()`
- **Page-level protection**: `/admin` route guard checks `hasPageAccess()` and redirects to `/admin/access-denied` on failure. Exceptions: `/admin/access-denied` and `/admin/settings/account` are always accessible.

## API Worker Auth (Hono)

### Admin Auth Middleware (`apps/api/src/middleware/admin-auth.ts`)

Authentication strategy:
1. **Better Auth session cookie** -- tries first (for dashboard frontend requests via service binding). The API middleware uses the same direct signed-cookie model as the admin route guard: verify `token.signature` with `BETTER_AUTH_SECRET`, then read the active session/user row from D1 with expiry and ban predicates. Raw or tampered token prefixes must never reach D1 or Better Auth's heavier request handler.
2. **Scanner session cookie** -- created only after the admin worker atomically consumes a D1 scanner QR-token claim; limited to exact scanner workflow endpoints

Then validates:
- Invited admins with `user.mustChangePassword = true` are blocked before RBAC except the own-account password-change endpoint. Normal invite onboarding uses Better Auth reset links, so the public `/api/auth/request-password-reset` + `/auth/reset-password` flow clears the flag.
- Invited admins with `user.mustEnrollTwoFactor = true` and `twoFactorEnabled = false` are blocked before RBAC except exact 2FA setup endpoints (`GET /2fa/info`, `POST /2fa/method`).
- 2FA-enabled admin sessions must have `session.twoFactorVerified = true`, except exact 2FA completion endpoints (`GET /2fa/info`, `POST /2fa/verify`, `POST /2fa/complete-verification`, `POST /2fa/method`).
- User must have at least one RBAC permission. Super admins receive all permissions through `getUserPermissions()`; do not fall back to legacy `user.role`.
- Code-owned permission/role reconciliation runs through `waitUntil()` after effective permissions resolve. Existing D1 grants remain fail-closed authority for ordinary admins; a missing or expired seed marker must never delay an authenticated response.
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
| `/auth/setup-2fa` | 2FA setup page. Optional for existing admins, required for invited admins until `mustEnrollTwoFactor` is cleared. Redirects if password setup is still required or 2FA is already enabled. |
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

1. `sendOtp()` -- validates identifier, normalizes phone to E.164, checks site settings/customer-auth policy, validates delivery transport before mutating challenge state, rate limits by trusted client IP through D1 `customer_auth_otp_rate_limits`, generates a 6-digit OTP, stores only opaque HMAC lookup material, a code HMAC, masks, and encrypted pinned sign-up contacts in `customer_auth_otp_challenges`, and returns queue payload with `deliveryKey` and `otpExpiresAt` for async delivery
2. `/send-otp` sends the payload to `AUTH_OTP_QUEUE`; if queue handoff fails, it deletes the exact D1 OTP challenge by `otpKey` + `deliveryKey` and returns retryable `503`
3. Queue delivery claims `auth_otp_delivery_receipts`, skips terminal/expired attempts, and records provider refs/status for email, SMS, or WhatsApp delivery
4. `verifyOtp()` -- normalizes identifier to E.164, atomically consumes correct D1 OTP challenges or increments wrong-code attempts, creates/finds customer in DB, creates a D1 session row with only the token HMAC, returns `CustomerSession` with the raw token for the `cs_tok` cookie plus the canonical customer profile projection
5. `getCustomerBySession()` -- hashes the cookie token, reads `customer_sessions`, joins the live `customers` row, rejects expired/revoked/deleted-customer sessions, and returns address/location/profile-completion fields for storefront hydration
6. `deleteCustomerSession()` -- revokes the D1 session row; scheduled maintenance deletes expired and old revoked rows
7. `updateCustomerProfile()` -- validates active delivery-location hierarchy, updates the customer DB record, clears the durable profile-required state only when name/address/city/zone are complete, and returns a fresh customer/session projection from D1

Phone numbers normalized to E.164 format via `libphonenumber-js`. New customer records are created only by explicit sign-up OTP verification and remain marked as needing profile completion until the delivery profile is saved.

## API Endpoints

### Auth Management (`/api/v1/admin/auth/`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/users` | List all admin users with roles and overrides |
| POST | `/users` | Create an invited admin user, assign the selected role, set `mustChangePassword` + `mustEnrollTwoFactor`, and send a one-use Better Auth password setup link. The generated bootstrap password is never returned or emailed. |
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

1. **2FA is optional for existing/manual admins, mandatory for invited admins**. Invited admins are blocked by `mustEnrollTwoFactor` until a verified 2FA method update clears the flag. When 2FA is enabled, the admin middleware redirects browser sessions to `/auth/two-factor`, and the API admin middleware rejects unverified sessions except exact 2FA info/verify/complete-verification/method endpoints.

2. **Permission invalidation is per user**: Cross-isolate RBAC invalidation deletes affected `rbac:perms:{userId}` KV entries with `clearPermissionCache(userId, kv)`. Role/permission mutation routes enumerate affected users and clear those keys.

3. **Route permission map has mixed path prefixes**: Some entries use `/api/products/*` (legacy prefix), others use `/api/v1/admin/categories/*` (current prefix). The API admin-auth middleware normalizes paths by prepending `/api/v1` if not present. Admin page access is handled separately through the TanStack Start guard and `@scalius/core/auth/rbac/page-permissions`.

4. **Fraud checker is NOT called during checkout or order processing**. It is a standalone admin-only tool for manual phone number lookups. No automated fraud screening exists in the order pipeline.

5. **Customer auth has no 2FA**. Storefront customers authenticate solely via single-factor OTP (email or phone).

6. **Admin user creation depends on password setup email delivery**. If setup email delivery fails, the API reports `emailFailed: true`; the account remains blocked by onboarding flags until the creating admin fixes email settings or the invitee uses the password reset flow.

7. **No session revocation on role changes**. When a user's roles or permissions are modified, their existing sessions remain valid. Effective permission checks should refresh after affected KV permission-cache entries are deleted, but sessions themselves are not revoked.

8. **Super admin is set by first-user heuristic**. `autoSeedRbacIfNeeded()` also checks on every isolate start whether the first `role=admin` user (by `createdAt`) is a super admin and sets them if not. This could promote an unintended user if the original super admin is deleted.
