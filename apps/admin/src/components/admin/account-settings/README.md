# Account Settings Components

Admin account management UI: profile editing, password change, 2FA setup, team management, and roles management. Mounted at `/admin/settings/account`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export for `AccountSettings` |
| `AccountSettingsContainer.tsx` | Main container with tabbed UI: Security, Password, Team, Roles (conditional on `team.manage_roles` permission) |
| `ProfileHeader.tsx` | User avatar (via MediaManager) + name editing + profile save. Calls `POST /api/v1/admin/auth/update-profile`. |
| `ChangePasswordForm.tsx` | Current/new/confirm password form with strength meter. Calls `POST /api/v1/admin/auth/change-password`. Enforces 12-char minimum client-side. |
| `TwoFactorSetup.tsx` | Full 2FA lifecycle: enable (TOTP or email), verify, backup codes, change method, disable. Uses `authClient.twoFactor.*` + custom API endpoints. QR codes generated locally via `qrcode` library (no external API calls). |
| `AdminUsersManager.tsx` | Team member list with add/delete. Shows 2FA status badges, role badges, super admin badge. Permissions button opens `UserPermissionEditor`. |
| `hooks/useAdminUsers.ts` | Data hook: fetches admin users (`GET /api/v1/admin/auth/users`) and roles (`GET /api/v1/admin/rbac/roles`), provides `addUser`/`deleteUser` actions. Uses `unwrapEnvelope()` and `extractApiError()` from `@/lib/api-helpers`. |

## Related Components (outside this directory)

| Component | Location |
|-----------|----------|
| `RolesManagement` | `../RolesManagement.tsx` -- Roles CRUD with permission accordion |
| `UserPermissionEditor` | `../UserPermissionEditor.tsx` -- Per-user role/permission editor dialog |
| `PermissionGate` | `../PermissionGate.tsx` -- Conditional rendering by permission |

## Permission Context

`apps/admin/src/contexts/PermissionContext.tsx` provides permission state to all admin React components.

### Data Flow

1. Astro middleware loads permissions from DB into `context.locals.permissions` and `context.locals._isSuperAdmin`
2. Admin layout injects these into the page as `window.__USER_PERMISSIONS__` and `window.__IS_SUPER_ADMIN__`
3. `PermissionProvider` reads from props or window globals
4. Components use `usePermissions()` hook or `<PermissionGate>` component

Super admin always returns `true` for all permission checks.

## 2FA Flow Details

### Enable Flow

1. User selects method (TOTP authenticator app or email OTP)
2. User confirms with current password
3. `authClient.twoFactor.enable({ password })` -- returns `totpURI` + backup codes
4. For TOTP: shows QR code generated locally via `qrcode` library (`QRCode.toDataURL()`), user scans and enters 6-digit code
5. For email: `authClient.twoFactor.sendOtp()`, user enters emailed code
6. Verification: `authClient.twoFactor.verifyTotp({ code })` or `authClient.twoFactor.verifyOtp({ code })`
7. On success: calls `POST /api/v1/admin/auth/2fa/method` to save method preference, then `POST /api/v1/admin/auth/2fa/mark-verified` to mark session
8. Shows backup codes (copy to clipboard)

### Change Method Flow

- TOTP to email: calls method endpoint directly, no verification needed
- Email to TOTP: re-runs enable flow with password confirmation, QR scan, and code verification

### Disable Flow

1. User confirms with password
2. `authClient.twoFactor.disable({ password })`
3. 2FA removed from account

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
| `GET /api/v1/admin/rbac/roles` | useAdminUsers |

## Known Gaps

1. **2FA is not enforced as mandatory.** The UI shows "2FA Required" text and an amber warning when disabled, but no middleware prevents admin access without 2FA.

2. **No password change confirmation email.** When a user changes their password, no notification email is sent. The `revokeOtherSessions: true` flag is set though, which invalidates other active sessions.

3. **Admin invite fallback logs password.** If email delivery fails when creating a new admin user, the temp password is logged to `console.log`. This is a security risk in production.
