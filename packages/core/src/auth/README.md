# Auth & RBAC System

Complete authentication and role-based access control for the Scalius Commerce admin dashboard. Two independent auth systems: Better Auth for admin users, OTP-based KV sessions for storefront customers.

## Architecture Overview

```
Admin Auth Flow:
  Browser --> Astro Middleware Pipeline --> Better Auth Session Check
                                            |
                                            v
                                      RBAC Permission Load
                                            |
                                            v
                                      Page/API Route Guard

API Worker Auth Flow (service bindings / external apps):
  Request --> Hono admin-auth middleware --> Better Auth Cookie OR JWT Bearer
                                             |
                                             v
                                       RBAC Permission Check via route-permissions.ts

Customer Auth Flow (storefront):
  Browser --> API /customer-auth/send-otp --> KV-stored OTP
  Browser --> API /customer-auth/verify   --> KV-stored session (cs_tok cookie)
```

## Files

### Core Auth

| File | Purpose |
|------|---------|
| `auth.ts` | `createAuth()` / `getAuth()` -- Better Auth factory with Drizzle adapter, email/password, 2FA (TOTP + email OTP), admin plugin. Cached per BETTER_AUTH_SECRET. |
| `index.ts` | Barrel re-export of `createAuth`, `getAuth`, and `Auth` type. |

### RBAC

| File | Purpose |
|------|---------|
| `rbac/types.ts` | TypeScript types: `PermissionName`, `UserPermissionContext`, `PermissionCheckResult`, `ProtectedRouteConfig`, `SystemRole`, `PermissionGroup`, `PermissionCategory`, `PermissionMetadata`, `RoleWithPermissions`, `UserPermissionOverride` |
| `rbac/permissions.ts` | `PERMISSIONS` constant (80 permissions across 14 categories), `PERMISSION_METADATA` record, helper functions (`getPermissionsByCategory`, `getAllPermissions`, `getAllPermissionNames`, `isSensitivePermission`) |
| `rbac/helpers.ts` | Core RBAC engine: `getUserPermissions()` (L1 Map + L2 KV + D1 batch query), `hasPermission()`, `hasAnyPermission()`, `hasAllPermissions()`, `checkPermissionDetailed()`, `getUserPermissionContext()`, `isSuperAdmin()`, `hasAdminAccess()`, role/permission CRUD (`assignRoleToUser`, `removeRoleFromUser`, `setUserPermissionOverride`, `removeUserPermissionOverride`, `getAllRolesWithPermissions`, `getRolePermissions`), `clearPermissionCache()`, `clearAllPermissionCache()` |
| `rbac/page-permissions.ts` | Maps admin page routes to required permissions. Static map for exact routes, regex array for dynamic routes (e.g., `/admin/products/[id]/edit`). `getPagePermission()` and `hasPageAccess()` functions. |
| `rbac/route-permissions.ts` | Maps API route patterns to required permissions per HTTP method. Glob-style wildcard matching. `getRoutePermission()` function. `ROUTE_PERMISSIONS` record. |
| `rbac/auto-seed.ts` | `autoSeedRbacIfNeeded()` -- seeds all 80 permissions and 5 system roles on first admin access. Sets first `role=admin` user as super admin. Runs once per isolate lifecycle (in-memory flag). |
| `rbac/api-protection.ts` | Higher-order functions for wrapping API route handlers: `withPermission()`, `withAnyPermission()`, `withAllPermissions()`, `withSuperAdmin()`. Also `checkPermissionForApi()`, `checkAnyPermissionForApi()`, `checkAllPermissionsForApi()` helpers, and `unauthorizedResponse()` / `forbiddenResponse()` factory functions. These are Astro-style wrappers; the Hono API uses middleware instead. |
| `rbac/index.ts` | Barrel re-export of all RBAC modules. |

### Database Schema

| File | Tables |
|------|--------|
| `packages/database/src/schema/auth.ts` | `user`, `session`, `account`, `verification`, `twoFactor` |
| `packages/database/src/schema/rbac.ts` | `permissions`, `roles`, `rolePermissions`, `userRoles`, `userPermissions` |

## Better Auth Configuration

- **Provider**: Email/password only (no OAuth)
- **Min password length**: 12 characters (enforced consistently: Better Auth config, API `changePasswordSchema`, admin frontend `ChangePasswordForm`, and `SetupForm`)
- **Email verification**: Disabled (`requireEmailVerification: false`)
- **Session TTL**: 7 days, updated daily, cookie cache 5 minutes
- **Rate limiting**: 5 sign-in attempts/min, 3 password resets/5min, 5 2FA attempts/min, session checks unlimited
- **IP detection**: `cf-connecting-ip` then `x-forwarded-for`, IPv6 /64 subnet grouping
- **Trusted origins**: `BETTER_AUTH_URL` + `STOREFRONT_URL`
- **Email callbacks**: `sendVerificationEmail`, `sendResetPassword`, and 2FA `sendOTP` all dynamically import `sendEmail` from `../integrations/email` to avoid circular dependencies. All templates use `escapeHtml()` from `@scalius/shared/html-escape`.

