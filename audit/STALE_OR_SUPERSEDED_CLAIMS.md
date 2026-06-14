# Stale Or Superseded Claims

This file prevents future audit agents from repeating old findings without re-checking current code.

## Do Not Repeat Without Fresh Evidence

### "API RBAC falls back open for unmapped admin routes"

Current evidence indicates the API fails closed when an admin route lacks a mapped permission. `apps/api/src/middleware/admin-auth.ts` logs the missing mapping and throws a forbidden error. There is also a test covering an unmapped route.

Current related issue: none currently tracked; re-check RBAC behavior before reopening.

### "Scanner raw QR token can be used directly as bearer auth"

Current evidence indicates raw QR-token use has been narrowed. Scanner tokens are exchanged into a scanner session cookie, and scanner sessions are limited to exact allowlisted API endpoints.

Current related issue: none currently tracked; scanner token minting now has focused RBAC coverage.

### "API /auth routes are Better Auth endpoints"

Current evidence indicates `/api/v1/auth/*` is the API worker's service-token/Firebase/token-management router. Better Auth is served by the admin worker's `/api/auth/*` routes and shared auth configuration.

Current related issue: none currently tracked; re-check `apps/api/src/routes/auth.ts` and `apps/admin-v2/src/routes/api/auth/$.ts` before reopening.

### "Admin 2FA is mandatory for all admins"

Current evidence indicates 2FA setup remains optional, but enabled 2FA is enforced per session in both the TanStack admin route guard and API admin middleware. The API gate currently exempts only exact 2FA info, verify, complete-verification, and method-completion endpoints needed to finish the second-factor flow.

Current related issue: none currently tracked; re-check `apps/api/src/middleware/admin-auth.ts` and `apps/admin-v2/src/lib/auth.fns.ts` before reopening.

### "Admin invite email failure exposes or logs the temporary password"

Current evidence indicates invite-email failure now returns `emailFailed: true` and instructs admins to use password reset or fix email settings. The API does not return the temporary password on failure.

Current related issue: none currently tracked; re-check `apps/api/src/routes/admin/auth-management.ts` before reopening.

### "D1 migrations are definitely drifted"

Current `drizzle-kit check` passes. Treat this as a generation and metadata risk, not a confirmed runtime schema mismatch, unless a fresh replay/generation check proves otherwise.

Current related issue: migration metadata is guarded by `pnpm --filter @scalius/database check:migrations`; update the explicit snapshot-gap allowlist only for intentional manual SQL migrations.

### "Widget sanitizer homepage bypass is confirmed"

This pass did not re-confirm the old sanitizer claim. Current widget services appear to sanitize active widget content in core service paths.

Current related issue: none currently tracked; root tests pass.

### "Root tests pass with 9 files and 143 tests"

This is stale. Do not quote old suite counts from historical audits; run `pnpm test` for the current file/test count when the count matters.

### "pnpm dev starts only admin + API"

This is stale. Root `pnpm dev` starts API, admin, and storefront through `scripts/dev.sh`. `pnpm dev:admin` starts admin + API, and `pnpm dev:storefront` starts storefront + API.

### "Use `pnpm dev:setup --force` for ordinary env repair"

This is stale. Use `pnpm dev:setup --env-only` for missing or blank local env keys. Reserve `pnpm dev:setup --force --env-only` for regenerating local env files or repairing shared-secret drift without touching migrations/admin data.

## Still Valid But Needs Narrow Wording

### "Local dev is hard to run"

Valid, but be specific and re-check current helpers first. Service-binding-vs-HTTP fallback verification, external provider dependencies, queues, Cache API behavior, and secrets/sandbox requirements remain the likely hard parts. The old all-`workerd` cleanup behavior is now opt-in, and wrapper commands now apply local migrations and wait for API readiness before dependent app startup.

### "Admin has type safety issues"

Valid, but narrow it. The former `api.functions.ts` file-level `@ts-nocheck` weakness was removed on 2026-06-13. Remaining admin type-safety work is now local to UI `any` usage, broad DTO adapters, and query/mutation wrapper ergonomics.

### "Generated docs drift"

Do not repeat without a fresh check. The API client and database READMEs were simplified on 2026-06-13 to avoid volatile generated counts and to correct the known runtime dependency/migration/table drift.
