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

This is stale. The latest root test run reported 62 files and 448 tests, with one failing test.

### "pnpm dev starts only admin + API"

This is stale. Root `pnpm dev` starts API, admin, and storefront through `scripts/dev.sh`. `pnpm dev:admin` starts admin + API, and `pnpm dev:storefront` starts storefront + API.

## Still Valid But Needs Narrow Wording

### "Local dev is hard to run"

Valid, but be specific. The problems are service-binding-vs-HTTP fallback verification, startup race in filtered dev commands, all-`workerd` cleanup, external provider dependencies, queues, Cache API behavior, and secrets/sandbox requirements.

### "Admin has type safety issues"

Valid, but narrow it. The central known weakness is `apps/admin-v2/src/lib/api.functions.ts` with file-level `@ts-nocheck`, plus large wrapper/query/mutation files and loose identity validators.

### "Generated docs drift"

Valid. API client and database READMEs contain volatile stale counts. Trust generated artifacts and source files over prose until docs are automated or simplified.
