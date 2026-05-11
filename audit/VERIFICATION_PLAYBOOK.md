# Scalius Commerce Verification Playbook

Date started: 2026-04-22

This file is the repeatable testing guide for the remediation campaign.

## Local First Rule

Every fix should be tested locally before any deploy:

1. targeted test or typecheck
2. API-level manual verification if needed
3. browser flow verification with Computer Use for admin/storefront behavior
4. only then remote/deployed validation when the flow truly depends on external providers

## Local Run Checklist

### Before starting

- confirm branch/worktree state with `git status --short`
- verify dependencies: `node -v`, `pnpm -v`
- if local state seems broken, use:
  - `pnpm dev:setup`
  - `pnpm dev:reset`

### Primary boot

- run `pnpm dev`
- verify expected local URLs:
  - admin: `http://localhost:4323/admin`
  - storefront: `http://localhost:4322`
  - API docs: `http://localhost:8787/api/v1/docs`

### Baseline smoke after boot

- admin login page loads
- storefront home loads
- product page loads
- cart page loads
- API docs/OpenAPI load

## Computer Use Flows

Use Computer Use after the relevant fix batch. Minimum recurring flows:

### Admin flows

1. login flow
2. 2FA flow if the affected change touches auth
3. dashboard shell load
4. one CRUD flow for the affected module
5. one settings save flow if settings-related code changed
6. scanner flow if scanner/security/inventory paths changed

### Storefront flows

1. homepage render
2. product detail
3. add to cart
4. cart totals and discount flow
5. checkout progression
6. account login/session flow when auth/session code changes
7. order-success flow when order/checkout/privacy code changes

## Mandatory Verification By Fix Area

### Auth / RBAC / security

- test session and token flows locally
- verify unauthorized access is blocked at API layer, not just UI layer
- verify admin UI still works for intended roles
- verify customer auth cookies are set/cleared correctly in browser

### Orders / inventory / payments

- run targeted Vitest slice
- exercise at least one real create/update/status path locally
- confirm no double-submit or stale-state behavior in browser
- if payment gateway behavior is remote-only, locally verify pre-gateway state first

### Database / migrations

- run DB typecheck
- run Drizzle migration integrity checks
- if schema changes are made, replay/apply locally and verify the actual DB shape, not just TS types

### Storefront / caching / content

- verify cache invalidation behavior manually after mutation
- test fresh page load plus second load
- verify no stale home/layout/page/category artifacts remain after change

### Admin shell / workflows

- verify route enter, deep-link behavior, and failed-permission behavior
- verify pages do not merely hide nav items while still loading unauthorized content

## Deploy-Then-Verify Cases

Use remote deployment for:

- Stripe / SSLCommerz / Polar live callback loops
- third-party webhook sources that require public URLs
- cookie/domain behavior that depends on real deployed domains

When doing this:

1. deploy with `pnpm run deploy`
2. verify login using:
   - email: `ahmedrifatkonok@gmail.com`
   - password: `RemoteAdminX2026!`
3. test only the remote-only scenarios
4. capture any new findings back into `audit/REMEDIATION_TRACKER.md`

## Documentation Discipline

When a fix batch ends, record:

- what was fixed
- how it was verified
- what still remains risky or blocked

This is mandatory so future turns and compaction do not lose the thread.