### Plugins

1. **twoFactor**: TOTP (6 digits, 30s period) + email OTP (5 min expiry) + 10 backup codes (10 chars each)
2. **admin**: `defaultRole: "user"`, `adminRoles: ["admin"]`

### Auth Client (admin frontend)

`apps/admin/src/lib/auth-client.ts` -- `createAuthClient()` with `twoFactorClient` (redirects to `/auth/two-factor`) and `adminClient` plugins. Exports `signIn`, `signUp`, `signOut`, `useSession`, `getSession`, `twoFactor`, `admin`.

## RBAC System

### Permission Resolution Order

1. Super admin (`user.isSuperAdmin = true`) -- gets ALL permissions unconditionally
2. User-level overrides (grant or deny from `user_permissions` table)
3. Role-based permissions (union of all assigned roles via `user_roles` + `role_permissions`)

### 80 Permissions Across 14 Categories

| Category | Count | Sensitive |
|----------|-------|-----------|
| Products | 7 | `permanent_delete` only |
| Categories | 6 | `permanent_delete` only |
| Collections | 6 | No |
| Orders | 7 | No |
| Customers | 6 | No |
| Discounts | 5 | All 5 |
| Pages | 5 | No |
| Widgets | 5 | No |
| Media | 4 | No |
| Attributes | 4 | No |
| Analytics | 4 | No |
| Settings | 16 | `general.*`, `delivery_providers.*`, `fraud_checker.*` |
| Team | 3 | `manage`, `manage_roles` |
| Dashboard | 2 | No |

### 5 System Roles (auto-seeded)

| Role | Permissions | Notes |
|------|-------------|-------|
| `super_admin` | All 80 | System role, cannot modify permissions |
| `manager` | All except `permanent_delete`, `delivery_providers.edit`, `fraud_checker.edit`, `team.manage_roles` | System role |
| `sales_rep` | Dashboard, products/categories/collections (view), orders (full CRUD + shipments), customers (view/create/edit/history), discounts (view) | System role |
| `content_editor` | Dashboard, pages/widgets (full CRUD), media (full), collections (view/edit/toggle), settings (header/footer/seo) | System role |
| `product_specialist` | Dashboard, products (full except permanent_delete), categories (full except permanent_delete), collections (full), attributes (full), media (view/upload) | System role |

### Permission Caching

- **L1**: In-memory `Map<userId, {permissions, timestamp}>` per Worker isolate, 5-minute TTL
- **L2**: Cloudflare KV (`rbac:perms:{userId}`), 5-minute TTL
- **D1 batch query**: All 3 queries (user lookup, role permissions, user overrides) run in a single `db.batch()` call
- **Cache invalidation**: `clearPermissionCache(userId, kv)` deletes both L1 and L2. `clearAllPermissionCache()` clears local Map only (no KV prefix deletion).
- **Weakness**: `clearAllPermissionCache()` only clears the current isolate's Map. Other isolates retain stale L1 caches until TTL expiry.

## Admin Middleware Pipeline

Execution order: `auth` -> `admin-detection` -> `rbac` -> `csp` -> `cache-invalidation`

### 1. Auth Middleware (`middleware/auth.ts`)

- Detects Cloudflare environment, initializes DB/KV/Storage bindings
- Stores request headers for SSR loader cookie forwarding
- Extracts Better Auth session for non-API routes
- Populates `context.locals.session`, `context.locals.user`, `context.locals._env`

### 2. Admin Detection Middleware (`middleware/admin-detection.ts`)

- `/auth/login`: Redirects to `/auth/setup` if no admin users exist. Redirects to `/admin` if already authenticated (with 2FA check).
- `/admin/*`: Redirects to `/auth/setup` if no admin users exist. Redirects to `/auth/login` if unauthenticated. Redirects to `/auth/two-factor` if 2FA enabled but session not verified.
- Caches "hasAdminUsers" in memory + KV permanently once true.

### 3. RBAC Middleware (`middleware/rbac.ts`)

- Calls `autoSeedRbacIfNeeded()` on every request (guarded by in-memory flag)
- Loads user permissions via `getUserPermissions()` into `context.locals.permissions`
- Checks `isSuperAdmin()` into `context.locals._isSuperAdmin`
- **API route protection**: Validates auth for protected API patterns, then checks fine-grained route permissions via `getRoutePermission()`
- **Page-level protection**: Checks `hasPageAccess()` for `/admin/*` routes. Redirects to `/admin/access-denied` on failure. Exceptions: `/admin/access-denied` and `/admin/settings/account` are always accessible.

## API Worker Auth (Hono)

### Admin Auth Middleware (`apps/api/src/middleware/admin-auth.ts`)

Dual authentication strategy:
1. **Better Auth session cookie** -- tries first (for dashboard frontend requests via service binding)
2. **JWT Bearer token** -- fallback (for external/mobile apps)

Then validates:
- User must have admin role OR super admin OR any RBAC permissions
- Fine-grained route permission check via `getRoutePermission()`
- Super admins bypass all permission checks

