# Stale Or Superseded Claims

This file prevents future audit agents from repeating old findings without re-checking current code.

## Do Not Repeat Without Fresh Evidence

### "API RBAC falls back open for unmapped admin routes"

Current evidence indicates the API fails closed when an admin route lacks a mapped permission. `apps/api/src/middleware/admin-auth.ts` logs the missing mapping and throws a forbidden error. There is also a test covering an unmapped route.

Current related issue: admin UI route guarding can still disagree with API RBAC for `role: "admin"` users without RBAC roles.

### "Scanner raw QR token can be used directly as bearer auth"

Current evidence indicates raw QR-token use has been narrowed. Scanner tokens are exchanged into a scanner session cookie, and scanner sessions are limited to exact allowlisted API endpoints.

Current related issue: scanner token minting appears to require only an authenticated admin session, not inventory/stock RBAC.

### "D1 migrations are definitely drifted"

Current `drizzle-kit check` passes. Treat this as a generation and metadata risk, not a confirmed runtime schema mismatch, unless a fresh replay/generation check proves otherwise.

Current related issue: migration journal and snapshot metadata appear incomplete for later migrations, so future `db:generate` behavior should be verified.

### "Widget sanitizer homepage bypass is confirmed"

This pass did not re-confirm the old sanitizer claim. Current widget services appear to sanitize active widget content in core service paths.

Current related issue: the root test suite fails an admin widget-generation parser test where local-safe script tags are not extracted from HTML before preview.

### "Root tests pass with 9 files and 143 tests"

This is stale. The latest root test run reported 93 files and 559 tests passing.

### "pnpm dev starts only admin + API"

This is stale. Root `pnpm dev` starts API, admin, and storefront through `scripts/dev.sh`. `pnpm dev:admin` starts admin + API, and `pnpm dev:storefront` starts storefront + API.

## Still Valid But Needs Narrow Wording

### "Local dev is hard to run"

Valid, but be specific and re-check current helpers first. Service-binding-vs-HTTP fallback verification, external provider dependencies, queues, Cache API behavior, and secrets/sandbox requirements remain the likely hard parts. The old all-`workerd` cleanup behavior is now opt-in, and wrapper commands now apply local migrations and wait for API readiness before dependent app startup.

### "Admin has type safety issues"

Valid, but narrow it. The former `api.functions.ts` file-level `@ts-nocheck` weakness was removed on 2026-06-13. Remaining admin type-safety work is now local to UI `any` usage, broad DTO adapters, and query/mutation wrapper ergonomics.

### "Generated docs drift"

Do not repeat without a fresh check. The API client and database READMEs were simplified on 2026-06-13 to avoid volatile generated counts and to correct the known runtime dependency/migration/table drift.
