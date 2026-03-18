# Account Settings Components

Admin account management UI: profile editing, password change, 2FA setup, team management, and roles management. Mounted at `/admin/settings/account`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export for `AccountSettings` |
| `AccountSettingsContainer.tsx` | Main container with tabbed UI: Security, Password, Team, Roles (conditional on `team.manage_roles` permission) |
| `ProfileHeader.tsx` | User avatar (via MediaManager) + name editing + profile save. Calls `POST /api/v1/admin/auth/update-profile`. |
| `ChangePasswordForm.tsx` | Current/new/confirm password form with strength meter. Calls `POST /api/v1/admin/auth/change-password`. Enforces 12-char minimum client-side. |
| `TwoFactorSetup.tsx` | Full 2FA lifecycle: enable (TOTP or email), verify, backup codes, change method, disable. Uses `authClient.twoFactor.*` + custom API endpoints. |
| `AdminUsersManager.tsx` | Team member list with add/delete. Shows 2FA status badges, role badges, super admin badge. Permissions button opens `UserPermissionEditor`. |
| `hooks/useAdminUsers.ts` | Data hook: fetches admin users (`GET /api/v1/admin/auth/users`) and roles (`GET /api/v1/admin/rbac/roles`), provides `addUser`/`deleteUser` actions. |

## Related Components (outside this directory)

| File | Purpose |
|------|---------|
| `../RolesManagement.tsx` | Roles CRUD: create/edit/delete roles, permission accordion with category grouping, select-all per category. System roles have immutable permissions. |
| `../UserPermissionEditor.tsx` | Per-user permission editor dialog: assign/remove roles, set permission overrides (inherit/force grant/force deny) per permission. Shows effective permission status. |
| `../PermissionGate.tsx` | Conditional rendering component: `<PermissionGate permission="products.create">`. Supports `permission`, `anyOf`, `allOf`, `fallback`, `invert`. Also exports `withPermission()` HOC. |
| `../FraudCheckerSettings.tsx` | Fraud checker provider CRUD UI. Uses `window.fraudCheckerActions` bridge. |
| `../SecuritySettingsBuilder.tsx` | CSP/CORS allowed domains config. Calls `GET/POST /api/v1/admin/settings/security`. |

## Permission Context

`apps/admin/src/contexts/PermissionContext.tsx` provides permission state to all admin React components.

### Data Flow

1. Astro middleware loads permissions from DB into `context.locals.permissions` and `context.locals._isSuperAdmin`
2. Admin layout injects these into the page as `window.__USER_PERMISSIONS__` and `window.__IS_SUPER_ADMIN__`
3. `PermissionProvider` reads from props or window globals
4. Components use `usePermissions()` hook or `<PermissionGate>` component

### Hooks

| Hook | Purpose |
|------|---------|
| `usePermissions()` | Returns `{ permissions, isSuperAdmin, hasPermission, hasAnyPermission, hasAllPermissions }`. Falls back to window globals if no provider context. |
| `useHasPermission(perm)` | Boolean shorthand for single permission check |
| `useHasAnyPermission(perms)` | Boolean shorthand for any-of check |
| `useWindowPermissions()` | Direct window global reader (for components outside provider) |

Super admin always returns `true` for all permission checks.

## 2FA Flow Details

### Enable Flow

1. User selects method (TOTP authenticator app or email OTP)
2. User confirms with current password
3. `authClient.twoFactor.enable({ password })` -- returns `totpURI` + backup codes
4. For TOTP: shows QR code (via external `api.qrserver.com`), user scans and enters 6-digit code
5. For email: `authClient.twoFactor.sendOtp()`, user enters emailed code
6. Verification: `authClient.twoFactor.verifyTotp({ code })` or `authClient.twoFactor.verifyOtp({ code })`
7. On success: calls `POST /api/v1/admin/auth/2fa/method` to save method preference, then `POST /api/v1/admin/auth/2fa/mark-verified` to mark session
8. Shows backup codes (10 codes, copy to clipboard)

### Change Method Flow

- TOTP to email: calls method endpoint directly, no verification needed
- Email to TOTP: re-runs enable flow with password confirmation, QR scan, and code verification

### Disable Flow

1. User confirms with password
2. `authClient.twoFactor.disable({ password })`
3. 2FA removed from account

### Login 2FA Verification

When a user with 2FA enabled logs in, Better Auth's `twoFactorClient` redirects to `/auth/two-factor`. The `TwoFactorForm` component (at `apps/admin/src/components/auth/TwoFactorForm.tsx`) handles TOTP code entry, email OTP with resend, and backup code verification.

## API Endpoints Used

| Endpoint | Consumer |
|----------|----------|
| `POST /api/v1/admin/auth/update-profile` | ProfileHeader |
| `POST /api/v1/admin/auth/change-password` | ChangePasswordForm |
| `POST /api/v1/admin/auth/2fa/method` | TwoFactorSetup |
| `POST /api/v1/admin/auth/2fa/mark-verified` | TwoFactorSetup |
| `GET /api/v1/admin/auth/users` | useAdminUsers |
| `POST /api/v1/admin/auth/users` | useAdminUsers (addUser) |
| `DELETE /api/v1/admin/auth/users/{id}` | useAdminUsers (deleteUser) |
| `GET /api/v1/admin/rbac/roles` | useAdminUsers, RolesManagement, UserPermissionEditor |
| `GET /api/v1/admin/rbac/permissions` | RolesManagement, UserPermissionEditor |
| `POST /api/v1/admin/rbac/roles` | RolesManagement |
| `PUT /api/v1/admin/rbac/roles/{id}` | RolesManagement |
| `DELETE /api/v1/admin/rbac/roles/{id}` | RolesManagement |
| `POST /api/v1/admin/rbac/user-roles` | UserPermissionEditor |
| `DELETE /api/v1/admin/rbac/user-roles` | UserPermissionEditor |
| `POST /api/v1/admin/rbac/user-permissions` | UserPermissionEditor |
| `DELETE /api/v1/admin/rbac/user-permissions` | UserPermissionEditor |

## Known Gaps

1. **2FA is not enforced as mandatory.** The `TwoFactorSetup` component shows "2FA Required" UI text and an amber warning when disabled, but no middleware prevents admin access without 2FA. The `/auth/setup-2fa` page exists but is never redirected to by middleware. Users can dismiss the warning and use the admin dashboard with only a password.

2. **QR code generation uses external service.** TOTP QR codes are generated via `https://api.qrserver.com/v1/create-qr-code/`. This leaks the TOTP secret URI to a third-party service. Should use a client-side QR library instead.

3. **Response envelope handling inconsistency.** `useAdminUsers` manually unwraps `json.data` with a heuristic (`json.data && typeof json.data === "object" && !Array.isArray(json.data)`). `RolesManagement` accesses `data.roles` directly without unwrapping in some cases and with unwrapping in others. This is fragile -- depends on whether the request goes through the admin proxy (which unwraps) or the Vite dev proxy (which does not).

4. **No password change confirmation email.** When a user changes their password, no notification email is sent. The `revokeOtherSessions: true` flag is set though, which invalidates other active sessions.

5. **Admin invite fallback logs password.** If email delivery fails when creating a new admin user, the temp password is logged to `console.log` with the message `IMPORTANT: Temp password for {email}: {password}`. This is a security risk in production.

6. **Delete protection is role-check only.** The delete endpoint checks `userToDelete.role !== "admin"` but does not prevent deleting super admins specifically. The UI hides the delete button for super admins, but the API does not enforce it.