### JWT Auth Middleware (`apps/api/src/middleware/auth.ts`)

Simpler JWT-only middleware for non-admin routes (`/auth/token`, `/auth/me`, etc.). Skips health, docs, and token endpoints.

### Service-to-Service Token (`apps/api/src/routes/auth.ts`)

`GET /auth/token` -- exchanges `X-API-Token` header for a JWT with `role: "system"`. Uses constant-time comparison. The token grants system-level access.

## Auth Pages (Admin Frontend)

| Page | Purpose |
|------|---------|
| `/auth/login` | Sign-in form. Redirects to setup if no admins exist, to admin if already logged in. |
| `/auth/setup` | First admin user creation. Blocked if any admin already exists. Rate-limited (5/hour/IP via KV). Seeds RBAC. |
| `/auth/two-factor` | 2FA verification form. Shows if session exists but `twoFactorVerified` is false. |
| `/auth/setup-2fa` | Mandatory 2FA setup page (for new accounts). Redirects if 2FA already enabled. |
| `/auth/forgot-password` | Password reset request form. |
| `/auth/reset-password` | Password reset confirmation with token. |
| `/auth/index` | Redirects to `/auth/login`. |
| `/admin/access-denied` | Shown when RBAC denies page access. Link back to dashboard. |

## Customer Auth (Storefront)

Completely separate from Better Auth. OTP-based, sessionless JWT-free design using KV.

| Constant | Value |
|----------|-------|
| Cookie name | `cs_tok` |
| Session TTL | 30 days |
| OTP TTL | 5 minutes |
| OTP resend cooldown | 2 minutes |
| Max OTP attempts | 5 per code |
| IP rate limit | 5 requests/10min |

### Flow

1. `sendOtp()` -- validates identifier, normalizes phone to E.164, checks site settings for allowed method (email/phone/both), rate limits by IP, generates 6-digit OTP, stores in KV, returns queue payload for async delivery
2. `verifyOtp()` -- normalizes identifier to E.164, validates OTP, creates/finds customer in DB, creates KV session, returns `CustomerSession` with `cs_tok` cookie
3. `getCustomerBySession()` -- retrieves session from KV by token
4. `deleteCustomerSession()` -- logout
5. `updateCustomerProfile()` -- updates customer DB record and refreshes KV session

Phone numbers normalized to E.164 format via `libphonenumber-js`. New customer records auto-created on first successful OTP verification.

## API Endpoints

### Auth Management (`/api/v1/admin/auth/`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/users` | List all admin users with roles and overrides |
| POST | `/users` | Create admin user (generates temp password, sends invite email, assigns role) |
| DELETE | `/users/{id}` | Delete admin user (prevents last admin deletion) |
| POST | `/change-password` | Change current user password (12-char minimum) |
| POST | `/update-profile` | Update name and avatar |
| GET | `/2fa/info` | Get current user 2FA status |
| POST | `/2fa/mark-verified` | Mark session as 2FA verified |
| POST | `/2fa/method` | Switch between TOTP and email OTP |
| POST | `/2fa/verify` | Verify TOTP or backup code |
| GET | `/account-security` | Get 2FA method and super admin status |

### Setup (`/api/v1/admin/setup/`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Check if any admin user exists |
| POST | `/` | Create first admin (sets as super admin, seeds RBAC) |

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

1. **2FA is NOT enforced as mandatory**. The `/auth/setup-2fa` page exists and the `TwoFactorSetup` component shows "2FA Required" messaging, but no middleware redirects users there. Users without 2FA can access the admin dashboard freely. The admin-detection middleware only redirects to `/auth/two-factor` if 2FA IS enabled but NOT yet verified for the current session.

2. **`clearAllPermissionCache()` is local only**: When roles/permissions are modified via the RBAC API, `clearAllPermissionCache()` clears only the current Worker isolate's in-memory Map. Other isolates serve stale permissions for up to 5 minutes (KV TTL). No KV prefix-scan deletion exists.

3. **Route permission map has mixed path prefixes**: Some entries use `/api/products/*` (legacy prefix), others use `/api/v1/admin/categories/*` (current prefix). The admin-auth middleware normalizes paths by prepending `/api/v1` if not present, but the rbac middleware in Astro uses paths as-is.

4. **Fraud checker is NOT called during checkout or order processing**. It is a standalone admin-only tool for manual phone number lookups. No automated fraud screening exists in the order pipeline.

5. **Customer auth has no 2FA**. Storefront customers authenticate solely via single-factor OTP (email or phone).

6. **Admin user creation sends temp password by email**. If email delivery fails, the temp password is logged to console as a fallback -- a security concern in production.

7. **No session revocation on role changes**. When a user's roles or permissions are modified, their existing sessions remain valid with stale permissions until the cache TTL expires (5 min). Active sessions are not invalidated.

8. **Super admin is set by first-user heuristic**. `autoSeedRbacIfNeeded()` also checks on every isolate start whether the first `role=admin` user (by `createdAt`) is a super admin and sets them if not. This could promote an unintended user if the original super admin is deleted.
